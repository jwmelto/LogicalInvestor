import * as Notifications from 'expo-notifications';
import Constants from 'expo-constants';
import { storageGet, storageSet } from './storageService';

const WORKER_URL = 'https://logicalinvestor-push.logicalinvestor.workers.dev';
const PUSH_LEVEL_KEY = 'push_level';

export type PushLevel = 'minimal' | 'standard' | 'all';

async function getExpoPushToken(): Promise<string | null> {
  const projectId = Constants.expoConfig?.extra?.eas?.projectId;
  if (!projectId) return null;
  const { status } = await Notifications.getPermissionsAsync();
  if (status !== 'granted') return null;
  const { data } = await Notifications.getExpoPushTokenAsync({ projectId });
  return data;
}

export async function getPushLevel(): Promise<PushLevel> {
  const val = await storageGet(PUSH_LEVEL_KEY);
  return (val as PushLevel | null) ?? 'standard';
}

export async function registerPushToken(level?: PushLevel): Promise<void> {
  try {
    const token = await getExpoPushToken();
    if (!token) return;
    const lvl = level ?? await getPushLevel();
    await storageSet(PUSH_LEVEL_KEY, lvl);
    await fetch(`${WORKER_URL}/register?token=${encodeURIComponent(token)}&level=${lvl}`, { method: 'POST' });
  } catch { /* non-fatal: local notifications still work */ }
}

export async function unregisterPushToken(): Promise<void> {
  try {
    const token = await getExpoPushToken();
    if (!token) return;
    await fetch(`${WORKER_URL}/unregister?token=${encodeURIComponent(token)}`, { method: 'POST' });
  } catch { /* non-fatal */ }
}
