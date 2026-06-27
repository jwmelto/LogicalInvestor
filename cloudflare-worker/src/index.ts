import { XMLParser } from 'fast-xml-parser';
import { FeedKeys, stripHtml, stripReplyPrefix, formatTitle, matchesLevel, MAX_SEEN_IDS, type FeedKey, type FilterItem, type NotifLevel } from '@li/core';

export interface Env {
  TOKENS: KVNamespace;
  STATE: KVNamespace;
  FEED_TOKEN: string;              // polling token for members channel
  AUTHOR_FILTER: string;           // wrangler.toml [vars], default "Sean Hyman"
  MIN_CONTENT_LENGTH: string;      // wrangler.toml [vars], default "200"
  ACTION_PATTERNS?: string;        // wrangler.toml [vars], JSON array of regex strings; omit to use DEFAULT_ACTION_PATTERNS
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
  feedKey: FeedKey; // camelCase, from @li/core
}

interface TokenMeta {
  level?: NotifLevel;
  feedToken?: string; // stored for optional channels; used to recover a stale poll token
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

const CHANNEL_FEEDS: Record<Channel, { url: string; feedKey: FeedKey; discoverTopics: boolean }[]> = {
  members: [
    { url: 'https://logicalinvestor.net/feed/',                                        feedKey: FeedKeys.membersArea,     discoverTopics: false },
    { url: 'https://logicalinvestor.net/forums/forum/members-forum/feed/',             feedKey: FeedKeys.membersForum,    discoverTopics: true  },
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

// Gate: returns true if this invocation should do real work.
// All values configurable via env vars; defaults match original behavior:
//   trading hours  (OPEN–LATEDAY ET weekdays):  every 5 min
//   late day       (LATEDAY–CLOSE ET weekdays):  every 15 min
//   overnight + weekends:                        every 60 min
// Intervals must be multiples of 5 (cron base cadence). Trading interval ≤5 runs every invocation.
// Boundary defaults (minutes since midnight):
//   open:    555  (09*60+15 = 09:15 ET, market open)
//   lateday: 840  (14*60+00 = 14:00 ET, reduced-activity window begins)
//   close:   975  (16*60+15 = 16:15 ET, after-hours begins)
export function shouldPollNow(
  now: Date,
  intervals  = { trading: 5, lateday: 15, overnight: 60 },
  boundaries = { open: 555, lateday: 840, close: 975 },
): boolean {
  const { day, timeOfDay, min } = getETComponents(now);

  if (day === 0 || day === 6) return min % intervals.overnight === 0;
  if (timeOfDay >= boundaries.open    && timeOfDay < boundaries.lateday) return intervals.trading <= 5 ? true : min % intervals.trading === 0;
  if (timeOfDay >= boundaries.lateday && timeOfDay < boundaries.close)   return min % intervals.lateday === 0;
  return min % intervals.overnight === 0;
}

export default {
  // HTTP API (called by the app's pushService.ts):
  //
  //   POST /register    { token, channel, level, feed_token? }
  //   POST /unregister  { token, channel }
  //
  //   token      — Expo push token (device identifier for APNs/FCM delivery)
  //   channel    — 'members' | 'stock' | 'options'
  //   level      — 'minimal' | 'standard' | 'all'
  //   feed_token — WordPress auth token used by the Worker to poll this channel's
  //                feed on the user's behalf. Distinct from the push token.
  //                Only required for optional channels (stock, options).
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
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
      const level = (body.level ?? 'standard') as NotifLevel;
      const feedToken = body.feed_token;
      const meta: TokenMeta = { level };
      if (feedToken && channel !== 'members') {
        meta.feedToken = feedToken;
        await env.STATE.put(`poll:${channel}`, feedToken);
      }
      await env.TOKENS.put(kvKey, '1', { metadata: meta });
      return new Response('ok');
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

// Iterates registered users for a channel to find one whose feedToken
// returns content, then stores it as the new poll token.
// Recovery signal: valid tokens always return items; stale tokens return 0 items.
export async function findAndStorePollToken(channel: Channel, env: Pick<Env, 'TOKENS' | 'STATE'>): Promise<string | null> {
  const testUrl = CHANNEL_FEEDS[channel][0].url;
  let cursor: string | undefined;
  do {
    const page = await env.TOKENS.list<TokenMeta>({ prefix: `${channel}:`, cursor });
    for (const key of page.keys) {
      const feedToken = key.metadata?.feedToken;
      if (!feedToken) continue;
      try {
        const res = await fetch(`${testUrl}?feed_token=${feedToken}`);
        if (!res.ok) continue;
        const raw = parser.parse(await res.text())?.rss?.channel?.item ?? [];
        const items = Array.isArray(raw) ? raw : [raw];
        if (items.length > 0) {
          await env.STATE.put(`poll:${channel}`, feedToken);
          return feedToken;
        }
      } catch { continue; }
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return null;
}

async function runChannel(channel: Channel, env: Env): Promise<void> {
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
  if (!shouldPollNow(new Date(), intervals, boundaries)) return;

  const feedToken = channel === 'members'
    ? env.FEED_TOKEN
    : await env.STATE.get(`poll:${channel}`);
  if (!feedToken) return; // no subscriber has registered for this channel yet

  const now = new Date();
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
          if (topicUrl && (feed.feedKey !== 'stock-insights' || topicTitle.startsWith('*'))) {
            topics[topicUrl] = { lastSeen: now.toISOString(), title: topicTitle, feedKey: feed.feedKey };
          }
        }
      }
    } catch { /* skip failed feed */ }
  }

  // Valid tokens always return items; 0 items means the poll token is stale.
  // Attempt recovery from registered users' stored feedTokens.
  if (channel !== 'members' && mainItems.length === 0) {
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
  const seen = new Set<string>(seenJson ? JSON.parse(seenJson) : []);

  if (seen.size === 0) {
    await env.STATE.put(seenKey, JSON.stringify(allItems.map(i => i.guid)));
    return;
  }

  const newItems = allItems.filter(i => !seen.has(i.guid));
  allItems.forEach(i => seen.add(i.guid));
  await env.STATE.put(seenKey, JSON.stringify(Array.from(seen).slice(-MAX_SEEN_IDS)));

  if (newItems.length === 0) return;

  const authorFilter = (env.AUTHOR_FILTER ?? 'Sean Hyman').toLowerCase();
  const minLength = parseInt(env.MIN_CONTENT_LENGTH ?? '200', 10);
  const actionPatterns: string[] | undefined = env.ACTION_PATTERNS ? JSON.parse(env.ACTION_PATTERNS) : undefined;

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

  if (Object.keys(tokensByLevel).length === 0) return;

  for (const [level, levelTokens] of Object.entries(tokensByLevel) as [NotifLevel, string[]][]) {
    const toNotify = newItems
      .filter(item => matchesLevel(toFilterItem(item), level, authorFilter, minLength, actionPatterns))
      .slice(0, 5);
    if (toNotify.length === 0) continue;

    const messages = toNotify.map((item, i) => ({
      to: levelTokens,
      title: formatTitle(item),
      body: stripHtml(item.description).slice(0, 150) || 'New post',
      sound: i === 0 ? 'default' : undefined,
    }));

    await fetch('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(messages),
    });
  }
}

function toFilterItem(item: RawItem): FilterItem {
  return { feedKey: item.feedKey, author: item.author, title: item.title, content: item.description };
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

