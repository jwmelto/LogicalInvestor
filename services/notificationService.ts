import * as Notifications from 'expo-notifications';
import type { FeedItem } from './feedService';
import { storageGetObject, storageSetObject } from './storageService';
import { getPushLevel, type PushLevel } from './pushService';

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
const MAX_SEEN_IDS = 500; // ~20x the largest feed window (~25 items)

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

function formatTitle(item: FeedItem): string {
  const author = item.author ?? 'New post';
  const title = item.title ?? '';
  const topic = title.startsWith('Reply To: ') ? title.slice(10).trim() : title;
  return topic ? `${author} in ${topic}:` : author;
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]*>/g, '').replace(/&[^;]+;/g, ' ').replace(/\s+/g, ' ').trim();
}

// ponytail: mirrors matchesLevel() in cloudflare-worker/src/index.ts — update both if AUTHOR_FILTER or MIN_CONTENT_LENGTH changes
function wouldServerPush(item: FeedItem, level: PushLevel): boolean {
  if (item.feedKey === 'membersArea') return true;
  if (level === 'minimal') return false;
  if (!item.author?.toLowerCase().includes('sean hyman')) return false;
  if (level === 'all') return true;
  // standard
  if (item.feedKey === 'stockInsights') {
    const topic = item.title?.startsWith('Reply To: ') ? item.title.slice(10).trim() : item.title ?? '';
    return topic.startsWith('*');
  }
  return stripHtml(item.excerpt ?? '').length >= 200;
}

function passes(item: FeedItem, settings: NotificationSettings): boolean {
  if (settings.authorFilters.length > 0) {
    const author = item.author?.toLowerCase() ?? '';
    if (!settings.authorFilters.some((f) => author.includes(f.toLowerCase()))) return false;
  }
  return stripHtml(item.excerpt ?? '').length >= settings.minContentLength;
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
