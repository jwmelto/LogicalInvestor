import * as Notifications from 'expo-notifications';
import Constants from 'expo-constants';
import { storageGet, storageSet } from './storageService';
import { getToken } from './authService';

const WORKER_URL = 'https://logicalinvestor-push.logicalinvestor.workers.dev';
const PUSH_LEVEL_KEY = 'push_level';
const PUSH_CHANNELS_KEY = 'push_channels';

import { FeedKeys } from '@li/core';
import type { FeedKey, NotifLevel as PushLevel } from '@li/core';
export type { PushLevel };
type Channel = 'members' | 'stock' | 'options';

const FEEDKEY_TO_CHANNEL: Record<FeedKey, Channel> = {
  [FeedKeys.membersArea]:    'members',
  [FeedKeys.membersForum]:   'members',
  [FeedKeys.stockInsights]:  'stock',
  [FeedKeys.optionsInsights]: 'options',
};

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

export async function getPushLevel(): Promise<PushLevel> {
  const val = await storageGet(PUSH_LEVEL_KEY);
  return (val as PushLevel | null) ?? 'standard';
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
export async function registerPushChannel(feedKey: FeedKey, feedToken: string, level?: PushLevel): Promise<void> {
  try {
    const pushToken = await getExpoPushToken();
    if (!pushToken) return;
    const channel = FEEDKEY_TO_CHANNEL[feedKey];
    if (!channel) return;
    const lvl = level ?? await getPushLevel();
    await storageSet(PUSH_LEVEL_KEY, lvl);
    await addRegisteredChannel(channel);
    await fetch(`${WORKER_URL}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: pushToken, channel, level: lvl, feed_token: feedToken }),
    });
  } catch { /* non-fatal: local notifications still work */ }
}

// Called by Settings when the user changes their notification level.
// Re-registers all channels the user is enrolled in.
export async function updatePushLevel(level: PushLevel): Promise<void> {
  try {
    const pushToken = await getExpoPushToken();
    if (!pushToken) return;
    const feedToken = await getToken();
    if (!feedToken) return;
    await storageSet(PUSH_LEVEL_KEY, level);
    const channels = await getRegisteredChannels();
    await Promise.all(
      channels.map(channel =>
        fetch(`${WORKER_URL}/register`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: pushToken, channel, level, feed_token: feedToken }),
        })
      )
    );
  } catch { /* non-fatal */ }
}

export async function unregisterPushToken(): Promise<void> {
  try {
    const pushToken = await getExpoPushToken();
    if (!pushToken) return;
    await storageSet(PUSH_CHANNELS_KEY, JSON.stringify([]));
    await Promise.all(
      (['members', 'stock', 'options'] as const).map(channel =>
        fetch(`${WORKER_URL}/unregister`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: pushToken, channel }),
        })
      )
    );
  } catch { /* non-fatal */ }
}
