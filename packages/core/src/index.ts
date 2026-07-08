export const MAX_SEEN_IDS_PER_FEED = 500;

export type NotifLevel = 'none' | 'minimal' | 'standard' | 'all';

export const FeedKeys = {
  membersArea:     'membersArea',
  membersForum:    'membersForum',
  stockInsights:   'stockInsights',
  optionsInsights: 'optionsInsights',
} as const;

export type FeedKey = typeof FeedKeys[keyof typeof FeedKeys];

export const ChannelNames = {
  members: 'members',
  stock: 'stock',
  options: 'options',
} as const;

export type Channel = typeof ChannelNames[keyof typeof ChannelNames];

// Single source of truth for which push channel a feed belongs to. Used directly by the app's
// pushService.ts; the Worker's CHANNEL_FEEDS carries additional per-feed data (URL,
// discoverTopics) this map doesn't, and its per-channel array order is load-bearing (see the
// comment on CHANNEL_FEEDS in cloudflare-worker/src/index.ts), so the Worker keeps its own
// structure but is tested against this map for drift (index.test.ts).
export const FEEDKEY_TO_CHANNEL: Record<FeedKey, Channel> = {
  [FeedKeys.membersArea]:     ChannelNames.members,
  [FeedKeys.membersForum]:    ChannelNames.members,
  [FeedKeys.stockInsights]:   ChannelNames.stock,
  [FeedKeys.optionsInsights]: ChannelNames.options,
};

// A <channel><item> entry from an RSS feed, after resolving the two cross-consumer quirks every
// call site had to handle: fast-xml-parser's guid #text-vs-plain-string variant, and a missing
// guid falling back to the item's link (its next-best unique identifier). Beyond that, fields are
// left optional/unresolved (no '' or other placeholder defaults) so each consumer can apply its
// own final fallback (e.g. a random ID vs an empty string) for the fully-missing case.
export interface ParsedRssItem {
  guid?: string;
  title?: string;
  author?: string;
  description?: string;
  contentEncoded?: string;
  link?: string;
  pubDate?: string;
}

// Normalizes an already-parsed RSS document (via fast-xml-parser) to an array of items —
// fast-xml-parser collapses a single <item> to an object instead of a one-element array — and
// extracts the handful of fields every consumer needs. Takes the parsed object, not the raw XML
// string or a parser instance, so this has no dependency on which fast-xml-parser major version
// produced it (the app and the Worker pin different majors).
export function extractRssItems(parsedXml: unknown): ParsedRssItem[] {
  const raw = (parsedXml as { rss?: { channel?: { item?: unknown } } })?.rss?.channel?.item ?? [];
  const items = Array.isArray(raw) ? raw : [raw];
  return items.map((item: any) => ({
    guid: item.guid?.['#text'] ?? item.guid ?? item.link,
    title: item.title,
    author: item['dc:creator'] ?? item.author,
    description: item.description,
    contentEncoded: item['content:encoded'],
    link: item.link,
    pubDate: item.pubDate,
  }));
}

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
  for (const [re, clause] of NEG_PATTERNS) {
    if (re.test(text)) return clause;
  }
  for (const [re, clause] of POS_PATTERNS) {
    if (re.test(text)) return clause;
  }
  return text.length < minLength ? 'fail-too-short' : 'fail-no-signal';
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
    if (!stripReplyPrefix(item.title ?? '').startsWith('*')) return false;
  }
  return containsActionableSignal(stripHtml(item.content ?? ''), minLength);
}
