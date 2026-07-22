import { XMLParser } from 'fast-xml-parser';
import { extractRssItems, type RssItem, type FeedKey } from '@li/core';
import { getToken } from './authService';
import { updateTopicsFromFeedItems } from './topicService';
import type { ForumVisibility } from './storageService';

export type { RssItem, FeedKey };

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
});

// isVisible answers "is this feed's tab currently shown at all" — distinct from having zero
// items (which just means "not subscribed"). Members Area/Members Forum aren't togglable, so
// their isVisible ignores the argument entirely; Stock/Options Insights defer to the user's
// stored preference. Each feed owns the answer to its own question rather than a shared function
// having to special-case every key.
// optional marks a feed as subscription-gated. The site's RSS always returns the forum's last 25
// posts to anyone with access — there's no such thing as a legitimately empty feed — so for these,
// zero items (with no fetch error) is unconditional proof the user isn't subscribed, not a guess.
// Members Area/Members Forum come with every membership; Stock/Options Insights are paid add-ons.
export const FEEDS = {
  membersArea: {
    name: 'Members Area',
    route: 'members-area',
    url: 'https://logicalinvestor.net/feed/',
    hasSubFeeds: false,
    optional: false,
    isVisible: (_visibility: ForumVisibility) => true,
  },
  membersForum: {
    name: 'Members Forum',
    route: 'members-forum',
    url: 'https://logicalinvestor.net/forums/forum/members-forum/feed/',
    hasSubFeeds: true,
    optional: false,
    isVisible: (_visibility: ForumVisibility) => true,
  },
  stockInsights: {
    name: 'Stock Insights',
    route: 'stock-insights',
    url: 'https://logicalinvestor.net/forums/forum/stock-insights/feed/',
    hasSubFeeds: true,
    optional: true,
    isVisible: (visibility: ForumVisibility) => visibility.stockInsights,
  },
  optionsInsights: {
    name: 'Options Insights',
    route: 'options-insights',
    url: 'https://logicalinvestor.net/forums/forum/options-insights/feed/',
    hasSubFeeds: true,
    optional: true,
    isVisible: (visibility: ForumVisibility) => visibility.optionsInsights,
  },
} as const satisfies Record<FeedKey, {
  name: string;
  route: string;
  url: string;
  hasSubFeeds: boolean;
  optional: boolean;
  isVisible: (visibility: ForumVisibility) => boolean;
}>;

export interface FeedResult {
  feedKey: FeedKey;
  items: RssItem[];
  error?: string;
}

async function fetchFeed(feedKey: FeedKey): Promise<FeedResult> {
  const token = await getToken();
  const feed = FEEDS[feedKey];
  const url = `${feed.url}?feed_token=${token}`;

  try {
    const response = await fetch(url);

    if (!response.ok) {
      return { feedKey, items: [], error: `HTTP ${response.status}` };
    }

    const xml = await response.text();
    const items: RssItem[] = extractRssItems(parser.parse(xml)).map((rssItem) => ({ ...rssItem, feedKey }));

    // Topic discovery is best-effort — never let it discard fetched items
    if (feed.hasSubFeeds) {
      try {
        await updateTopicsFromFeedItems(items, feedKey);
      } catch (e: any) {
        if (__DEV__) console.warn(`[feedService] topic discovery failed for ${feedKey}:`, e.message);
      }
    }

    return { feedKey, items };
  } catch (e: any) {
    return { feedKey, items: [], error: e.message };
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

export async function fetchTopicFeed(topicUrl: string, feedKey: FeedKey): Promise<RssItem[]> {
  const token = await getToken();
  const feedUrl = `${topicUrl.replace(/\/?$/, '/')  }feed/?feed_token=${token}`;

  try {
    const response = await fetch(feedUrl);
    if (!response.ok) return [];

    const xml = await response.text();
    return extractRssItems(parser.parse(xml)).map((rssItem) => ({ ...rssItem, feedKey }));
  } catch {
    return [];
  }
}
