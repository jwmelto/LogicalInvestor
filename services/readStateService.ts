import { storageGetObject, storageSetObject } from './storageService';

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
