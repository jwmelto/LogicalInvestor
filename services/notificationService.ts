import * as Notifications from 'expo-notifications';
import type { FeedItem } from './feedService';
import { storageGetObject, storageSetObject } from './storageService';

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
export async function fireTestNotification(items: FeedItem[]): Promise<void> {
  const settings = await getNotificationSettings();
  const match = items.find((item) => passes(item, settings));
  if (!match) return;
  const body = stripHtml(match.excerpt ?? '').slice(0, 150);
  await Notifications.scheduleNotificationAsync({
    content: { title: `[TEST] ${formatTitle(match)}`, body: body || match.feedName, data: { link: match.link } },
    trigger: null,
  });
}

export async function addNotificationAuthor(author: string): Promise<void> {
  const settings = await getNotificationSettings();
  if (!settings.authorFilters.includes(author)) {
    await saveNotificationSettings({ ...settings, authorFilters: [...settings.authorFilters, author] });
  }
}

function formatTitle(item: FeedItem): string {
  const author = item.author ?? 'New post';
  const title = item.title ?? '';
  const topic = title.startsWith('Reply To: ') ? title.slice(10).trim() : title;
  return topic ? `${author} in ${topic}:` : author;
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]*>/g, '').replace(/&[^;]+;/g, ' ').replace(/\s+/g, ' ').trim();
}

function passes(item: FeedItem, settings: NotificationSettings): boolean {
  if (settings.authorFilters.length > 0) {
    const author = item.author?.toLowerCase() ?? '';
    if (!settings.authorFilters.some((f) => author.includes(f.toLowerCase()))) return false;
  }
  if (settings.minContentLength > 0) {
    return stripHtml(item.excerpt ?? '').length >= settings.minContentLength;
  }
  return true;
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
  await storageSetObject(SEEN_KEY, Array.from(seen));

  if (newItems.length === 0) return;

  const settings = await getNotificationSettings();
  if (!settings.enabled) return;

  const toNotify = newItems.filter((item) => passes(item, settings)).slice(0, 5);

  for (const item of toNotify) {
    const body = stripHtml(item.excerpt ?? '').slice(0, 150);
    await Notifications.scheduleNotificationAsync({
      content: {
        title: formatTitle(item),
        body: body || item.feedName,
        data: { link: item.link },
      },
      trigger: null,
    });
  }
}
