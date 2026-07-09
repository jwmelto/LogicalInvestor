import { Platform } from 'react-native';
import * as Notifications from 'expo-notifications';
import { formatTitle, isFresh, matchesLevel, MAX_SEEN_IDS_PER_FEED, type FilterItem, type NotifLevel, type RssItem } from '@li/core';
import { FEEDS } from './feedService';
import { storageGetObject, storageSetObject } from './storageService';
import { getPushLevel } from './pushService';
import { isTopicSubscribed } from './subscriptionService';
import { generateTopicId } from './topicService';

// Android requires every notification to belong to a channel (created once in app/_layout.tsx
// via setNotificationChannelAsync); iOS has no channel concept, so trigger.channelId is ignored
// there and a `null` trigger just fires immediately.
export const FEED_ALERTS_CHANNEL_ID = 'feed-alerts';

export interface NotificationSettings {
  enabled: boolean;
  authorFilters: string[];  // case-insensitive substring whitelist; empty = all authors
  minContentLength: number; // minimum char count after stripping HTML; 0 = no minimum
}

export const DEFAULT_NOTIFICATION_SETTINGS: NotificationSettings = {
  enabled: true,
  authorFilters: ['Sean'],
  minContentLength: 200,
};

const SETTINGS_KEY = 'notification_settings';
const SEEN_KEY = 'notification_seen_ids';

export async function getNotificationSettings(): Promise<NotificationSettings> {
  const stored = await storageGetObject<Partial<NotificationSettings>>(SETTINGS_KEY);
  return { ...DEFAULT_NOTIFICATION_SETTINGS, ...stored };
}

export async function saveNotificationSettings(settings: NotificationSettings): Promise<void> {
  await storageSetObject(SETTINGS_KEY, settings);
}

// Fires one notification for the first item passing the current filters, ignoring seen state.
export async function fireTestNotification(items: RssItem[], delaySecs?: number): Promise<void> {
  const settings = await getNotificationSettings();
  const match = items.find((item) => passes(item, settings));
  if (!match) return;
  const body = match.description.slice(0, 150);
  await Notifications.scheduleNotificationAsync({
    content: { title: `[TEST] ${formatTitle(match)}`, body: body || FEEDS[match.feedKey].name, sound: true, data: { link: match.link } },
    trigger: delaySecs
      ? { type: Notifications.SchedulableTriggerInputTypes.TIME_INTERVAL, seconds: delaySecs, channelId: FEED_ALERTS_CHANNEL_ID }
      : (Platform.OS === 'android' ? { channelId: FEED_ALERTS_CHANNEL_ID } : null),
  });
}

export async function addNotificationAuthor(author: string): Promise<void> {
  const settings = await getNotificationSettings();
  if (!settings.authorFilters.includes(author)) {
    await saveNotificationSettings({ ...settings, authorFilters: [...settings.authorFilters, author] });
  }
}

const SERVER_AUTHOR_FILTER = 'sean hyman';
const SERVER_MIN_LENGTH = 200;

function toFilterItem(item: RssItem): FilterItem {
  return { feedKey: item.feedKey, author: item.author, title: item.title, content: item.description };
}

function wouldServerPush(item: RssItem, level: NotifLevel): boolean {
  return matchesLevel(toFilterItem(item), level, SERVER_AUTHOR_FILTER, SERVER_MIN_LENGTH);
}

function passes(item: RssItem, settings: NotificationSettings): boolean {
  if (settings.authorFilters.length > 0) {
    const author = item.author.toLowerCase();
    if (!settings.authorFilters.some((f) => author.includes(f.toLowerCase()))) return false;
  }
  const text = item.description;
  return text.length >= settings.minContentLength;
}

async function isTopicMuted(item: RssItem): Promise<boolean> {
  if (!FEEDS[item.feedKey]?.hasSubFeeds) return false; // flat feeds (Members Area) have no topics
  const topicId = generateTopicId(item.feedKey, item.title); // title is already normalized
  return !(await isTopicSubscribed(topicId, item.feedKey));
}

// ponytail: background fetch is opportunistic and can go dormant for days (see
// backgroundFetchService.ts); without this bound, the first foreground check after a long gap
// would notify for a whole backlog at once. Bump if 48h proves too tight for real usage patterns.
const MAX_NOTIFICATION_AGE_MS = 48 * 60 * 60 * 1000;

export async function processNewItemsForNotifications(items: RssItem[]): Promise<void> {
  const stored = await storageGetObject<unknown>(SEEN_KEY);
  // Migrate: old format was string[], new is Record<feedKey, string[]>
  const seenMap: Partial<Record<string, string[]>> =
    (stored && !Array.isArray(stored) && typeof stored === 'object')
      ? (stored as Partial<Record<string, string[]>>)
      : {};

  const byFeed: Partial<Record<string, RssItem[]>> = {};
  for (const item of items) {
    (byFeed[item.feedKey] ??= []).push(item);
  }

  const newItems: RssItem[] = [];
  for (const [feedKey, feedItems] of Object.entries(byFeed) as [string, RssItem[]][]) {
    const seen = new Set(seenMap[feedKey] ?? []);
    if (seen.size === 0) {
      // First run for this feed: seed without notifying
      seenMap[feedKey] = feedItems.map((i) => i.guid).slice(-MAX_SEEN_IDS_PER_FEED);
      continue;
    }
    const newForFeed = feedItems.filter((i) => !seen.has(i.guid));
    feedItems.forEach((i) => seen.add(i.guid));
    seenMap[feedKey] = Array.from(seen).slice(-MAX_SEEN_IDS_PER_FEED);
    newItems.push(...newForFeed);
  }

  await storageSetObject(SEEN_KEY, seenMap);
  if (newItems.length === 0) return;

  const settings = await getNotificationSettings();
  if (!settings.enabled) return;

  const pushLevel = await getPushLevel();
  // Skip the local notification whenever the Worker's server push would already cover this
  // item — one alert per item, not two.
  const eligible = newItems.filter(
    (item) => !wouldServerPush(item, pushLevel) && passes(item, settings) && isFresh(item.pubDate, MAX_NOTIFICATION_AGE_MS)
  );
  const muted = await Promise.all(eligible.map(isTopicMuted));
  const toNotify = eligible.filter((_, i) => !muted[i]).slice(0, 5);

  for (const item of toNotify) {
    const body = item.description.slice(0, 150);
    await Notifications.scheduleNotificationAsync({
      content: {
        title: `[LOCAL] ${formatTitle(item)}`,
        body: body || FEEDS[item.feedKey].name,
        sound: true,
        data: { link: item.link },
      },
      trigger: Platform.OS === 'android' ? { channelId: FEED_ALERTS_CHANNEL_ID } : null,
    });
  }
}
