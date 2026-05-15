import { storageGetObject, storageSetObject } from './storageService';
import { FeedKey } from './feedService';

// Legacy topic URL subscriptions (deprecated, kept for backwards compatibility)
const LEGACY_SUBS_KEY = 'topic_subscriptions';

// New topic ID subscriptions: { [topicId]: boolean }
const TOPIC_SUBS_KEY = 'topic_id_subscriptions';

// Forum default preferences: { [forumKey]: boolean }
// true = auto-subscribe new topics, false = auto-unsubscribe new topics
const FORUM_DEFAULTS_KEY = 'forum_default_subscriptions';

// ============================================================================
// LEGACY: Topic URL subscriptions (deprecated)
// ============================================================================

async function getLegacySubscriptions(): Promise<Record<string, boolean>> {
  return (await storageGetObject<Record<string, boolean>>(LEGACY_SUBS_KEY)) ?? {};
}

export async function isSubscribed(topicUrl: string): Promise<boolean> {
  const subs = await getLegacySubscriptions();
  // Default to true if we've never seen this topic before
  return subs[topicUrl] ?? true;
}

export async function setSubscribed(topicUrl: string, subscribed: boolean): Promise<void> {
  const subs = await getLegacySubscriptions();
  subs[topicUrl] = subscribed;
  await storageSetObject(LEGACY_SUBS_KEY, subs);
}

export async function getAllSubscriptions(): Promise<Record<string, boolean>> {
  return getLegacySubscriptions();
}

// ============================================================================
// NEW: Topic ID subscriptions
// ============================================================================

async function getTopicIdSubscriptions(): Promise<Record<string, boolean>> {
  return (await storageGetObject<Record<string, boolean>>(TOPIC_SUBS_KEY)) ?? {};
}

/**
 * Check if a topic (by ID) is subscribed.
 *
 * Defaults to the forum's default preference if topic has never been explicitly set.
 */
export async function isTopicSubscribed(
  topicId: string,
  forumKey: FeedKey
): Promise<boolean> {
  const subs = await getTopicIdSubscriptions();
  if (topicId in subs) {
    return subs[topicId];
  }
  // Fall back to forum default
  return getForumDefaultSubscription(forumKey);
}

/**
 * Set subscription status for a specific topic.
 */
export async function setTopicSubscription(
  topicId: string,
  subscribed: boolean
): Promise<void> {
  const subs = await getTopicIdSubscriptions();
  subs[topicId] = subscribed;
  await storageSetObject(TOPIC_SUBS_KEY, subs);
}

/**
 * Get all topic ID subscriptions.
 */
export async function getAllTopicSubscriptions(): Promise<Record<string, boolean>> {
  return getTopicIdSubscriptions();
}

// ============================================================================
// Forum Default Preferences
// ============================================================================

async function getForumDefaults(): Promise<Record<string, boolean>> {
  return (await storageGetObject<Record<string, boolean>>(FORUM_DEFAULTS_KEY)) ?? {};
}

/**
 * Get the default subscription preference for a forum.
 *
 * Defaults to true (subscribe new topics) if not explicitly set.
 */
export async function getForumDefaultSubscription(forumKey: FeedKey): Promise<boolean> {
  const defaults = await getForumDefaults();
  return defaults[forumKey] ?? true;
}

/**
 * Set the default subscription preference for a forum.
 */
export async function setForumDefaultSubscription(
  forumKey: FeedKey,
  defaultToSubscribed: boolean
): Promise<void> {
  const defaults = await getForumDefaults();
  defaults[forumKey] = defaultToSubscribed;
  await storageSetObject(FORUM_DEFAULTS_KEY, defaults);
}

/**
 * Get all forum default preferences.
 */
export async function getAllForumDefaults(): Promise<Record<string, boolean>> {
  return getForumDefaults();
}
