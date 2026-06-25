import * as Notifications from 'expo-notifications';
import { stripHtml, stripReplyPrefix, formatTitle, matchesLevel, containsActionableSignal, MAX_SEEN_IDS, type FilterItem, type NotifLevel } from '@li/core';
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
    trigger: delaySecs ? { type: Notifications.SchedulableTriggerInputTypes.TIME_INTERVAL, seconds: delaySecs } : null,
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
  return {
    isMembersArea: item.feedKey === 'membersArea',
    isStockInsights: item.feedKey === 'stockInsights',
    author: item.author,
    title: item.title,
    content: item.excerpt,
  };
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
  return text.length >= settings.minContentLength && containsActionableSignal(text);
}

export async function processNewItemsForNotifications(items: FeedItem[]): Promise<void> {
  const seenArr = await storageGetObject<string[]>(SEEN_KEY);
  const seen = new Set(seenArr ?? []);

  // First run: seed current items as seen without notifying (avoids flood on install)
  if (seen.size === 0) {
    await storageSetObject(SEEN_KEY, items.map((i) => i.id));
    return;
  }

  const newItems = items.filter((item) => !seen.has(item.id));
  items.forEach((item) => seen.add(item.id));
  const seenList = Array.from(seen);
  await storageSetObject(SEEN_KEY, seenList.slice(-MAX_SEEN_IDS));

  if (newItems.length === 0) return;

  const settings = await getNotificationSettings();
  if (!settings.enabled) return;

  const pushLevel = await getPushLevel();
  const toNotify = newItems
    .filter((item) => !wouldServerPush(item, pushLevel) && passes(item, settings))
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
      trigger: null,
    });
  }
}
