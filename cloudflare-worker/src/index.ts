import { XMLParser } from 'fast-xml-parser';

export interface Env {
  TOKENS: KVNamespace;
  STATE: KVNamespace;
  FEED_TOKEN: string;         // polling token for members channel
  AUTHOR_FILTER: string;      // wrangler.toml [vars], default "Sean Hyman"
  MIN_CONTENT_LENGTH: string; // wrangler.toml [vars], default "200"
}

type Channel = 'members' | 'stock' | 'options';
type FeedKey = 'members-area' | 'members-forum' | 'stock-insights' | 'options-insights';
type NotifLevel = 'minimal' | 'standard' | 'all';

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
  feedToken?: string; // stored for optional channels; used to recover a stale poll token
}

export const CRON_TO_CHANNEL: Record<string, Channel> = {
  '*/5 * * * *':                                         'members',
  '1,6,11,16,21,26,31,36,41,46,51,56 * * * *':          'stock',
  '3,8,13,18,23,28,33,38,43,48,53,58 * * * *':          'options',
};

const CHANNEL_FEEDS: Record<Channel, { url: string; feedKey: FeedKey; discoverTopics: boolean }[]> = {
  members: [
    { url: 'https://logicalinvestor.net/feed/',                                        feedKey: 'members-area',     discoverTopics: false },
    { url: 'https://logicalinvestor.net/forums/forum/members-forum/feed/',             feedKey: 'members-forum',    discoverTopics: true  },
  ],
  stock: [
    { url: 'https://logicalinvestor.net/forums/forum/stock-insights/feed/',            feedKey: 'stock-insights',   discoverTopics: true  },
  ],
  options: [
    { url: 'https://logicalinvestor.net/forums/forum/options-insights/feed/',          feedKey: 'options-insights', discoverTopics: false },
  ],
};

const TOPIC_GC_DAYS = 30;
const MAX_SEEN = 500; // ponytail: cap to prevent unbounded KV growth

// Module-level parser shared across all calls within an invocation
const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });

// Returns the ET UTC offset: -4 during EDT (Mar 2nd Sun → Nov 1st Sun), -5 otherwise
export function getETOffset(now: Date): -4 | -5 {
  const y = now.getUTCFullYear();
  const dstStart = nthWeekdayOfMonth(y, 2,  0, 2, 7); // March,    2nd Sunday, 07:00 UTC
  const dstEnd   = nthWeekdayOfMonth(y, 10, 0, 1, 6); // November, 1st Sunday, 06:00 UTC
  return now >= dstStart && now < dstEnd ? -4 : -5;
}

function nthWeekdayOfMonth(year: number, month: number, weekday: number, n: number, utcHour: number): Date {
  const first = new Date(Date.UTC(year, month, 1));
  const offset = (weekday - first.getUTCDay() + 7) % 7;
  return new Date(Date.UTC(year, month, 1 + offset + (n - 1) * 7, utcHour));
}

// Gate: returns true if this invocation should do real work.
// 0915–1400 ET weekdays: every 5 min (all invocations)
// 1400–1615 ET weekdays: every 15 min
// all other times + weekends: hourly
export function shouldPollNow(now: Date): boolean {
  const etMs  = now.getTime() + getETOffset(now) * 3600_000;
  const et    = new Date(etMs);
  const day   = et.getUTCDay();                        // 0=Sun 6=Sat in ET
  const hhmm  = et.getUTCHours() * 100 + et.getUTCMinutes();
  const min   = et.getUTCMinutes();

  if (day === 0 || day === 6) return min === 0;        // weekends: hourly
  if (hhmm >= 915 && hhmm < 1400) return true;        // trading hours: every 5 min
  if (hhmm >= 1400 && hhmm < 1615) return min % 15 === 0; // post-market: every 15 min
  return min === 0;                                    // overnight: hourly
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== 'POST') return new Response('not found', { status: 404 });

    const pushToken = url.searchParams.get('token');
    const channel = url.searchParams.get('channel') as Channel | null;
    if (!pushToken) return new Response('missing token', { status: 400 });
    if (!channel || !['members', 'stock', 'options'].includes(channel)) {
      return new Response('invalid channel', { status: 400 });
    }

    const kvKey = `${channel}:${pushToken}`;

    if (url.pathname === '/register') {
      const level = (url.searchParams.get('level') ?? 'standard') as NotifLevel;
      const feedToken = url.searchParams.get('feed_token');
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
    const channel = CRON_TO_CHANNEL[event.cron] ?? 'members';
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
  if (!shouldPollNow(new Date())) return;

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
  await env.STATE.put(seenKey, JSON.stringify(Array.from(seen).slice(-MAX_SEEN)));

  if (newItems.length === 0) return;

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

  if (Object.keys(tokensByLevel).length === 0) return;

  for (const [level, levelTokens] of Object.entries(tokensByLevel) as [NotifLevel, string[]][]) {
    const toNotify = newItems
      .filter(item => matchesLevel(item, level, authorFilter, minLength))
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

export function matchesLevel(item: RawItem, level: NotifLevel, authorFilter: string, minLength: number): boolean {
  if (item.feedKey === 'members-area') return true;
  if (level === 'minimal') return false;
  if (!item.author.toLowerCase().includes(authorFilter)) return false;
  if (level === 'all') return true;
  if (item.feedKey === 'stock-insights') return stripReplyPrefix(item.title).startsWith('*');
  return stripHtml(item.description).length >= minLength;
}

export function extractTopicUrl(link: string): string | null {
  const match = link.match(/(https:\/\/logicalinvestor\.net\/forums\/topic\/[^/#]+\/)/);
  return match ? match[1] : null;
}

export function stripReplyPrefix(title: string): string {
  return title.startsWith('Reply To: ') ? title.slice(10).trim() : title.trim();
}

function dedup(items: RawItem[]): RawItem[] {
  const seen = new Set<string>();
  return items.filter(i => {
    if (seen.has(i.guid)) return false;
    seen.add(i.guid);
    return true;
  });
}

function formatTitle(item: RawItem): string {
  const topic = stripReplyPrefix(item.title);
  return topic ? `${item.author} in ${topic}:` : item.author || 'New post';
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]*>/g, '').replace(/&[^;]+;/g, ' ').replace(/\s+/g, ' ').trim();
}
