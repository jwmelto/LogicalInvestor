import { Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

let CloudSettings: any = null;
try {
  CloudSettings = require('@nauverse/expo-cloud-settings');
} catch (e) {
  // CloudSettings not available (e.g., in simulator without proper native build)
}

const useICloud = Platform.OS === 'ios';

export async function storageGet(key: string): Promise<string | null> {
  if (useICloud && CloudSettings) {
    return CloudSettings.getString(key) ?? null;
  }
  return AsyncStorage.getItem(key);
}

export async function storageSet(key: string, value: string): Promise<void> {
  if (useICloud && CloudSettings) {
    CloudSettings.setString(key, value);
    return;
  }
  await AsyncStorage.setItem(key, value);
}

export async function storageRemove(key: string): Promise<void> {
  if (useICloud && CloudSettings) {
    CloudSettings.remove(key);
    return;
  }
  await AsyncStorage.removeItem(key);
}

export async function storageGetObject<T>(key: string): Promise<T | null> {
  if (useICloud && CloudSettings) {
    return (CloudSettings.getObject(key) as T | null) ?? null;
  }
  const val = await AsyncStorage.getItem(key);
  return val ? JSON.parse(val) : null;
}

export async function storageSetObject<T>(key: string, value: T): Promise<void> {
  if (useICloud && CloudSettings) {
    CloudSettings.setObject(key, value as object);
    return;
  }
  await AsyncStorage.setItem(key, JSON.stringify(value));
}

// Display preferences
export async function getHideSnippetOnRead(): Promise<boolean> {
  const val = await storageGet('hideSnippetOnRead');
  return val === 'true';
}

export async function setHideSnippetOnRead(value: boolean): Promise<void> {
  await storageSet('hideSnippetOnRead', value ? 'true' : 'false');
}

// Forum visibility preferences
export interface ForumVisibility {
  stockInsights: boolean;
  optionsInsights: boolean;
  // membersForum and membersArea are always on (not stored)
}

const DEFAULT_FORUM_VISIBILITY: ForumVisibility = {
  stockInsights: false,
  optionsInsights: false,
};

export async function getForumVisibility(): Promise<ForumVisibility> {
  const stored = await storageGetObject<ForumVisibility>('forumVisibility');
  return stored ?? DEFAULT_FORUM_VISIBILITY;
}

export async function setForumVisibility(visibility: ForumVisibility): Promise<void> {
  await storageSetObject('forumVisibility', visibility);
}

// Keys made obsolete by the topic-store/read-state redesign (slug-based topic ids, unified
// scope_guids read-state — see readStateService.ts). Safe to call on every launch: removing an
// already-absent key is a no-op, so no "have I migrated" flag is needed. An orphaned
// topic_id_subscriptions entry isn't just inert — it would render in Settings' "Silenced Topics"
// list as an entry for a topic that no longer exists under the new id scheme, so this is an
// active sweep, not just "stop writing to these."
const OBSOLETE_KEYS = [
  'read_post_ids',          // superseded by scope_guids
  'cached_unread_counts',   // superseded by scope_guids + on-demand hasUnread()
  'discovered_topics',      // pre-v2 topics key, already dead before this change
  'discovered_topics_v2',   // superseded by discovered_topics_v3 (title-based topic ids)
  'topic_id_subscriptions', // entries keyed by old title-based topic ids, all invalid now
  'topic_expanded_membersForum',
  'topic_expanded_stockInsights',
  'topic_expanded_optionsInsights',
];

export async function cleanupObsoleteStorage(): Promise<void> {
  await Promise.all(OBSOLETE_KEYS.map((key) => storageRemove(key)));
}

const LAST_TAB_KEY = 'last_opened_tab';

export async function getLastOpenedTab(): Promise<string | null> {
  return storageGet(LAST_TAB_KEY);
}

export async function setLastOpenedTab(feedKey: string): Promise<void> {
  await storageSet(LAST_TAB_KEY, feedKey);
}

// Background refresh interval (in minutes, 1-120)
const DEFAULT_REFRESH_INTERVAL = 30;
const MIN_REFRESH_INTERVAL = 1;
const MAX_REFRESH_INTERVAL = 120;

export async function getRefreshInterval(): Promise<number> {
  const val = await storageGet('refreshInterval');
  if (!val) return DEFAULT_REFRESH_INTERVAL;
  const parsed = parseInt(val, 10);
  if (isNaN(parsed) || parsed < MIN_REFRESH_INTERVAL || parsed > MAX_REFRESH_INTERVAL) {
    return DEFAULT_REFRESH_INTERVAL;
  }
  return parsed;
}

export async function setRefreshInterval(minutes: number): Promise<void> {
  const rounded = Math.round(minutes);
  if (rounded < MIN_REFRESH_INTERVAL || rounded > MAX_REFRESH_INTERVAL) {
    throw new Error(`Refresh interval must be between ${MIN_REFRESH_INTERVAL} and ${MAX_REFRESH_INTERVAL} minutes.`);
  }
  await storageSet('refreshInterval', rounded.toString());
}
