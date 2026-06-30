import { Platform } from 'react-native';
import * as Notifications from 'expo-notifications';
import { stripHtml, formatTitle, matchesLevel, MAX_SEEN_IDS_PER_FEED, type FilterItem, type NotifLevel } from '@li/core';
import type { FeedItem } from './feedService';
import { storageGetObject, storageSetObject } from './storageService';
import { getPushLevel } from './pushService';

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
export async function fireTestNotification(items: FeedItem[], delaySecs?: number): Promise<void> {
  const settings = await getNotificationSettings();
  const match = items.find((item) => passes(item, settings));
  if (!match) return;
  const body = stripHtml(match.excerpt ?? '').slice(0, 150);
  await Notifications.scheduleNotificationAsync({
    content: { title: `[TEST] ${formatTitle(match)}`, body: body || match.feedName, sound: true, data: { link: match.link } },
    trigger: delaySecs
      ? { type: Notifications.SchedulableTriggerInputTypes.TIME_INTERVAL, seconds: delaySecs, channelId: 'feed-alerts' }
      : (Platform.OS === 'android' ? { channelId: 'feed-alerts' } : null),
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

function toFilterItem(item: FeedItem): FilterItem {
  return { feedKey: item.feedKey, author: item.author, title: item.title, content: item.excerpt };
}

function wouldServerPush(item: FeedItem, level: NotifLevel): boolean {
  return matchesLevel(toFilterItem(item), level, SERVER_AUTHOR_FILTER, SERVER_MIN_LENGTH);
}

function passes(item: FeedItem, settings: NotificationSettings): boolean {
  if (settings.authorFilters.length > 0) {
    const author = item.author?.toLowerCase() ?? '';
    if (!settings.authorFilters.some((f) => author.includes(f.toLowerCase()))) return false;
  }
  const text = stripHtml(item.excerpt ?? '');
  return text.length >= settings.minContentLength;
}

export async function processNewItemsForNotifications(items: FeedItem[]): Promise<void> {
  const stored = await storageGetObject<unknown>(SEEN_KEY);
  // Migrate: old format was string[], new is Record<feedKey, string[]>
  const seenMap: Partial<Record<string, string[]>> =
    (stored && !Array.isArray(stored) && typeof stored === 'object')
      ? (stored as Partial<Record<string, string[]>>)
      : {};

  const byFeed: Partial<Record<string, FeedItem[]>> = {};
  for (const item of items) {
    (byFeed[item.feedKey] ??= []).push(item);
  }

  const newItems: FeedItem[] = [];
  for (const [feedKey, feedItems] of Object.entries(byFeed) as [string, FeedItem[]][]) {
    const seen = new Set(seenMap[feedKey] ?? []);
    if (seen.size === 0) {
      // First run for this feed: seed without notifying
      seenMap[feedKey] = feedItems.map((i) => i.id).slice(-MAX_SEEN_IDS_PER_FEED);
      continue;
    }
    const newForFeed = feedItems.filter((i) => !seen.has(i.id));
    feedItems.forEach((i) => seen.add(i.id));
    seenMap[feedKey] = Array.from(seen).slice(-MAX_SEEN_IDS_PER_FEED);
    newItems.push(...newForFeed);
  }

  await storageSetObject(SEEN_KEY, seenMap);
  if (newItems.length === 0) return;

  const settings = await getNotificationSettings();
  if (!settings.enabled) return;

  const pushLevel = await getPushLevel();
  const toNotify = newItems
    .filter((item) => (Platform.OS !== 'ios' || !wouldServerPush(item, pushLevel)) && passes(item, settings))
    .slice(0, 5);

  for (const item of toNotify) {
    const body = stripHtml(item.excerpt ?? '').slice(0, 150);
    await Notifications.scheduleNotificationAsync({
      content: {
        title: formatTitle(item),
        body: body || item.feedName,
        sound: true,
        data: { link: item.link },
      },
      trigger: Platform.OS === 'android' ? { channelId: 'feed-alerts' } : null,
    });
  }
}
