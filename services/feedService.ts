import { XMLParser } from 'fast-xml-parser';
import { getToken } from './authService';
import { updateTopicsFromFeedItems } from './topicService';

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
});

export const FEEDS = {
  membersArea: {
    name: 'Members Area',
    url: 'https://logicalinvestor.net/feed/',
    priority: 'high',
    alwaysVisible: true,
    hasSubFeeds: false,
  },
  membersForum: {
    name: 'Members Forum',
    url: 'https://logicalinvestor.net/forums/forum/members-forum/feed/',
    priority: 'normal',
    alwaysVisible: true,
    hasSubFeeds: true,
  },
  stockInsights: {
    name: 'Stock Insights',
    url: 'https://logicalinvestor.net/forums/forum/stock-insights/feed/',
    priority: 'normal',
    alwaysVisible: false,
    hasSubFeeds: true,
  },
  optionsInsights: {
    name: 'Options Insights',
    url: 'https://logicalinvestor.net/forums/forum/options-insights/feed/',
    priority: 'normal',
    alwaysVisible: false,
    hasSubFeeds: true,
  },
/*  investingBasics: {
    name: 'Investing Basics',
    url: 'https://logicalinvestor.net/basic-investing/feed/',
    priority: 'low',
    alwaysVisible: true,
  }, */
} as const;

export type FeedKey = keyof typeof FEEDS;

export interface FeedItem {
  id: string;
  title: string;
  link: string;
  pubDate: string;
  author?: string;
  excerpt?: string;
  feedName: string;
  feedKey: FeedKey;
}

export interface FeedResult {
  feedKey: FeedKey;
  items: FeedItem[];
  accessible: boolean;
  error?: string;
}

async function fetchFeed(feedKey: FeedKey): Promise<FeedResult> {
  const token = await getToken();
  const feed = FEEDS[feedKey];
  const url = `${feed.url}?feed_token=${token}`;

  try {
    const response = await fetch(url);

    if (response.status === 403 || response.status === 401) {
      return { feedKey, items: [], accessible: false };
    }

    if (!response.ok) {
      return { feedKey, items: [], accessible: true, error: `HTTP ${response.status}` };
    }

    const xml = await response.text();
    const parsed = parser.parse(xml);
    const channel = parsed?.rss?.channel;
    const rawItems = Array.isArray(channel?.item)
      ? channel.item
      : channel?.item
      ? [channel.item]
      : [];

    const items: FeedItem[] = rawItems.map((item: any) => ({
      id: item.guid?.['#text'] ?? item.guid ?? item.link ?? Math.random().toString(),
      title: item.title ?? 'Untitled',
      link: item.link ?? '',
      pubDate: item.pubDate ?? '',
      author: item['dc:creator'] ?? item.author,
      excerpt: item['content:encoded'] ?? item.description,
      feedName: feed.name,
      feedKey,
    }));

    // Discover topics from this feed if it has subfeeds
    if (feed.hasSubFeeds) {
      await updateTopicsFromFeedItems(items, feedKey);
    }

    return { feedKey, items, accessible: true };
  } catch (e: any) {
    return { feedKey, items: [], accessible: true, error: e.message };
  }
}

export async function fetchAllFeeds(): Promise<FeedResult[]> {
  const results = await Promise.all(
    (Object.keys(FEEDS) as FeedKey[]).map((key) => fetchFeed(key))
  );
  return results;
}

export async function fetchSingleFeed(feedKey: FeedKey): Promise<FeedResult> {
  return fetchFeed(feedKey);
}

export async function fetchTopicFeed(topicUrl: string): Promise<FeedItem[]> {
  const token = await getToken();
  const feedUrl = `${topicUrl.replace(/\/?$/, '/')  }feed/?feed_token=${token}`;

  try {
    const response = await fetch(feedUrl);
    if (!response.ok) return [];

    const xml = await response.text();
    const parsed = parser.parse(xml);
    const channel = parsed?.rss?.channel;
    const rawItems = Array.isArray(channel?.item)
      ? channel.item
      : channel?.item
      ? [channel.item]
      : [];

    return rawItems.map((item: any) => ({
      id: item.guid?.['#text'] ?? item.guid ?? item.link ?? Math.random().toString(),
      title: item.title ?? 'Untitled',
      link: item.link ?? '',
      pubDate: item.pubDate ?? '',
      author: item['dc:creator'] ?? item.author,
      excerpt: item['content:encoded'] ?? item.description,
      feedName: item.title ?? 'Topic',
      feedKey: 'membersForum' as FeedKey,
    }));

  } catch {
    return [];
  }
}
