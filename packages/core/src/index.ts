export const MAX_SEEN_IDS = 500;

export type NotifLevel = 'none' | 'minimal' | 'standard' | 'all';

export const FeedKeys = {
  membersArea:     'membersArea',
  membersForum:    'membersForum',
  stockInsights:   'stockInsights',
  optionsInsights: 'optionsInsights',
} as const;

export type FeedKey = typeof FeedKeys[keyof typeof FeedKeys];

export interface FilterItem {
  feedKey: FeedKey;
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

// Action patterns: any match signals a buy/sell/entry post worth alerting on.
// Each string is compiled to a case-insensitive RegExp at call time.
// ponytail: tuned on small training set; expect iteration once real-world data arrives.
export const DEFAULT_ACTION_PATTERNS: string[] = [
  '\\bnew pick\\b',
  // Formal tranche price lines: "1st Tranche: $210"
  '\\b(1st|2nd|3rd|4th|first|second|third|fourth)\\s+tranche:\\s*\\$',
  // "get in (a/our/your) ... tranche"
  '\\bget\\s+in\\b[\\s\\S]{0,30}\\btranche\\b',
  // Direct buy/enter with a price nearby
  '\\b(buy|enter)\\b[\\s\\S]{0,60}\\$\\d+',
  // Explicit sell-fraction commands ("sell half", "selling half of your...")
  '\\bsell(?:ing)?\\s+(half|all|a\\s+third|a\\s+quarter|\\d+\\/\\d+)\\b',
  // Averaging down — specific enough on its own; price may precede or follow
  '\\baveraging?\\s+down\\b',
  // All-caps urgency marker Sean uses for immediate entries
  '\\bIMMEDIATELY\\b',
];

export function containsActionableSignal(
  text: string,
  patterns: string[] = DEFAULT_ACTION_PATTERNS,
): boolean {
  return patterns.some((p) => new RegExp(p, 'is').test(text));
}


export function matchesLevel(
  item: FilterItem,
  level: NotifLevel,
  authorFilter: string,
  minLength: number,
  actionPatterns: string[] = DEFAULT_ACTION_PATTERNS,
): boolean {
  if (level === 'none') return false;
  if (item.feedKey === FeedKeys.membersArea) return true;
  if (level === 'minimal') return false;
  if (!item.author?.toLowerCase().includes(authorFilter.toLowerCase())) return false;
  if (level === 'all') return true;
  if (item.feedKey === FeedKeys.stockInsights || item.feedKey === FeedKeys.optionsInsights) return stripReplyPrefix(item.title ?? '').startsWith('*');
  const text = stripHtml(item.content ?? '');
  return containsActionableSignal(text, actionPatterns);
}
