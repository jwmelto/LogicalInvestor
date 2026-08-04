import { XMLParser } from 'fast-xml-parser';
import { extractRssItems, type RssItem, type FeedKey } from '@li/core';
import { getToken } from './authService';
import { updateTopicsFromFeedItems, extractTopicSlugFromLink, generateTopicUrl, deleteTopic, type Topic } from './topicService';
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
export const FEEDS = {
  membersArea: {
    name: 'Members Area',
    route: 'members-area',
    url: 'https://logicalinvestor.net/feed/',
    hasSubFeeds: false,
    isVisible: (_visibility: ForumVisibility) => true,
  },
  membersForum: {
    name: 'Members Forum',
    route: 'members-forum',
    url: 'https://logicalinvestor.net/forums/forum/members-forum/feed/',
    hasSubFeeds: true,
    isVisible: (_visibility: ForumVisibility) => true,
  },
  stockInsights: {
    name: 'Stock Insights',
    route: 'stock-insights',
    url: 'https://logicalinvestor.net/forums/forum/stock-insights/feed/',
    hasSubFeeds: true,
    isVisible: (visibility: ForumVisibility) => visibility.stockInsights,
  },
  optionsInsights: {
    name: 'Options Insights',
    route: 'options-insights',
    url: 'https://logicalinvestor.net/forums/forum/options-insights/feed/',
    hasSubFeeds: true,
    isVisible: (visibility: ForumVisibility) => visibility.optionsInsights,
  },
} as const satisfies Record<FeedKey, {
  name: string;
  route: string;
  url: string;
  hasSubFeeds: boolean;
  isVisible: (visibility: ForumVisibility) => boolean;
}>;

export interface FeedResult {
  feedKey: FeedKey;
  items: RssItem[];
  error?: string;
  // Zero items with no fetch error is unconditional proof of no access — the site's RSS always
  // returns a forum's last 25 posts to anyone with real access.
  isSubscribed(): boolean;
  // True only when the fetch actually succeeded and confirmed zero items — the one case that
  // legitimately means "no access." A fetch error also leaves items empty, so callers that would
  // otherwise treat "isSubscribed() === false" as reason to clear stored state (a badge, a "no
  // access" UI) must use this instead — a transient network failure must never look identical to
  // a real access check.
  hasConfirmedNoAccess(): boolean;
}

function feedResult(feedKey: FeedKey, items: RssItem[], error?: string): FeedResult {
  return {
    feedKey,
    items,
    error,
    isSubscribed: () => items.length > 0,
    hasConfirmedNoAccess: () => !error && items.length === 0,
  };
}

async function fetchFeed(feedKey: FeedKey): Promise<FeedResult> {
  const token = await getToken();
  const feed = FEEDS[feedKey];
  const url = `${feed.url}?feed_token=${token}`;

  try {
    const response = await fetch(url);

    if (!response.ok) {
      return feedResult(feedKey, [], `HTTP ${response.status}`);
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

    return feedResult(feedKey, items);
  } catch (e: any) {
    return feedResult(feedKey, [], e.message);
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

export interface TopicFeedResult {
  items: RssItem[];
  // True when this call detected the topic's own feed URL no longer returns this topic's content
  // and removed it (see deleteTopic). Callers rendering their own copy of this topic need this
  // signal in the same round trip — nothing else tells them storage just changed.
  deleted: boolean;
}

// A dead/deleted topic's permalink doesn't reliably 404 on the /feed/ suffix — confirmed live:
// the bare page 404s (rendering the store page), but appending /feed/ to that same dead URL
// returns 200 with the *Members Forum* feed instead of erroring — not even this topic's own
// parent forum, e.g. a dead Stock Insights topic's /feed/ still comes back as Members Forum.
// A genuine topic feed's items always link back to that same topic, so checking just the first
// returned item is enough proof this isn't topic.slug's feed at all — not a bad item, a wrong
// feed. Delete it outright rather than trusting (even partially) content that isn't this topic's
// — the site itself stops listing a genuinely deleted topic in RSS, so there's no expectation it
// needs to be remembered as dead to avoid rediscovering it; if its id resurfaces, that's just a
// fresh discovery.
export async function fetchTopicFeed(topic: Topic, feedKey: FeedKey): Promise<TopicFeedResult> {
  const token = await getToken();
  const feedUrl = `${generateTopicUrl(topic.slug)}feed/?feed_token=${token}`;

  try {
    const response = await fetch(feedUrl);
    if (!response.ok) return { items: [], deleted: false };

    const xml = await response.text();
    const items = extractRssItems(parser.parse(xml)).map((rssItem) => ({ ...rssItem, feedKey }));

    if (items.length > 0 && extractTopicSlugFromLink(items[0].link) !== topic.slug) {
      await deleteTopic(topic.id);
      return { items: [], deleted: true };
    }

    return { items, deleted: false };
  } catch {
    return { items: [], deleted: false };
  }
}
