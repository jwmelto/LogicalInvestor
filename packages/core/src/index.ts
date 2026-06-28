export const MAX_SEEN_IDS = 500;

export type NotifLevel = 'minimal' | 'standard' | 'all';

export interface FilterItem {
  isMembersArea: boolean;
  isStockInsights: boolean;
  author?: string;
  title?: string;
  content?: string;
}

export function stripHtml(html: string): string {
  return html.replace(/<[^>]*>/g, '').replace(/&[^;]+;/g, ' ').replace(/\s+/g, ' ').trim();
}

export function stripReplyPrefix(title: string): string {
  return title.startsWith('Reply To: ') ? title.slice(10).trim() : title.trim();
}

export function formatTitle(item: { author?: string; title?: string }): string {
  const author = (item.author ?? '') || 'New post';
  const topic = stripReplyPrefix(item.title ?? '');
  return topic ? `${author} in ${topic}:` : author;
}

export function matchesLevel(
  item: FilterItem,
  level: NotifLevel,
  authorFilter: string,
  minLength: number,
): boolean {
  if (item.isMembersArea) return true;
  if (level === 'minimal') return false;
  if (!item.author?.toLowerCase().includes(authorFilter.toLowerCase())) return false;
  if (level === 'all') return true;
  if (item.isStockInsights) return stripReplyPrefix(item.title ?? '').startsWith('*');
  return stripHtml(item.content ?? '').length >= minLength;
}
