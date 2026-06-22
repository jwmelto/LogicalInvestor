import { XMLParser } from 'fast-xml-parser';

export interface Env {
  TOKENS: KVNamespace;
  STATE: KVNamespace;
  FEED_TOKEN: string;
  AUTHOR_FILTER: string;      // wrangler.toml [vars], default "Sean Hyman"
  MIN_CONTENT_LENGTH: string; // wrangler.toml [vars], default "200"
}

type FeedKey = 'members-area' | 'members-forum' | 'stock-insights';
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
  lastSeen: string; // ISO date
  title: string;    // topic title (may start with * for SI)
  feedKey: FeedKey;
}

interface TokenMeta {
  level?: NotifLevel;
}

const MAIN_FEEDS: { url: string; feedKey: FeedKey; discoverTopics: boolean }[] = [
  { url: 'https://logicalinvestor.net/feed/',                                          feedKey: 'members-area',    discoverTopics: false },
  { url: 'https://logicalinvestor.net/forums/forum/members-forum/feed/',               feedKey: 'members-forum',   discoverTopics: true  },
  { url: 'https://logicalinvestor.net/forums/forum/stock-insights/feed/',              feedKey: 'stock-insights',  discoverTopics: true  },
];

const TOPIC_GC_DAYS = 30;
const MAX_SEEN = 500; // ponytail: cap to prevent unbounded KV growth

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== 'POST') return new Response('not found', { status: 404 });

    const token = url.searchParams.get('token');
    if (!token) return new Response('missing token', { status: 400 });

    if (url.pathname === '/register') {
      const level = (url.searchParams.get('level') ?? 'standard') as NotifLevel;
      await env.TOKENS.put(token, '1', { metadata: { level } });
      return new Response('ok');
    }
    if (url.pathname === '/unregister') {
      await env.TOKENS.delete(token);
      return new Response('ok');
    }
    return new Response('not found', { status: 404 });
  },

  async scheduled(_event: ScheduledEvent, env: Env, _ctx: ExecutionContext): Promise<void> {
    await runScheduled(env);
  },
};

async function runScheduled(env: Env): Promise<void> {
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });
  const now = new Date();

  // Load topic store
  const topicsJson = await env.STATE.get('topics');
  const topics: Record<string, TopicEntry> = topicsJson ? JSON.parse(topicsJson) : {};

  // Fetch main feeds, collect items, discover topics
  const mainItems: RawItem[] = [];
  for (const feed of MAIN_FEEDS) {
    try {
      const res = await fetch(`${feed.url}?feed_token=${env.FEED_TOKEN}`);
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

        // Topic discovery
        if (feed.discoverTopics) {
          const topicUrl = extractTopicUrl(link);
          const topicTitle = stripReplyPrefix(title);
          if (topicUrl && shouldTrackTopic(topicTitle, feed.feedKey)) {
            topics[topicUrl] = { lastSeen: now.toISOString(), title: topicTitle, feedKey: feed.feedKey };
          }
        }
      }
    } catch { /* skip failed feed */ }
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
        const res = await fetch(`${topicUrl}feed/?feed_token=${env.FEED_TOKEN}`);
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

  // Save updated topic store
  await env.STATE.put('topics', JSON.stringify(topics));

  // Combine and deduplicate all items by guid
  const allItems = dedup([...mainItems, ...topicResults.flat()]);

  // Check seen_ids
  const seenJson = await env.STATE.get('seen_ids');
  const seen = new Set<string>(seenJson ? JSON.parse(seenJson) : []);

  if (seen.size === 0) {
    await env.STATE.put('seen_ids', JSON.stringify(allItems.map(i => i.guid)));
    return;
  }

  const newItems = allItems.filter(i => !seen.has(i.guid));
  allItems.forEach(i => seen.add(i.guid));
  await env.STATE.put('seen_ids', JSON.stringify(Array.from(seen).slice(-MAX_SEEN)));

  if (newItems.length === 0) return;

  const authorFilter = (env.AUTHOR_FILTER ?? 'Sean Hyman').toLowerCase();
  const minLength = parseInt(env.MIN_CONTENT_LENGTH ?? '200', 10);

  // Collect tokens grouped by level (metadata avoids extra KV reads)
  const tokensByLevel: Partial<Record<NotifLevel, string[]>> = {};
  let cursor: string | undefined;
  do {
    const page = await env.TOKENS.list<TokenMeta>({ cursor });
    for (const key of page.keys) {
      const level: NotifLevel = key.metadata?.level ?? 'standard';
      (tokensByLevel[level] ??= []).push(key.name);
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);

  if (Object.keys(tokensByLevel).length === 0) return;

  // Send one Expo batch per level group
  for (const [level, levelTokens] of Object.entries(tokensByLevel) as [NotifLevel, string[]][]) {
    const toNotify = newItems
      .filter(item => matchesLevel(item, level, authorFilter, minLength))
      .slice(0, 5);
    if (toNotify.length === 0) continue;

    // Sound only on first notification — one beep for the batch
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

function matchesLevel(item: RawItem, level: NotifLevel, authorFilter: string, minLength: number): boolean {
  if (item.feedKey === 'members-area') return true; // always; only Sean posts here
  if (level === 'minimal') return false;
  if (!item.author.toLowerCase().includes(authorFilter)) return false;
  if (level === 'all') return true;
  // standard: SI needs * prefix, members-forum needs min length
  if (item.feedKey === 'stock-insights') return stripReplyPrefix(item.title).startsWith('*');
  return stripHtml(item.description).length >= minLength;
}

function extractTopicUrl(link: string): string | null {
  const match = link.match(/(https:\/\/logicalinvestor\.net\/forums\/topic\/[^/#]+\/)/);
  return match ? match[1] : null;
}

function stripReplyPrefix(title: string): string {
  return title.startsWith('Reply To: ') ? title.slice(10).trim() : title.trim();
}

function shouldTrackTopic(topicTitle: string, feedKey: FeedKey): boolean {
  if (feedKey === 'stock-insights') return topicTitle.startsWith('*');
  return true; // track all Members Forum topics
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
