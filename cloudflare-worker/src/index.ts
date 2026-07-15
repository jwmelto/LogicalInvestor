import { XMLParser } from 'fast-xml-parser';
import { FeedKeys, ChannelNames, formatTitle, matchesFilter, FILTER_TIERS, extractRssItems, isFresh, MAX_SEEN_IDS_PER_FEED, type FeedKey, type ContentFilter, type FilterItem, type Channel, type RssItem } from '@li/core';

function toFilterItem(item: RssItem): FilterItem {
  return { feedKey: item.feedKey, author: item.author, title: item.title, content: item.description };
}

export interface Env {
  TOKENS: KVNamespace;
  STATE: KVNamespace;
  FEED_TOKEN: string;               // secret for GET /status (Authorization: Bearer)
  POLL_INTERVAL_TRADING?: string;   // minutes between polls during trading hours, default "5"
  POLL_INTERVAL_LATEDAY?: string;   // minutes between polls during late-day window, default "15"
  POLL_INTERVAL_OVERNIGHT?: string; // minutes between polls outside market hours, default "60"
  POLL_BOUNDARY_OPEN?: string;      // hhmm ET when trading hours begin, default "915"
  POLL_BOUNDARY_LATEDAY?: string;   // hhmm ET when late-day window begins, default "1400"
  POLL_BOUNDARY_CLOSE?: string;     // hhmm ET when late-day window ends, default "1615"
  MAX_PUSH_AGE_MINUTES?: string;    // content older than this won't be pushed even if newly-seen, default "120"
  MAX_ALERT_ITEMS_PER_FEED?: string; // cap on how many of a feed's most-recent posts are considered per poll, default "25"
  ACTIONABLE_AUTHORS?: string;      // comma-separated; who can trigger the 'actionable' tier, default "Sean Hyman"
  // Per-channel dead-man's-switch pings (healthchecks.io or similar) — see issue #24.
  // One check per channel since each is an independent Cloudflare Cron Trigger registration
  // and can get stuck without the others being affected.
  HEARTBEAT_URL_MEMBERS?: string;
  HEARTBEAT_URL_STOCK?: string;
  HEARTBEAT_URL_OPTIONS?: string;
}

// filter/authors/minLength are required on every registration. feedToken is optional here only
// for KV entries predating universal storage; recovers a stale stock/options poll token.
interface TokenMeta {
  feedToken?: string;
  filter?: ContentFilter;
  authors?: string[];
  minLength?: number;
}

interface RunStats {
  lastRun: string;
  lastNotified: string | null;
  itemsFetched: number;
  numNewItems: number;
  sent: number;
}

interface DailyStats {
  date: string;
  runs: number;
  itemsFetched: number;
  numNewItems: number;
  sent: number;
}

// Channel-to-cron mapping: CHANNELS[i] corresponds to the cron whose minute list starts at offset i.
// wrangler.toml MUST list the three crons in this exact order, with each starting one minute later:
//   members → "0,5,10,15,..."   (offset 0)
//   stock   → "1,6,11,16,..."   (offset 1)
//   options → "2,7,12,17,..."   (offset 2)
// Changing either this array OR the wrangler.toml cron order silently breaks the channel mapping.
// ponytail: brittle by design — simplest option available; revisit if a 4th channel is added.
const CHANNELS: Channel[] = [ChannelNames.members, ChannelNames.stock, ChannelNames.options];

export function channelFromCron(cron: string): Channel {
  const offset = parseInt(cron.split(' ')[0].split(',')[0], 10);
  return CHANNELS[offset] ?? ChannelNames.members;
}

export function heartbeatUrlFor(channel: Channel, env: Env): string | undefined {
  return {
    members: env.HEARTBEAT_URL_MEMBERS,
    stock: env.HEARTBEAT_URL_STOCK,
    options: env.HEARTBEAT_URL_OPTIONS,
  }[channel];
}

// The 'members' Channel bundles two distinct feeds under one push-registration grouping.
// feedTokenHasAccess() below always checks index [0] of a channel's feed list, so order is
// deliberate here: Members Forum is first because its feed requires a valid feed_token to
// return any items, making it a real check of membership status (catches an expired or
// invalid token). Members Area's feed is readable regardless of token validity — only the
// content snippet is paywalled — so it would never catch anything if checked instead.
//
// No `discoverTopics`/topic-sub-feed fetching here — the top-level "All Posts" feed for a forum
// already aggregates replies from every topic in it (confirmed against a real authenticated
// fetch), so alerting never needs to walk into individual topics. Topic discovery remains a
// purely app-side concern (topicService.ts) for the browsing UI.
export const CHANNEL_FEEDS: Record<Channel, { url: string; feedKey: FeedKey }[]> = {
  members: [
    { url: 'https://logicalinvestor.net/forums/forum/members-forum/feed/', feedKey: FeedKeys.membersForum },
    { url: 'https://logicalinvestor.net/feed/',                            feedKey: FeedKeys.membersArea },
  ],
  stock: [
    { url: 'https://logicalinvestor.net/forums/forum/stock-insights/feed/', feedKey: FeedKeys.stockInsights },
  ],
  options: [
    { url: 'https://logicalinvestor.net/forums/forum/options-insights/feed/', feedKey: FeedKeys.optionsInsights },
  ],
};

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
  //   POST /register    { token, channel, filter, authors, minLength, feed_token }
  //   POST /unregister  { token, channel }
  //
  //   token      — Expo push token (device identifier for APNs/FCM delivery)
  //   channel    — 'members' | 'stock' | 'options'
  //   filter     — 'members' | 'actionable' | 'length' (see @li/core ContentFilter)
  //   authors    — string[], substring whitelist; [] = no author restriction (no global fallback)
  //   minLength  — number; 0 = no minimum
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
        const [tokens, seenJson, pollToken, statsJson] = await Promise.all([
          env.TOKENS.list({ prefix: `${channel}:` }),
          env.STATE.get(`seen:${channel}`),
          env.STATE.get(`poll:${channel}`),
          env.STATE.get(`stats:${channel}`),
        ]);
        const stats: RunStats | null = statsJson ? JSON.parse(statsJson) : null;
        result[channel] = {
          registeredTokens: tokens.keys.length,
          seenIds:   seenJson ? Object.values(JSON.parse(seenJson) as Record<string, string[]>).reduce((a, b) => a + b.length, 0) : 0,
          pollToken: pollToken ? 'present' : 'missing',
          lastRun:      stats?.lastRun      ?? null,
          lastNotified: stats?.lastNotified ?? null,
          lastRunStats: stats ? {
            itemsFetched: stats.itemsFetched,
            numNewItems:  stats.numNewItems,
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

    const body = await request.json() as { token?: string; channel?: string; filter?: string; authors?: unknown; minLength?: unknown; feed_token?: string };
    const pushToken = body.token;
    const channel = body.channel as Channel | null;
    if (!pushToken) return new Response('missing token', { status: 400 });
    if (!channel || !CHANNELS.includes(channel)) {
      return new Response('invalid channel', { status: 400 });
    }

    const kvKey = `${channel}:${pushToken}`;

    if (url.pathname === '/register') {
      const filter = body.filter as ContentFilter;
      if (!FILTER_TIERS.includes(filter)) {
        return new Response('missing or invalid filter', { status: 400 });
      }
      if (!Array.isArray(body.authors) || !body.authors.every((a) => typeof a === 'string')) {
        return new Response('missing or invalid authors', { status: 400 });
      }
      if (typeof body.minLength !== 'number' || body.minLength < 0) {
        return new Response('missing or invalid minLength', { status: 400 });
      }
      const feedToken = body.feed_token;
      if (typeof feedToken !== 'string' || feedToken === '') {
        return new Response('missing or invalid feed_token', { status: 400 });
      }
      return registerDevice({ channel, pushToken, filter, authors: body.authors, minLength: body.minLength, feedToken }, env);
    }
    if (url.pathname === '/unregister') {
      await env.TOKENS.delete(kvKey);
      return new Response('ok');
    }
    return new Response('not found', { status: 404 });
  },

  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    const channel = channelFromCron(event.cron);
    // Dead-man's-switch: proves Cloudflare actually dispatched this channel's cron trigger.
    // See issue #24 — all three triggers silently stopped firing for ~15h with no error anywhere.
    const heartbeatUrl = heartbeatUrlFor(channel, env);
    if (heartbeatUrl) {
      ctx.waitUntil(fetch(heartbeatUrl).catch(() => {}));
    }
    await runChannel(channel, env);
  },
};

export interface RegisterParams {
  channel: Channel;
  pushToken: string;
  filter: ContentFilter;
  authors: string[];
  minLength: number;
  feedToken: string;
}

// All inputs are assumed pre-validated (non-empty pushToken, known channel, valid filter,
// non-empty feedToken) — validation lives at the HTTP boundary in fetch(). This function
// only encodes the access/storage decision, so it can be unit tested with plain objects,
// no Request/env plumbing.
export async function registerDevice(
  { channel, pushToken, filter, authors, minLength, feedToken }: RegisterParams,
  env: Pick<Env, 'TOKENS' | 'STATE'>,
): Promise<Response> {
  const access = await feedTokenHasAccess(channel, feedToken);
  if (access === null) {
    return new Response('access check failed, try again', { status: 503 });
  }
  if (!access) {
    return new Response('no access', { status: 403 });
  }
  await env.STATE.put(`poll:${channel}`, feedToken);

  const meta: TokenMeta = { feedToken, filter, authors: authors.map((a) => a.toLowerCase()), minLength };
  await env.TOKENS.put(`${channel}:${pushToken}`, '1', { metadata: meta });
  return new Response('ok');
}

// Tri-state: true/false are definitive (item count, or a 401/403 meaning revoked access);
// null means the check itself failed (network error, 5xx, timeout) and access is unknown —
// callers must not treat null as "no access" or a transient blip permanently deletes registrations.
export async function feedTokenHasAccess(channel: Channel, feedToken: string): Promise<boolean | null> {
  try {
    const res = await fetch(`${CHANNEL_FEEDS[channel][0].url}?feed_token=${feedToken}`);
    if (res.status === 401 || res.status === 403) return false;
    if (!res.ok) return null;
    const raw = parser.parse(await res.text())?.rss?.channel?.item ?? [];
    return (Array.isArray(raw) ? raw : [raw]).length > 0;
  } catch { return null; }
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

async function recordDaily(env: Env, channel: Channel, now: Date, runStats: RunStats): Promise<void> {
  const dailyKey = `daily:${channel}:${getETDate(now)}`;
  const daily: DailyStats = await env.STATE.get<DailyStats>(dailyKey, 'json') ?? {
    date: getETDate(now), runs: 0, itemsFetched: 0, numNewItems: 0, sent: 0,
  };
  daily.runs += 1;
  daily.itemsFetched += runStats.itemsFetched;
  daily.numNewItems += runStats.numNewItems;
  daily.sent += runStats.sent;
  await env.STATE.put(dailyKey, JSON.stringify(daily));
}

interface Bucket { filter: ContentFilter; authors: string[]; minLength: number; tokens: string[] }

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
  // Despite the 5–60 min poll cadence above, content can still surface as newly-seen well after
  // publish — cap how old something can be and still get pushed (issue #48).
  const maxPushAgeMs = parseInt(env.MAX_PUSH_AGE_MINUTES ?? '120', 10) * 60 * 1000;
  // Cap on how many of a forum's most-recent posts are ever considered for alerting, independent
  // of how many the upstream RSS feed happens to return today — full history/backlog is the
  // app's job (its own reconciliation on every foreground refresh), not the Worker's. See
  // "Server-side alerting model" in the design doc for why a cap exists at all.
  const maxAlertItemsPerFeed = parseInt(env.MAX_ALERT_ITEMS_PER_FEED ?? '25', 10);
  // Who can trigger the 'actionable' tier.
  const actionableAuthors = (env.ACTIONABLE_AUTHORS ?? 'Sean Hyman').split(',').map((a) => a.trim().toLowerCase());
  const statsKey = `stats:${channel}`;
  const prevStats = await env.STATE.get<RunStats>(statsKey, 'json');
  const lastRun = prevStats?.lastRun ? new Date(prevStats.lastRun) : null;
  if (!shouldPollNow(now, lastRun, getIntervalMinutes(now, intervals, boundaries))) return;

  const feedToken = await env.STATE.get(`poll:${channel}`);
  if (!feedToken) return; // no subscriber has registered for this channel yet

  const seenKey = `seen:${channel}`;
  const seenJson = await env.STATE.get(seenKey);
  const seenMap: Partial<Record<string, string[]>> = seenJson ? JSON.parse(seenJson) : {};

  // Per forum: fetch the top-level feed only (no topic sub-feeds — see design doc), cap to the
  // most recent maxAlertItemsPerFeed, and — since these feeds are confirmed reverse-chronological
  // — walk from newest until the first already-seen guid, then stop. Everything past that point
  // must already be seen too, so there's no need to scan further. The freshness check (issue #48)
  // happens in the same walk rather than as a separate pass, and each feed's fresh items are
  // reversed before collecting so alerting processes oldest-to-newest — a user who missed several
  // posts sees them in reading order, not newest-first.
  let itemsFetched = 0;
  const newItems: RssItem[] = [];
  const freshItems: RssItem[] = [];
  for (const feed of CHANNEL_FEEDS[channel]) {
    try {
      const res = await fetch(`${feed.url}?feed_token=${feedToken}`);
      if (!res.ok) continue;
      const items: RssItem[] = extractRssItems(parser.parse(await res.text()))
        .slice(0, maxAlertItemsPerFeed)
        .map((rssItem) => ({ ...rssItem, feedKey: feed.feedKey }));
      itemsFetched += items.length;

      const seenList = seenMap[feed.feedKey];
      if (seenList === undefined) {
        // First ever poll for this feed: seed known guids without notifying (avoids a
        // flood on day one, same reasoning as the app's own first-run seeding).
        seenMap[feed.feedKey] = items.map((i) => i.guid).slice(0, MAX_SEEN_IDS_PER_FEED);
        continue;
      }
      const seenSet = new Set(seenList);
      const newForFeed: RssItem[] = [];
      const freshForFeed: RssItem[] = [];
      for (const item of items) {
        if (seenSet.has(item.guid)) break;
        newForFeed.push(item);
        if (isFresh(item.pubDate, maxPushAgeMs)) freshForFeed.push(item);
      }
      newItems.push(...newForFeed);
      freshItems.push(...freshForFeed.reverse());
      seenMap[feed.feedKey] = [...newForFeed.map((i) => i.guid), ...seenList].slice(0, MAX_SEEN_IDS_PER_FEED);
    } catch { /* skip failed feed */ }
  }

  // Valid tokens always return items for Members Forum/Stock/Options Insights, which require a
  // real token to return anything; Members Area returns items regardless of token validity (only
  // the content snippet is paywalled), so a stale token for the 'members' channel can still show
  // itemsFetched > 0 here. That's a pre-existing gap in lapsed-subscription detection for that
  // channel specifically, not something this change introduces — tracked in issue #58.
  if (itemsFetched === 0) {
    await findAndStorePollToken(channel, env);
    return; // recovered token (if any) will be used on the next cron cycle
  }

  const runStats: RunStats = { lastRun: now.toISOString(), lastNotified: null, itemsFetched, numNewItems: newItems.length, sent: 0 };

  // Claim this run now, before the slower device-listing/notify work below, to shrink the window
  // in which a concurrent duplicate invocation (Cloudflare can dispatch a cron tick twice) reads
  // the same stale prevStats and double-sends. Not a hard guarantee (KV has no compare-and-swap),
  // just a smaller race window.
  await env.STATE.put(statsKey, JSON.stringify(runStats));
  await env.STATE.put(seenKey, JSON.stringify(seenMap));

  if (newItems.length === 0) {
    await recordDaily(env, channel, now, runStats);
    return;
  }

  const buckets = new Map<string, Bucket>();
  let cursor: string | undefined;
  do {
    const page = await env.TOKENS.list<TokenMeta>({ prefix: `${channel}:`, cursor });
    for (const key of page.keys) {
      // Access is only checked at registration time (registerDevice). A subscription can lapse
      // afterward, so re-verify here — same signal findAndStorePollToken uses for stale tokens —
      // and prune dead registrations before they get another channel's worth of content pushed
      // to them. metadata comes free with the list() call above, so this adds no extra KV reads;
      // only an HTTP fetch per device, and only when there's new content to notify about.
      const deviceFeedToken = key.metadata?.feedToken;
      if (deviceFeedToken) {
        const access = await feedTokenHasAccess(channel, deviceFeedToken);
        if (access === false) {
          await env.TOKENS.delete(key.name);
          continue;
        }
        // access === null: check itself failed (network blip, 5xx) — leave the registration
        // and keep notifying; only a definitive 401/403 proves access was actually revoked.
      }
      const { filter, authors, minLength } = key.metadata ?? {};
      if (!filter || authors === undefined || minLength === undefined) continue; // pre-redesign entry — skip until it re-registers
      const token = key.name.slice(channel.length + 1);
      // Devices sharing filter+authors+minLength get one shared eligibility check per item below
      // instead of one per device — negligible cost even at hundreds of distinct buckets.
      const sig = `${filter}|${authors.join(',')}|${minLength}`;
      const bucket = buckets.get(sig) ?? { filter, authors, minLength, tokens: [] };
      bucket.tokens.push(token);
      buckets.set(sig, bucket);
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);

  if (buckets.size === 0) {
    await recordDaily(env, channel, now, runStats);
    return;
  }

  // Push-sends are independent per bucket, so they run concurrently rather than one at a time —
  // this shortens wall-clock duration (fetch() wait doesn't count against the Worker's CPU-time
  // limit either way, but a shorter invocation is still less exposed to Cloudflare's separate
  // wall-clock duration cap). A failure in one bucket's send must not skip the others.
  const sentCounts = await Promise.all(
    Array.from(buckets.values()).map(async (bucket) => {
      const toNotify = freshItems
        .filter((item) => matchesFilter(toFilterItem(item), bucket.filter, bucket.authors, bucket.minLength, actionableAuthors))
        .slice(0, 5);
      if (toNotify.length === 0) return 0;

      const messages = toNotify.map((item, i) => ({
        to: bucket.tokens,
        title: `[PUSH] ${formatTitle(item)}`,
        body: item.description.slice(0, 150) || 'New post',
        sound: i === 0 ? 'default' : undefined,
      }));

      try {
        await fetch('https://exp.host/--/api/v2/push/send', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(messages),
        });
        return toNotify.length;
      } catch {
        return 0;
      }
    })
  );
  runStats.sent = sentCounts.reduce((a, b) => a + b, 0);

  if (runStats.sent > 0) {
    runStats.lastNotified = now.toISOString();
    await env.STATE.put(statsKey, JSON.stringify(runStats));
  }
  await recordDaily(env, channel, now, runStats);
}

export { matchesFilter, minVisibleTier, stripReplyPrefix } from '@li/core';
