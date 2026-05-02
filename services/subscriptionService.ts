import { storageGetObject, storageSetObject } from './storageService';

const SUBS_KEY = 'topic_subscriptions';

// Returns a map of topicUrl -> subscribed (true/false)
async function getSubscriptions(): Promise<Record<string, boolean>> {
  return (await storageGetObject<Record<string, boolean>>(SUBS_KEY)) ?? {};
}

export async function isSubscribed(topicUrl: string): Promise<boolean> {
  const subs = await getSubscriptions();
  // Default to true if we've never seen this topic before
  return subs[topicUrl] ?? true;
}

export async function setSubscribed(topicUrl: string, subscribed: boolean): Promise<void> {
  const subs = await getSubscriptions();
  subs[topicUrl] = subscribed;
  await storageSetObject(SUBS_KEY, subs);
}

export async function getAllSubscriptions(): Promise<Record<string, boolean>> {
  return getSubscriptions();
}
