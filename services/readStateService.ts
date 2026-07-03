import { storageGetObject, storageSetObject } from './storageService';
import { FeedKey, FeedResult } from './feedService';

const READ_KEY = 'read_post_ids';

async function getReadIds(): Promise<Set<string>> {
  const arr = await storageGetObject<string[]>(READ_KEY);
  return new Set(arr ?? []);
}

export async function isRead(id: string): Promise<boolean> {
  const ids = await getReadIds();
  return ids.has(id);
}

export async function markRead(id: string): Promise<void> {
  const ids = await getReadIds();
  ids.add(id);
  await storageSetObject(READ_KEY, Array.from(ids));
}

export async function markAllRead(ids: string[]): Promise<void> {
  const existing = await getReadIds();
  ids.forEach((id) => existing.add(id));
  await storageSetObject(READ_KEY, Array.from(existing));
}

export async function getUnreadCount(ids: string[]): Promise<number> {
  const readIds = await getReadIds();
  return ids.filter((id) => !readIds.has(id)).length;
}

// Badge counts only ever get checked for > 0 (tab red-dot, landing-tab pick —
// see app/(tabs)/_layout.tsx and index.tsx), so this is a plain per-feed
// count from the raw item window, not a topic/subscription-aware sum.
// ForumFeed computes the precise number once its tab is actually visited.
export async function computeFeedUnreadCounts(
  results: FeedResult[]
): Promise<Partial<Record<FeedKey, number>>> {
  const counts: Partial<Record<FeedKey, number>> = {};
  for (const result of results) {
    if (!result.accessible) continue;
    counts[result.feedKey] = await getUnreadCount(result.items.map((i) => i.id));
  }
  return counts;
}
