import * as Notifications from 'expo-notifications';
import Constants from 'expo-constants';
import { storageGet, storageSet } from './storageService';
import { getToken } from './authService';
import { FEEDKEY_TO_CHANNEL, ChannelNames } from '@li/core';
import type { FeedKey, ContentFilter, Channel } from '@li/core';
export type { ContentFilter };

// Android requires every notification to belong to a channel (created once in app/_layout.tsx
// via setNotificationChannelAsync) — applies to push notifications same as local ones. iOS has
// no channel concept, so this is ignored there.
export const FEED_ALERTS_CHANNEL_ID = 'feed-alerts';

// Mandatory value; missing is a fatal configuration error.
const rawWorkerUrl = Constants.expoConfig?.extra?.workerUrl as string | undefined;
if (!rawWorkerUrl) {
  throw new Error('pushService: app.json is missing extra.workerUrl');
}
const WORKER_URL: string = rawWorkerUrl;
const PUSH_FILTER_KEY = 'push_filter';
const PUSH_AUTHORS_KEY = 'push_authors';
const PUSH_MIN_LENGTH_KEY = 'push_min_length';
const PUSH_CHANNELS_KEY = 'push_channels';

// App-side pre-fill defaults only, for a device's first-ever registration. The Worker itself has
// no fallback for missing filter/authors/minLength — every registration carries concrete values.
const DEFAULT_FILTER: ContentFilter = 'actionable';
const DEFAULT_AUTHORS: string[] = ['Sean'];
const DEFAULT_MIN_LENGTH = 200;

export interface PushFilterSettings {
  filter: ContentFilter;
  authors: string[];
  minLength: number;
}

async function getExpoPushToken(): Promise<string | null> {
  const projectId = Constants.expoConfig?.extra?.eas?.projectId;
  if (!projectId) {
    if (__DEV__) console.warn('pushService: EAS projectId missing — push tokens will not be registered. Add extra.eas.projectId to app.json.');
    return null;
  }
  const { status } = await Notifications.getPermissionsAsync();
  if (status !== 'granted') return null;
  const { data } = await Notifications.getExpoPushTokenAsync({ projectId });
  return data;
}

export async function getPushFilter(): Promise<ContentFilter> {
  const val = await storageGet(PUSH_FILTER_KEY);
  return (val as ContentFilter | null) ?? DEFAULT_FILTER;
}

export async function getPushAuthors(): Promise<string[]> {
  const val = await storageGet(PUSH_AUTHORS_KEY);
  return val ? JSON.parse(val) : DEFAULT_AUTHORS;
}

export async function getPushMinLength(): Promise<number> {
  const val = await storageGet(PUSH_MIN_LENGTH_KEY);
  return val !== null ? parseInt(val, 10) : DEFAULT_MIN_LENGTH;
}

async function currentPushSettings(): Promise<PushFilterSettings> {
  const [filter, authors, minLength] = await Promise.all([getPushFilter(), getPushAuthors(), getPushMinLength()]);
  return { filter, authors, minLength };
}

async function getRegisteredChannels(): Promise<Channel[]> {
  const val = await storageGet(PUSH_CHANNELS_KEY);
  return val ? JSON.parse(val) : [];
}

async function addRegisteredChannel(channel: Channel): Promise<void> {
  const current = await getRegisteredChannels();
  if (!current.includes(channel)) {
    await storageSet(PUSH_CHANNELS_KEY, JSON.stringify([...current, channel]));
  }
}

// Called by ForumFeed after first successful load of an accessible feed.
// Sends feed_token so the Worker can use it to poll optional channel feeds.
// Returns whether the server confirmed registration, so callers can retry on failure.
export async function registerPushChannel(feedKey: FeedKey, feedToken: string, overrides?: PushFilterSettings): Promise<boolean> {
  try {
    const pushToken = await getExpoPushToken();
    if (!pushToken) return false;
    const channel = FEEDKEY_TO_CHANNEL[feedKey];
    if (!channel) return false;
    const settings = overrides ?? await currentPushSettings();
    const res = await fetch(`${WORKER_URL}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: pushToken, channel, filter: settings.filter, authors: settings.authors, minLength: settings.minLength, feed_token: feedToken }),
    });
    if (!res.ok) return false;
    await addRegisteredChannel(channel);
    return true;
  } catch { return false; /* non-fatal: registration retried on next refresh */ }
}

// Called by Settings when the user changes the filter tier, author whitelist, or min length.
// Persists all three and re-registers every channel the user is enrolled in.
export async function updatePushSettings(settings: PushFilterSettings): Promise<void> {
  try {
    const pushToken = await getExpoPushToken();
    if (!pushToken) return;
    const feedToken = await getToken();
    if (!feedToken) return;
    await storageSet(PUSH_FILTER_KEY, settings.filter);
    await storageSet(PUSH_AUTHORS_KEY, JSON.stringify(settings.authors));
    await storageSet(PUSH_MIN_LENGTH_KEY, String(settings.minLength));
    const channels = await getRegisteredChannels();
    await Promise.all(
      channels.map(channel =>
        fetch(`${WORKER_URL}/register`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: pushToken, channel, filter: settings.filter, authors: settings.authors, minLength: settings.minLength, feed_token: feedToken }),
        })
      )
    );
  } catch { /* non-fatal */ }
}

// Called from ForumFeed's long-press "Add author to alerts" gesture.
export async function addPushAuthor(author: string): Promise<void> {
  const settings = await currentPushSettings();
  if (!settings.authors.includes(author)) {
    await updatePushSettings({ ...settings, authors: [...settings.authors, author] });
  }
}

export async function unregisterPushToken(): Promise<void> {
  try {
    const pushToken = await getExpoPushToken();
    if (!pushToken) return;
    await storageSet(PUSH_CHANNELS_KEY, JSON.stringify([]));
    await Promise.all(
      (Object.values(ChannelNames) as Channel[]).map(channel =>
        fetch(`${WORKER_URL}/unregister`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: pushToken, channel }),
        })
      )
    );
  } catch { /* non-fatal */ }
}
