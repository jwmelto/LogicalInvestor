import { XMLParser } from 'fast-xml-parser';
import { extractRssItems } from '@li/core';
import { getToken } from './authService';
import { updateTopicsFromFeedItems } from './topicService';

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
});

export const FEEDS = {
  membersArea: {
    name: 'Members Area',
    route: 'members-area',
    url: 'https://logicalinvestor.net/feed/',
    priority: 'high',
    alwaysVisible: true,
    hasSubFeeds: false,
  },
  membersForum: {
    name: 'Members Forum',
    route: 'members-forum',
    url: 'https://logicalinvestor.net/forums/forum/members-forum/feed/',
    priority: 'normal',
    alwaysVisible: true,
    hasSubFeeds: true,
  },
  stockInsights: {
    name: 'Stock Insights',
    route: 'stock-insights',
    url: 'https://logicalinvestor.net/forums/forum/stock-insights/feed/',
    priority: 'normal',
    alwaysVisible: false,
    hasSubFeeds: true,
  },
  optionsInsights: {
    name: 'Options Insights',
    route: 'options-insights',
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
    const items: FeedItem[] = extractRssItems(parser.parse(xml)).map((rssItem) => ({
      id: rssItem.guid ?? Math.random().toString(), // extractRssItems already falls back to link
      title: rssItem.title ?? 'Untitled',
      link: rssItem.link ?? '',
      pubDate: rssItem.pubDate ?? '',
      author: rssItem.author,
      excerpt: rssItem.contentEncoded ?? rssItem.description,
      feedName: feed.name,
      feedKey,
    }));

    // Topic discovery is best-effort — never let it discard fetched items
    if (feed.hasSubFeeds) {
      try {
        await updateTopicsFromFeedItems(items, feedKey);
      } catch (e: any) {
        if (__DEV__) console.warn(`[feedService] topic discovery failed for ${feedKey}:`, e.message);
      }
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
    return extractRssItems(parser.parse(xml)).map((rssItem) => ({
      id: rssItem.guid ?? Math.random().toString(), // extractRssItems already falls back to link
      title: rssItem.title ?? 'Untitled',
      link: rssItem.link ?? '',
      pubDate: rssItem.pubDate ?? '',
      author: rssItem.author,
      excerpt: rssItem.contentEncoded ?? rssItem.description,
      feedName: rssItem.title ?? 'Topic',
      feedKey: 'membersForum' as FeedKey,
    }));

  } catch {
    return [];
  }
}
