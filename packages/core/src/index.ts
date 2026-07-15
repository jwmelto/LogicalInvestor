import { decode as decodeHtmlEntities } from 'he';

export const MAX_SEEN_IDS_PER_FEED = 500;

// Three filter tiers, narrow to broad, each a strict superset of the previous — see
// docs/notification-filter-design.md. There is no 'any' tier: "show me everything" is just
// `filter: 'length', minLength: 0` — the length check always passes at 0, so it needs no
// separate enum value. Defined once here; ContentFilter and the rank lookup are both derived
// from this array so the tier names exist in exactly one place.
export const FILTER_TIERS = ['members', 'actionable', 'length'] as const;

export type ContentFilter = typeof FILTER_TIERS[number];

const FILTER_TIER_RANK = Object.fromEntries(FILTER_TIERS.map((tier, rank) => [tier, rank])) as Record<ContentFilter, number>;

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

export { decodeHtmlEntities };

// Strips HTML tags first (while entities are still escaped, so a literal "&lt;script&gt;" in text
// isn't mistaken for a real tag), then decodes entities via `he` (the full HTML5 named-entity
// table plus numeric/hex — a hand-rolled dictionary here previously missed real cases like
// &nbsp;), then collapses whitespace.
export function stripHtml(html: string): string {
  return decodeHtmlEntities(html.replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();
}

// The one domain type for "an RSS feed item, tagged with which of our feeds it came from" — used
// identically by the app and the Worker. guid/title/author/description/link/pubDate come straight
// from the feed (this feed's <item> always includes all of them; <description>, a CDATA block
// fast-xml-parser already unwraps to plain text, is the only content field — the RSS
// content-module's <content:encoded> never appears here). feedKey is the one rational extension
// beyond what's parsed: which feed this item was fetched from, not derivable from the item itself.
// A display name for that feed (e.g. "Members Forum") is NOT stored here — it's a lookup from
// feedKey wherever it's needed, not per-item data to keep in sync.
//
// Every string field here is already a "natural" string by the time a consumer sees it: title has
// its "Reply To: " prefix stripped and HTML entities decoded; author has entities decoded;
// description has HTML tags stripped and entities decoded (this app never renders description as
// markup — post.tsx loads the real webpage for that — so there's no reason to carry raw HTML
// through the rest of the system only to have every single consumer strip/decode it again).
// pubDate is a real Date, guaranteed valid by extractRssItems — consumers never re-parse or guard it.
export interface RssItem {
  guid: string;
  title: string;
  author: string;
  description: string;
  link: string;
  pubDate: Date;
  feedKey: FeedKey;
  isFirstPost: boolean; // raw title had no "Reply To: " prefix; unconsumed for now
}

// Normalizes an already-parsed RSS document (via fast-xml-parser) to an array of items —
// fast-xml-parser collapses a single <item> to an object instead of a one-element array — and
// extracts the handful of fields every consumer needs. Takes the parsed object, not the raw XML
// string or a parser instance, so this has no dependency on which fast-xml-parser major version
// produced it (the app and the Worker pin different majors). Returns items without feedKey —
// the caller knows which feed it fetched, the parser doesn't — so callers spread the result and
// add `feedKey` themselves: `{ ...rssItem, feedKey }`.
export function extractRssItems(parsedXml: unknown): Omit<RssItem, 'feedKey'>[] {
  const raw = (parsedXml as { rss?: { channel?: { item?: unknown } } })?.rss?.channel?.item ?? [];
  const items = Array.isArray(raw) ? raw : [raw];
  return items.map((item: any) => {
    const pubDate = new Date(item.pubDate);
    const decodedTitle = decodeHtmlEntities(item.title);
    return {
      guid: item.guid?.['#text'] ?? item.guid,
      title: stripReplyPrefix(decodedTitle),
      author: decodeHtmlEntities(item['dc:creator'] ?? item.author),
      description: stripHtml(item.description),
      link: item.link,
      pubDate: isNaN(pubDate.getTime()) ? new Date() : pubDate, // unparseable → treat as just-published
      isFirstPost: !decodedTitle.startsWith('Reply To: '),
    };
  });
}

// title/content are asserted to be already normalized (no "Reply To: " prefix, no HTML).
export interface FilterItem {
  feedKey: FeedKey;
  author?: string;
  title?: string;
  content?: string;
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

function matchNegativePattern(text: string): ActionableResult | null {
  for (const [re, clause] of NEG_PATTERNS) {
    if (re.test(text)) return clause;
  }
  return null;
}

function matchPositivePattern(text: string): ActionableResult | null {
  for (const [re, clause] of POS_PATTERNS) {
    if (re.test(text)) return clause;
  }
  return null;
}

export function classifySignal(text: string, minLength: number): ActionableResult {
  const neg = matchNegativePattern(text);
  if (neg) return neg;
  const pos = matchPositivePattern(text);
  if (pos) return pos;
  return text.length < minLength ? 'fail-too-short' : 'fail-no-signal';
}

export function containsActionableSignal(text: string, minLength = 200): boolean {
  return classifySignal(text, minLength).startsWith('pass');
}

export function isFresh(pubDate: Date, maxAgeMs: number): boolean {
  return Date.now() - pubDate.getTime() <= maxAgeMs;
}

// Ordinal "how loose a device's tier needs to be to see this item." A negative-pattern match
// only disqualifies 'actionable', not 'length'. Infinity = not visible at any tier, at this
// minLength.
//
// actionableAuthors is asserted to be lowercase.
export function minVisibleTier(item: FilterItem, minLength: number, actionableAuthors: string[]): number {
  if (item.feedKey === FeedKeys.membersArea) return FILTER_TIER_RANK.members;
  const text = item.content ?? '';
  const author = (item.author ?? '').toLowerCase();
  const isActionableAuthor = actionableAuthors.some((a) => author.includes(a));
  const requiresStar = item.feedKey === FeedKeys.stockInsights || item.feedKey === FeedKeys.optionsInsights;
  const topicPass = !requiresStar || (item.title ?? '').startsWith('*');
  const actionable = isActionableAuthor && topicPass && matchNegativePattern(text) === null && matchPositivePattern(text) !== null;
  if (actionable) return FILTER_TIER_RANK.actionable;
  return text.length >= minLength ? FILTER_TIER_RANK.length : Infinity;
}

// Empty authors list = no author restriction. `authors` is asserted to be lowercase.
export function authorMatches(author: string | undefined, authors: string[]): boolean {
  if (authors.length === 0) return true;
  const a = (author ?? '').toLowerCase();
  return authors.some((f) => a.includes(f));
}

// Members Area is unconditional — no author or content check.
export function matchesFilter(item: FilterItem, filter: ContentFilter, authors: string[], minLength: number, actionableAuthors: string[]): boolean {
  if (item.feedKey === FeedKeys.membersArea) return true;
  return authorMatches(item.author, authors) && FILTER_TIER_RANK[filter] >= minVisibleTier(item, minLength, actionableAuthors);
}
