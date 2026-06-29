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

export type ActionableResult =
  | 'pass-new-pick'
  | 'pass-tranche-price'
  | 'pass-get-in-tranche'
  | 'pass-buy-with-price'
  | 'pass-sell-fraction'
  | 'pass-averaging-down'
  | 'pass-immediately'
  | 'fail-personal-advice'
  | 'fail-historical'
  | 'fail-hypothetical'
  | 'fail-too-short'
  | 'fail-no-signal';

// Negative patterns checked first — a match suppresses positive pattern evaluation.
const NEG_PATTERNS: [RegExp, ActionableResult][] = [
  [/\bin (your|my|his|her|their) case\b/i,              'fail-personal-advice'],
  [/\bI'?d personally\b/i,                              'fail-personal-advice'],
  [/\bwe may consider\b|\bwe'?d likely\b/i,             'fail-hypothetical'],
  [/\bif it should\b/i,                                 'fail-hypothetical'],
  [/\bI was (urging|pushing|saying|telling|recommending)\b/i, 'fail-historical'],
];

const POS_PATTERNS: [RegExp, ActionableResult][] = [
  [/\bnew pick\b/i,                                                               'pass-new-pick'],
  [/\b(1st|2nd|3rd|4th|first|second|third|fourth)\s+tranche:\s*\$/i,            'pass-tranche-price'],
  [/\bget\s+in\b[\s\S]{0,30}\btranche\b/i,                                       'pass-get-in-tranche'],
  [/\b(buy|enter)\b[\s\S]{0,60}\$\d+/i,                                          'pass-buy-with-price'],
  [/\bsell(?:ing)?\s+(half|all|a\s+third|a\s+quarter|\d+\/\d+)\b/i,             'pass-sell-fraction'],
  [/\baveraging?\s+down\b/i,                                                       'pass-averaging-down'],
  [/\bIMMEDIATELY\b/,                                                             'pass-immediately'],
];

export function classifySignal(text: string, minLength: number): ActionableResult {
  if (text.length < minLength) return 'fail-too-short';
  for (const [re, clause] of NEG_PATTERNS) {
    if (re.test(text)) return clause;
  }
  for (const [re, clause] of POS_PATTERNS) {
    if (re.test(text)) return clause;
  }
  return 'fail-no-signal';
}

export function containsActionableSignal(text: string, minLength = 200): boolean {
  return classifySignal(text, minLength).startsWith('pass');
}

export function matchesLevel(
  item: FilterItem,
  level: NotifLevel,
  authorFilter: string,
  minLength: number,
  _actionPatterns?: unknown,
): boolean {
  if (level === 'none') return false;
  if (item.feedKey === FeedKeys.membersArea) return true;
  if (level === 'minimal') return false;
  if (!item.author?.toLowerCase().includes(authorFilter.toLowerCase())) return false;
  if (level === 'all') return true;
  if (item.feedKey === FeedKeys.stockInsights || item.feedKey === FeedKeys.optionsInsights) {
    return stripReplyPrefix(item.title ?? '').startsWith('*');
  }
  return containsActionableSignal(stripHtml(item.content ?? ''), minLength);
}
