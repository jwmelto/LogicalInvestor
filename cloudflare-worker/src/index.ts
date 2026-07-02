import { XMLParser } from 'fast-xml-parser';
import { FeedKeys, stripHtml, stripReplyPrefix, formatTitle, classifySignal, MAX_SEEN_IDS_PER_FEED, type FeedKey, type NotifLevel, type ActionableResult } from '@li/core';

export interface Env {
  TOKENS: KVNamespace;
  STATE: KVNamespace;
  FEED_TOKEN: string;              // secret for GET /status (Authorization: Bearer)
  AUTHOR_FILTER: string;           // wrangler.toml [vars], default "Sean Hyman"
  MIN_CONTENT_LENGTH: string;      // wrangler.toml [vars], default "200"
  POLL_INTERVAL_TRADING?: string;   // minutes between polls during trading hours, default "5"
  POLL_INTERVAL_LATEDAY?: string;   // minutes between polls during late-day window, default "15"
  POLL_INTERVAL_OVERNIGHT?: string; // minutes between polls outside market hours, default "60"
  POLL_BOUNDARY_OPEN?: string;      // hhmm ET when trading hours begin, default "915"
  POLL_BOUNDARY_LATEDAY?: string;   // hhmm ET when late-day window begins, default "1400"
  POLL_BOUNDARY_CLOSE?: string;     // hhmm ET when late-day window ends, default "1615"
}

type Channel = 'members' | 'stock' | 'options';

interface RawItem {
  guid: string;
  title: string;
  author: string;
  description: string;
  link: string;
  feedKey: FeedKey;
}

interface TopicEntry {
  lastSeen: string;
  title: string;
  feedKey: FeedKey;
}

interface TokenMeta {
  level?: NotifLevel;
  feedToken?: string; // optional here only for KV entries predating universal storage; recovers a stale stock/options poll token
}

type AuthorResult = 'pass-author' | 'fail-author';
type ForumResult  = 'bypass'     // membersArea: skip all other filters
                  | 'pass-star'  // stock/options with * title prefix
                  | 'fail-no-star' // stock/options without * prefix
                  | 'pass-forum';  // membersForum: no topic gate, proceed to actionable

interface ItemClassification {
  author:     AuthorResult;
  forum:      ForumResult;
  actionable: ActionableResult;
}

type ByLevel = Partial<Record<NotifLevel, Partial<Record<string, number>>>>;

interface RunStats {
  lastRun: string;
  lastNotified: string | null;
  itemsFetched: number;
  newItems: number;
  byLevel: ByLevel;
  author:     Partial<Record<AuthorResult, number>>;
  forum:      Partial<Record<ForumResult, number>>;
  actionable: Partial<Record<ActionableResult, number>>;
  sent: number;
}

interface DailyStats {
  date: string;
  runs: number;
  itemsFetched: number;
  newItems: number;
  byLevel: ByLevel;
  author:     Partial<Record<AuthorResult, number>>;
  forum:      Partial<Record<ForumResult, number>>;
  actionable: Partial<Record<ActionableResult, number>>;
  sent: number;
}

function mergeTally<K extends string>(dst: Partial<Record<K, number>>, src: Partial<Record<K, number>>): void {
  for (const [k, v] of Object.entries(src) as [K, number][]) {
    dst[k] = (dst[k] ?? 0) + v;
  }
}

function mergeByLevel(dst: ByLevel, src: ByLevel): void {
  for (const [level, feedCounts] of Object.entries(src) as [NotifLevel, Partial<Record<string, number>>][]) {
    const dstFeed = (dst[level] ??= {});
    for (const [feedKey, count] of Object.entries(feedCounts)) {
      // count is always a real number here — ByLevel entries only ever come from increments.
      dstFeed[feedKey] = (dstFeed[feedKey] ?? 0) + count!;
    }
  }
}

function classifyItem(item: RawItem, authorFilter: string, minLength: number): ItemClassification {
  const forum: ForumResult =
    item.feedKey === FeedKeys.membersArea ? 'bypass' :
    (item.feedKey === FeedKeys.stockInsights || item.feedKey === FeedKeys.optionsInsights)
      ? (stripReplyPrefix(item.title).startsWith('*') ? 'pass-star' : 'fail-no-star')
      : 'pass-forum';

  const author: AuthorResult = item.author.toLowerCase().includes(authorFilter) ? 'pass-author' : 'fail-author';
  const actionable: ActionableResult = classifySignal(stripHtml(item.description), minLength);

  return { author, forum, actionable };
}

function shouldNotify(level: NotifLevel, c: ItemClassification): boolean {
  if (level === 'none') return false;
  if (c.forum === 'bypass') return true;       // membersArea always notifies
  if (level === 'minimal') return false;
  if (c.author === 'fail-author') return false;
  if (level === 'all') return true;
  // standard: star topic gates eligibility, but every post still needs an actionable signal.
  if (c.forum === 'fail-no-star') return false;
  return c.actionable.startsWith('pass');
}

// Channel-to-cron mapping: CHANNELS[i] corresponds to the cron whose minute list starts at offset i.
// wrangler.toml MUST list the three crons in this exact order, with each starting one minute later:
//   members → "0,5,10,15,..."   (offset 0)
//   stock   → "1,6,11,16,..."   (offset 1)
//   options → "2,7,12,17,..."   (offset 2)
// Changing either this array OR the wrangler.toml cron order silently breaks the channel mapping.
// ponytail: brittle by design — simplest option available; revisit if a 4th channel is added.
const CHANNELS: Channel[] = ['members', 'stock', 'options'];

export function channelFromCron(cron: string): Channel {
  const offset = parseInt(cron.split(' ')[0].split(',')[0], 10);
  return CHANNELS[offset] ?? 'members';
}

// The 'members' Channel bundles two distinct feeds under one push-registration grouping.
// feedTokenHasAccess() below always checks index [0] of a channel's feed list, so order is
// deliberate here: Members Forum is first because its feed requires a valid feed_token to
// return any items, making it a real check of membership status (catches an expired or
// invalid token). Members Area's feed is readable regardless of token validity — only the
// content snippet is paywalled — so it would never catch anything if checked instead.
const CHANNEL_FEEDS: Record<Channel, { url: string; feedKey: FeedKey; discoverTopics: boolean }[]> = {
  members: [
    { url: 'https://logicalinvestor.net/forums/forum/members-forum/feed/',             feedKey: FeedKeys.membersForum,    discoverTopics: true  },
    { url: 'https://logicalinvestor.net/feed/',                                        feedKey: FeedKeys.membersArea,     discoverTopics: false },
  ],
  stock: [
    { url: 'https://logicalinvestor.net/forums/forum/stock-insights/feed/',            feedKey: FeedKeys.stockInsights,   discoverTopics: true  },
  ],
  options: [
    { url: 'https://logicalinvestor.net/forums/forum/options-insights/feed/',          feedKey: FeedKeys.optionsInsights, discoverTopics: false },
  ],
};

const TOPIC_GC_DAYS = 30;

// Module-level parser shared across all calls within an invocation
const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });

// Returns ET time components using the IANA timezone database (handles DST automatically,
// including any future rule changes by law).
// timeOfDay is minutes since midnight: e.g. 09:15 ET → 555, 14:00 ET → 840.
function getETComponents(now: Date): { day: number; timeOfDay: number; min: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const get = (type: string) => parseInt(parts.find(p => p.type === type)?.value ?? '0', 10);
  const weekdays: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const hours = get('hour');
  const min = get('minute');
  return { day: weekdays[parts.find(p => p.type === 'weekday')?.value ?? ''] ?? 0, timeOfDay: hours * 60 + min, min };
}

// Parses a wrangler.toml hhmm string (e.g. "0915") to minutes since midnight (e.g. 555).
function hhmmToMinutes(s: string): number {
  const n = parseInt(s, 10);
  return Math.floor(n / 100) * 60 + (n % 100);
}

// Returns the appropriate poll interval (minutes) for the current ET time.
// Boundary defaults (minutes since midnight ET):
//   open:    555  (09:15 ET, market open)
//   lateday: 840  (14:00 ET, reduced-activity window begins)
//   close:   975  (16:15 ET, after-hours begins)
export function getIntervalMinutes(
  now: Date,
  intervals  = { trading: 5, lateday: 15, overnight: 60 },
  boundaries = { open: 555, lateday: 840, close: 975 },
): number {
  const { day, timeOfDay } = getETComponents(now);
  if (day === 0 || day === 6) return intervals.overnight;
  if (timeOfDay >= boundaries.open    && timeOfDay < boundaries.lateday) return intervals.trading;
  if (timeOfDay >= boundaries.lateday && timeOfDay < boundaries.close)   return intervals.lateday;
  return intervals.overnight;
}

// Returns true if enough time has elapsed since lastRun for the given interval (minutes).
export function shouldPollNow(now: Date, lastRun: Date | null, interval: number): boolean {
  return (!lastRun) || (now.getTime() - lastRun.getTime() >= interval * 60_000);
}

function getETDate(now: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(now);
}

// Constant-time string comparison — a plain !== on secrets leaks timing information.
// Manual XOR accumulator that runs under the plain-Node runtime.
export function timingSafeEqualStr(a: string, b: string): boolean {
  const bufA = new TextEncoder().encode(a);
  const bufB = new TextEncoder().encode(b);
  if (bufA.byteLength !== bufB.byteLength) return false;
  let diff = 0;
  for (let i = 0; i < bufA.byteLength; i++) diff |= bufA[i] ^ bufB[i];
  return diff === 0;
}

export default {
  // HTTP API (called by the app's pushService.ts):
  //
  //   GET  /status       Authorization: Bearer <FEED_TOKEN>
  //   POST /register    { token, channel, level, feed_token }
  //   POST /unregister  { token, channel }
  //
  //   token      — Expo push token (device identifier for APNs/FCM delivery)
  //   channel    — 'members' | 'stock' | 'options'
  //   level      — 'minimal' | 'standard' | 'all'
  //   feed_token — WordPress auth token, required on every /register call regardless of
  //                channel. For stock/options it also proves access — rejected with 403
  //                if missing, invalid, or the account isn't subscribed to that channel.
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === 'GET' && url.pathname === '/status') {
      const auth = request.headers.get('Authorization') ?? '';
      const secret = auth.startsWith('Bearer ') ? auth.slice(7) : '';
      if (!timingSafeEqualStr(secret, env.FEED_TOKEN)) {
        return new Response('unauthorized', { status: 401 });
      }
      const result: Record<string, unknown> = {};
      for (const channel of CHANNELS) {
        const [tokens, seenJson, topicsJson, pollToken, statsJson] = await Promise.all([
          env.TOKENS.list({ prefix: `${channel}:` }),
          env.STATE.get(`seen:${channel}`),
          env.STATE.get(`topics:${channel}`),
          env.STATE.get(`poll:${channel}`),
          env.STATE.get(`stats:${channel}`),
        ]);
        const stats: RunStats | null = statsJson ? JSON.parse(statsJson) : null;
        result[channel] = {
          registeredTokens: tokens.keys.length,
          seenIds:   seenJson   ? (() => { const s = JSON.parse(seenJson); return Array.isArray(s) ? s.length : Object.values(s as Record<string, string[]>).reduce((a, b) => a + b.length, 0); })() : 0,
          topics:    topicsJson ? Object.keys(JSON.parse(topicsJson) as object).length : 0,
          pollToken: pollToken ? 'present' : 'missing',
          lastRun:      stats?.lastRun      ?? null,
          lastNotified: stats?.lastNotified ?? null,
          lastRunStats: stats ? {
            itemsFetched: stats.itemsFetched,
            newItems:     stats.newItems,
            author:       stats.author,
            forum:        stats.forum,
            actionable:   stats.actionable,
            sent:         stats.sent,
          } : null,
          todayStats: await env.STATE.get<DailyStats>(`daily:${channel}:${getETDate(new Date())}`, 'json'),
        };
      }
      return new Response(JSON.stringify(result, null, 2), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (request.method !== 'POST') return new Response('not found', { status: 404 });

    const body = await request.json() as Record<string, string>;
    const pushToken = body.token;
    const channel = body.channel as Channel | null;
    if (!pushToken) return new Response('missing token', { status: 400 });
    if (!channel || !['members', 'stock', 'options'].includes(channel)) {
      return new Response('invalid channel', { status: 400 });
    }

    const kvKey = `${channel}:${pushToken}`;

    if (url.pathname === '/register') {
      const level = body.level as NotifLevel;
      if (!VALID_LEVELS.includes(level)) {
        return new Response('missing or invalid level', { status: 400 });
      }
      const feedToken = body.feed_token;
      if (typeof feedToken !== 'string' || feedToken === '') {
        return new Response('missing or invalid feed_token', { status: 400 });
      }
      return registerDevice({ channel, pushToken, level, feedToken }, env);
    }
    if (url.pathname === '/unregister') {
      await env.TOKENS.delete(kvKey);
      return new Response('ok');
    }
    return new Response('not found', { status: 404 });
  },

  async scheduled(event: ScheduledEvent, env: Env, _ctx: ExecutionContext): Promise<void> {
    const channel = channelFromCron(event.cron);
    await runChannel(channel, env);
  },
};

export const VALID_LEVELS: NotifLevel[] = ['none', 'minimal', 'standard', 'all'];

export interface RegisterParams {
  channel: Channel;
  pushToken: string;
  level: NotifLevel;
  feedToken: string;
}

// All inputs are assumed pre-validated (non-empty pushToken, known channel, valid level,
// non-empty feedToken) — validation lives at the HTTP boundary in fetch(). This function
// only encodes the access/storage decision, so it can be unit tested with plain objects,
// no Request/env plumbing.
export async function registerDevice(
  { channel, pushToken, level, feedToken }: RegisterParams,
  env: Pick<Env, 'TOKENS' | 'STATE'>,
): Promise<Response> {
  if (!(await feedTokenHasAccess(channel, feedToken))) {
    return new Response('no access', { status: 403 });
  }
  await env.STATE.put(`poll:${channel}`, feedToken);

  const meta: TokenMeta = { level, feedToken };
  await env.TOKENS.put(`${channel}:${pushToken}`, '1', { metadata: meta });
  return new Response('ok');
}

// True if this feedToken returns any items from the channel's primary feed.
// Signal: authorized tokens always return items; unauthorized/stale ones return 0.
export async function feedTokenHasAccess(channel: Channel, feedToken: string): Promise<boolean> {
  try {
    const res = await fetch(`${CHANNEL_FEEDS[channel][0].url}?feed_token=${feedToken}`);
    if (!res.ok) return false;
    const raw = parser.parse(await res.text())?.rss?.channel?.item ?? [];
    return (Array.isArray(raw) ? raw : [raw]).length > 0;
  } catch { return false; }
}

// Iterates registered users for a channel to find one whose feedToken
// returns content, then stores it as the new poll token.
export async function findAndStorePollToken(channel: Channel, env: Pick<Env, 'TOKENS' | 'STATE'>): Promise<string | null> {
  let cursor: string | undefined;
  do {
    const page = await env.TOKENS.list<TokenMeta>({ prefix: `${channel}:`, cursor });
    for (const key of page.keys) {
      const feedToken = key.metadata?.feedToken;
      if (!feedToken) continue;
      if (await feedTokenHasAccess(channel, feedToken)) {
        await env.STATE.put(`poll:${channel}`, feedToken);
        return feedToken;
      }
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return null;
}

async function runChannel(channel: Channel, env: Env): Promise<void> {
  const now = new Date();
  const intervals = {
    trading:  parseInt(env.POLL_INTERVAL_TRADING  ?? '5',  10),
    lateday:  parseInt(env.POLL_INTERVAL_LATEDAY  ?? '15', 10),
    overnight: parseInt(env.POLL_INTERVAL_OVERNIGHT ?? '60', 10),
  };
  const boundaries = {
    open:    hhmmToMinutes(env.POLL_BOUNDARY_OPEN    ?? '0915'),
    lateday: hhmmToMinutes(env.POLL_BOUNDARY_LATEDAY ?? '1400'),
    close:   hhmmToMinutes(env.POLL_BOUNDARY_CLOSE   ?? '1615'),
  };
  const statsKey = `stats:${channel}`;
  const prevStats = await env.STATE.get<RunStats>(statsKey, 'json');
  const lastRun = prevStats?.lastRun ? new Date(prevStats.lastRun) : null;
  if (!shouldPollNow(now, lastRun, getIntervalMinutes(now, intervals, boundaries))) return;

  const feedToken = await env.STATE.get(`poll:${channel}`);
  if (!feedToken) return; // no subscriber has registered for this channel yet

  const runStats: RunStats = { lastRun: now.toISOString(), lastNotified: null, itemsFetched: 0, newItems: 0, byLevel: {}, author: {}, forum: {}, actionable: {}, sent: 0 };
  const feeds = CHANNEL_FEEDS[channel];

  const topicsKey = `topics:${channel}`;
  const topicsJson = await env.STATE.get(topicsKey);
  const topics: Record<string, TopicEntry> = topicsJson ? JSON.parse(topicsJson) : {};

  const mainItems: RawItem[] = [];
  for (const feed of feeds) {
    try {
      const res = await fetch(`${feed.url}?feed_token=${feedToken}`);
      if (!res.ok) continue;
      const parsed = parser.parse(await res.text());
      const raw = parsed?.rss?.channel?.item ?? [];
      const items = Array.isArray(raw) ? raw : [raw];
      for (const item of items) {
        const link: string = item.link ?? '';
        const title: string = item.title ?? '';
        mainItems.push({
          guid: item.guid?.['#text'] ?? item.guid ?? link,
          title,
          author: item['dc:creator'] ?? item.author ?? '',
          description: item.description ?? '',
          link,
          feedKey: feed.feedKey,
        });
        if (feed.discoverTopics) {
          const topicUrl = extractTopicUrl(link);
          const topicTitle = stripReplyPrefix(title);
          if (topicUrl && (feed.feedKey !== FeedKeys.stockInsights || topicTitle.startsWith('*'))) {
            topics[topicUrl] = { lastSeen: now.toISOString(), title: topicTitle, feedKey: feed.feedKey };
          }
        }
      }
    } catch { /* skip failed feed */ }
  }

  // Valid tokens always return items; 0 items means the poll token is stale.
  // Attempt recovery from registered users' stored feedTokens.
  if (mainItems.length === 0) {
    await findAndStorePollToken(channel, env);
    return; // recovered token (if any) will be used on the next cron cycle
  }

  // Prune stale topics
  const cutoff = new Date(now.getTime() - TOPIC_GC_DAYS * 86400 * 1000);
  for (const [url, entry] of Object.entries(topics)) {
    if (new Date(entry.lastSeen) < cutoff) delete topics[url];
  }

  // Fetch all topic sub-feeds in parallel
  const topicUrls = Object.keys(topics);
  const topicResults = await Promise.all(
    topicUrls.map(async (topicUrl) => {
      try {
        const res = await fetch(`${topicUrl}feed/?feed_token=${feedToken}`);
        if (!res.ok) return [];
        const parsed = parser.parse(await res.text());
        const raw = parsed?.rss?.channel?.item ?? [];
        const items = Array.isArray(raw) ? raw : [raw];
        return items.map((item: Record<string, unknown>) => ({
          guid: (item.guid as Record<string, string>)?.['#text'] ?? item.guid ?? item.link ?? '',
          title: (item.title as string) ?? '',
          author: (item['dc:creator'] as string) ?? (item.author as string) ?? '',
          description: (item.description as string) ?? '',
          link: (item.link as string) ?? '',
          feedKey: topics[topicUrl].feedKey,
        } as RawItem));
      } catch { return []; }
    })
  );

  await env.STATE.put(topicsKey, JSON.stringify(topics));

  const allItems = dedup([...mainItems, ...topicResults.flat()]);

  const seenKey = `seen:${channel}`;
  const seenJson = await env.STATE.get(seenKey);
  const seenMap: Partial<Record<string, string[]>> = seenJson ? JSON.parse(seenJson) : {};

  const byFeed: Partial<Record<string, RawItem[]>> = {};
  for (const item of allItems) {
    (byFeed[item.feedKey] ??= []).push(item);
  }

  const newItems: RawItem[] = [];
  for (const [feedKey, feedItems] of Object.entries(byFeed) as [string, RawItem[]][]) {
    const seen = new Set(seenMap[feedKey] ?? []);
    if (seen.size === 0) {
      seenMap[feedKey] = feedItems.map((i) => i.guid).slice(-MAX_SEEN_IDS_PER_FEED);
      continue;
    }
    const newForFeed = feedItems.filter((i) => !seen.has(i.guid));
    feedItems.forEach((i) => seen.add(i.guid));
    seenMap[feedKey] = Array.from(seen).slice(-MAX_SEEN_IDS_PER_FEED);
    newItems.push(...newForFeed);
  }

  await env.STATE.put(seenKey, JSON.stringify(seenMap));

  runStats.itemsFetched = allItems.length;
  runStats.newItems = newItems.length;

  if (newItems.length === 0) {
    await env.STATE.put(`stats:${channel}`, JSON.stringify(runStats));
    return;
  }

  const authorFilter = (env.AUTHOR_FILTER ?? 'Sean Hyman').toLowerCase();
  const minLength = parseInt(env.MIN_CONTENT_LENGTH ?? '200', 10);

  const tokensByLevel: Partial<Record<NotifLevel, string[]>> = {};
  let cursor: string | undefined;
  do {
    const page = await env.TOKENS.list<TokenMeta>({ prefix: `${channel}:`, cursor });
    for (const key of page.keys) {
      const level: NotifLevel = key.metadata?.level ?? 'standard';
      const token = key.name.slice(channel.length + 1);
      (tokensByLevel[level] ??= []).push(token);
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);

  if (Object.keys(tokensByLevel).length === 0) {
    await env.STATE.put(`stats:${channel}`, JSON.stringify(runStats));
    return;
  }

  const classified = newItems.map(item => ({ item, c: classifyItem(item, authorFilter, minLength) }));
  for (const { item, c } of classified) {
    runStats.author[c.author]         = (runStats.author[c.author]         ?? 0) + 1;
    runStats.forum[c.forum]           = (runStats.forum[c.forum]           ?? 0) + 1;
    runStats.actionable[c.actionable] = (runStats.actionable[c.actionable] ?? 0) + 1;
    for (const level of ['minimal', 'standard', 'all'] as NotifLevel[]) {
      if (shouldNotify(level, c)) {
        const feedCounts = (runStats.byLevel[level] ??= {});
        feedCounts[item.feedKey] = (feedCounts[item.feedKey] ?? 0) + 1;
      }
    }
  }

  for (const [level, levelTokens] of Object.entries(tokensByLevel) as [NotifLevel, string[]][]) {
    const toNotify = classified
      .filter(({ c }) => shouldNotify(level, c))
      .map(({ item }) => item)
      .slice(0, 5);
    if (toNotify.length === 0) continue;

    const messages = toNotify.map((item, i) => ({
      to: levelTokens,
      // [PUSH] tag lets a device visually confirm which channel actually delivered an
      // alert — pairs with the app's [LOCAL] tag in notificationService.ts.
      title: `[PUSH] ${formatTitle(item)}`,
      body: stripHtml(item.description).slice(0, 150) || 'New post',
      sound: i === 0 ? 'default' : undefined,
    }));

    await fetch('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(messages),
    });
    runStats.sent += toNotify.length;
  }

  if (runStats.sent > 0) runStats.lastNotified = now.toISOString();
  await env.STATE.put(statsKey, JSON.stringify(runStats));

  const dailyKey = `daily:${channel}:${getETDate(now)}`;
  const daily: DailyStats = await env.STATE.get<DailyStats>(dailyKey, 'json') ?? {
    date: getETDate(now), runs: 0, itemsFetched: 0, newItems: 0, byLevel: {}, author: {}, forum: {}, actionable: {}, sent: 0,
  };
  daily.runs += 1;
  daily.itemsFetched += runStats.itemsFetched;
  daily.newItems += runStats.newItems;
  daily.sent += runStats.sent;
  mergeByLevel(daily.byLevel, runStats.byLevel);
  mergeTally(daily.author, runStats.author);
  mergeTally(daily.forum, runStats.forum);
  mergeTally(daily.actionable, runStats.actionable);
  await env.STATE.put(dailyKey, JSON.stringify(daily));
}


export { matchesLevel, stripReplyPrefix } from '@li/core';

export function extractTopicUrl(link: string): string | null {
  const match = link.match(/(https:\/\/logicalinvestor\.net\/forums\/topic\/[^/#]+\/)/);
  return match ? match[1] : null;
}

function dedup(items: RawItem[]): RawItem[] {
  const seen = new Set<string>();
  return items.filter(i => {
    if (seen.has(i.guid)) return false;
    seen.add(i.guid);
    return true;
  });
}

