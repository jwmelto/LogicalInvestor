import { decode as decodeHtmlEntities } from 'he';
import { classifyActionableHybrid, type LabeledVector } from './similarity';
import actionableCalibrationFixture from './data/actionableCalibration.fixture.json';
import optionsActionableCalibrationFixture from './data/optionsActionableCalibration.fixture.json';

export { classifyActionableHybrid, type LabeledVector };

// The pinned bge-large-en-v1.5 vectors backing the hybrid actionable classifier (see
// similarity.ts). Bundled statically -- updating the calibration set means a new commit and
// deploy, same as any other data change, not a runtime fetch.
export const ACTIONABLE_CALIBRATION_EXAMPLES: LabeledVector[] = actionableCalibrationFixture.examples as LabeledVector[];

// Options Insights' own calibration set -- a different discourse than the stock-pick vocabulary
// above (contract mechanics vs. tranche pricing), so it gets its own vectors rather than being
// merged into ACTIONABLE_CALIBRATION_EXAMPLES. See ACTIONABLE_STRATEGY_BY_FEED for where this is
// selected.
export const OPTIONS_CALIBRATION_EXAMPLES: LabeledVector[] = optionsActionableCalibrationFixture.examples;

export const MAX_SEEN_IDS_PER_FEED = 500;

// Three filter tiers, narrow to broad, each a strict superset of the previous — see
// docs/notification-filter-design.md. There is no 'any' tier: "show me everything" is just
// `filter: 'length', minLength: 0` — the length check always passes at 0, so it needs no
// separate enum value. Defined once here; ContentFilter and the rank lookup are both derived
// from this array so the tier names exist in exactly one place.
export const FILTER_TIERS = ['members', 'actionable', 'length'] as const;

export type ContentFilter = typeof FILTER_TIERS[number];

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
  | 'pass-options-contract'
  | 'fail-personal-advice'
  | 'fail-historical'
  | 'fail-hypothetical'
  | 'fail-generic-practice'
  | 'fail-negated-instruction'
  | 'fail-acknowledgment'
  | 'fail-general-education'
  | 'fail-no-action-verb'
  | 'fail-too-short'
  | 'fail-no-signal';

// Negative patterns checked first — a match suppresses positive pattern evaluation.
const NEG_PATTERNS: [RegExp, ActionableResult][] = [
  [/\bin (your|my|his|her|their) case\b/i,              'fail-personal-advice'],
  [/\bI'?d personally\b/i,                              'fail-personal-advice'],
  [/\bwe may consider\b|\bwe'?d likely\b/i,             'fail-hypothetical'],
  [/\bif it should\b/i,                                 'fail-hypothetical'],
  [/\bI was (urging|pushing|saying|telling|recommending)\b/i, 'fail-historical'],
  // ponytail: catches "could either tank... or rally..." two-sided hedges; a genuine
  // "buy either at $50 or $52" instruction would false-negative here too — narrow further
  // (e.g. require both sides to end in a parenthetical) if that shows up in practice.
  [/\b(could|might|may)\s+either\b[\s\S]{0,80}\bor\b/i,       'fail-hypothetical'],
  // #72/#75: habitual/generic framing ("just a good practice to get into", "I always say to put
  // in...") restates general order-management philosophy rather than issuing a fresh directive —
  // a distinct category from fail-historical (past-tense reference to a prior, specific call).
  [/\b(good|standard|common|best)\s+practice\b/i,             'fail-generic-practice'],
  [/\bI always (say|recommend|tell|advise|urge)\b/i,          'fail-generic-practice'],
  // #79: negation attached directly to the buy/enter verb ("not buy anything more") — narrow
  // fix for negation adjacent to the verb, not every possible negative framing further away.
  // Window kept tight (4 chars) so it doesn't also catch unrelated "ask/buy quote" market-mechanics
  // phrasing (e.g. "not the ask/buy quote"), which has ~9 chars between "not" and "buy".
  // Excludes "if you don't buy X, then Y" conditional framing — a real false positive on a full
  // post where a rhetorical aside about consumer purchases ("if you don't buy their beer/wine...
  // you're not funding them") suppressed a genuine tranche-price buy call elsewhere in the same
  // post. A veto from one narrow regex shouldn't outweigh a real, unrelated directive; the fix is
  // making the regex itself stop firing on this shape, not weakening the veto generally — a
  // sentence-scoped veto was tried and rejected, since it also broke the #82 "already sold
  // half...officially still holding" case (a later, unrelated-looking "selling half" mention in
  // the same retrospective paragraph), the exact discourse-judgment problem regex can't solve.
  [/(?<!\bif\b[^.!?]{0,12})\b(not|n't|never|don'?t|doesn'?t|didn'?t)\b[\s\S]{0,4}\b(buy|enter)\b/i, 'fail-negated-instruction'],
  // "if you wish" / "if you want to" / "nothing wrong with X" — permissive, take-it-or-leave-it
  // framing, not a directive. "You can sell half if you wish" would otherwise match
  // pass-sell-fraction outright; nothing previously distinguished optional permission from a call.
  [/\bif you (wish|want to)\b|\bnothing wrong (with|if)\b/i,               'fail-hypothetical'],
  // Same permissive-framing category as above, third person: "if someone... they want to choose
  // to sell half, they can always do that" describes an optional individual choice, not a call —
  // same discourse function as "if you want to", different pronoun.
  [/\bwants? to choose to\b/i,                                              'fail-hypothetical'],
  // #82: "it can still take any one of these paths, you might sell half..." — scenario-branching
  // hedge language, same spirit as the #66 "could either...or" two-sided hedge but a different
  // construction. ponytail: narrow to "paths/scenarios/outcomes" nouns actually seen in reports;
  // a genuine directive that also happens to use this phrasing ("any one of these paths, sell
  // half now regardless") would false-negative too — widen the noun alternation if that shows up.
  [/\bany one of (these|those|the)\s+(paths|scenarios|outcomes)\b/i,          'fail-hypothetical'],
  // #82: "we've already sold half, we're officially still holding" — a retrospective status
  // report of action already taken, not a new call, distinct from #66's "I was urging" (a past
  // reference to a specific prior recommendation vs. this being a statement of current position).
  [/\bwe'?ve already (sold|bought|entered|exited)\b/i,                         'fail-historical'],
  // A real post-deploy false alarm: "Good job. Congrats!" reached nearest-neighbor (no other
  // signal) and matched purely on generic congratulatory tone. "Good job" is a reaction to a
  // reported outcome, not a directive — distinct from fail-historical (a past-tense reference to
  // a prior *recommendation*, not praise for how something turned out. "Congrats"/"Congratulations"
  // deliberately excluded: an existing true positive ("Congrats. Earnings on 9/10 after the bell.
  // If you haven't sold half, you might.") opens with it before the real directive.
  [/\bgood job\b/i,                                                            'fail-acknowledgment'],
  // Another real post-deploy false alarm: "Yes, but it depends on where your last /2nd tranche
  // is." "It depends" frames the answer as conditional on the individual's own situation, same
  // personal-advice category as "in your case" / "I'd personally" above.
  [/\bit depends\b/i,                                                          'fail-personal-advice'],
];

// Stock-pick vocabulary: tranche pricing, averaging down, sell-fraction language -- the default
// pattern set, used by every feed with no forum-specific override (see ACTIONABLE_STRATEGY_BY_FEED
// below).
const STOCK_POS_PATTERNS: [RegExp, ActionableResult][] = [
  [/\bnew pick\b/i,                                                               'pass-new-pick'],
  [/\b(1st|2nd|3rd|4th|first|second|third|fourth)\s+tranche:\s*\$/i,            'pass-tranche-price'],
  [/\bget\s+in\b[\s\S]{0,30}\btranche\b/i,                                       'pass-get-in-tranche'],
  // #73: bidirectional — a re-entry price mentioned before the buy/enter verb ("$41ish again,
  // you can enter") is just as much a signal as the verb-then-price order. Gap is bounded by
  // sentence, not a raw char count: a fixed window like {0,60} breaks the moment a company name
  // or hedge phrase is a few characters longer, which is length-fragility, not a real signal
  // (found via a longer fictitious company name in classifySignal.test.ts breaking this exact
  // pattern). `(?!\.\s|!\s|\?\s)` stops the gap at a sentence-ending punctuation mark followed by
  // whitespace — a decimal price like "$66.50" doesn't trip it, since the period there isn't
  // followed by whitespace. 200 is a sanity backstop against pathological run-on sentences, not
  // the primary boundary.
  [/\$\d+(?:(?!\.\s|!\s|\?\s)[\s\S]){0,200}\b(buy|enter)\b|\b(buy|enter)\b(?:(?!\.\s|!\s|\?\s)[\s\S]){0,200}\$\d+/i, 'pass-buy-with-price'],
  // #82: "sell it all" — the fraction word doesn't always sit directly after the verb; an
  // intervening pronoun is common, natural phrasing missed by the original bare-adjacency regex.
  [/\b(sell(?:ing)?|sold)\s+(?:it\s+)?(half|all|a\s+third|a\s+quarter|\d+\/\d+)\b/i,   'pass-sell-fraction'],
  // Bare "averaging down" is discussed constantly as general market commentary — a live false
  // positive ("in some cases, that'll give us averaging down opportunities...") had no directive
  // verb anywhere near it, just abstract description. Unlike every other POS_PATTERN, the old
  // bare-noun-phrase match had no verb/directive component at all, which is why this single
  // pattern accounted for 4 independent false positives (#72, #75, #78 case 3, and this one).
  // Requiring "get your" (the only directive verb seen in real true-positive reports so far)
  // immediately before it fixes all four without a price requirement — a nearby price isn't the
  // actual discriminator either, since "get your averaging down now" has no price at all. Narrow
  // on purpose: extend the verb alternation (e.g. "put in your", "add your") only when a real
  // report uses different directive phrasing, same as the rest of this pattern list.
  [/\bget\s+your\b[\s\S]{0,20}\baveraging?\s+down\b/i,                           'pass-averaging-down'],
  [/\bIMMEDIATELY\b/,                                                             'pass-immediately'],
];

// Options Insights vocabulary: this feed has tranches too (a 2nd tranche on an existing options
// position is common), but a real tranche entry still always carries the strike/put-or-call/expiry
// syntax below -- it's never the stock forum's bare "1st tranche: $121" shorthand, since an options
// tranche is itself a specific contract, not just a price level. The stock-pick STOCK_POS_PATTERNS
// tranche patterns (pass-tranche-price, pass-get-in-tranche) require that bare colon-price/"get in"
// shorthand and so don't fire here regardless; kept as its own pattern set below rather than folded
// into STOCK_POS_PATTERNS because the actual triggering syntax is unrelated, not because the
// concept of a tranche doesn't apply, selected per feed via ACTIONABLE_STRATEGY_BY_FEED below.
const OPTIONS_POS_PATTERNS: [RegExp, ActionableResult][] = [
  // Naming a strike, a put/call side, and an expiry (the literal word, or a month+year like
  // "March 2026") together is this author's own stated convention for a live contract reference
  // ("ANY options alert should include 'strike' and 'expiry' keywords with either 'put' or
  // 'call'"). Three independent token checks, not a proximity window: real posts vary too much in
  // word order and sentence-splitting (e.g. "...strike put has enough liquidity for our purposes.
  // 2026 expiry.") for position to be the discriminator. A bare 4-digit year alone doesn't count as
  // the expiry token -- only "expiry"/"expiries"/"expiration" or an actual month+year pairing does,
  // so an unrelated year mention elsewhere in the post can't supply it. No verb requirement, unlike
  // every STOCK_POS_PATTERNS entry: this author sometimes confirms a contract with no verb at all
  // ("JCI PUT MAR 2026 $95 strike"), and the three tokens together are already a strong enough
  // signal on their own.
  [/(?=[\s\S]*\bstrikes?\b)(?=[\s\S]*\b(?:puts?|calls?)\b)(?=[\s\S]*(?:\bexpir(?:y|ies|ation)\b|\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\s+20\d\d\b))/i, 'pass-options-contract'],
];

// Necessary-condition check: a real directive always names a trade action, in some form, even
// when phrased as a modal ("you can sell half now"), infinitive ("close enough to get your
// averaging down in"), or first-person announcement ("we're getting into X now") rather than a
// bare command. Grammatical mood was tried and rejected as the discriminating axis: 89% of real
// positive examples in the calibration set have no bare-imperative clause at all, since this
// author overwhelmingly softens directives with modals rather than issuing bare commands.
// Absence of any of these verb forms is necessary, not sufficient, evidence of
// non-actionability — see its placement in classifySignal below, strictly after both pattern
// arrays, so it only narrows the residual ambiguous bucket and never overrides an established
// verb-free positive signal like pass-tranche-price ("2nd tranche: $121" carries no verb at all
// by this newsletter's own convention).
//
// Excludes "buy recommendation"/"rating"/"call"/"alert" — a noun-phrase reference to the
// original historical call ("the buy recommendation from the newsletter"), not a live verb.
// Found via a real false match on a genuine negative example that otherwise relied on
// nearest-neighbor and got it wrong.
//
// Includes "capture"/"captures"/"capturing"/"captured": Options Insights profit-taking language
// ("up a quick 20% in such a short time can capture profits as well") has no other verb in this
// list, so without it the necessary-condition check fails outright (fail-no-action-verb) and never
// reaches the embedding fallback, rather than landing in the ambiguous bucket where nearest-
// neighbor can weigh it against the calibration set. Same trade-action vocabulary as the rest of
// this list, not an options-only special case.
const ACTION_VERB = /\b(buy|buys|buying|bought)\b(?!\s+(recommendation|rating|call|alert))|\b(sell|sells|selling|sold|enter|enters|entering|entered|get\s+in(?:to)?|gets\s+in(?:to)?|getting\s+in(?:to)?|got\s+in(?:to)?|exit|exits|exiting|exited|hold|holds|holding|held|close|closes|closing|closed|roll|rolls|rolling|rolled|average[ds]?\s+down|averaging\s+down|add|adds|adding|added|trim|trims|trimming|trimmed|capture[ds]?|capturing)\b/i;

// Exported for the embeddings-similarity prototype (see similarity.ts): closed-class discourse
// markers (hedge modals, personal-address phrases, negation) are reliably keyword-detectable —
// the whack-a-mole history on this file is about open-ended phrasing (directive vs. retrospective
// framing), not these markers, so there's no reason for a hybrid classifier to re-derive them.
export function matchNegativePattern(text: string): ActionableResult | null {
  for (const [re, clause] of NEG_PATTERNS) {
    if (re.test(text)) return clause;
  }
  return null;
}

// Exported for the embeddings-similarity prototype (see similarity.ts) — classifyActionableHybrid
// applies this itself, in the same order as classifySignal (after both pattern arrays, never
// before), since it calls matchNegativePattern/matchPositivePattern directly rather than going
// through classifySignal.
export function containsActionVerb(text: string): boolean {
  return ACTION_VERB.test(text);
}

// Exported for the embeddings-similarity prototype (see similarity.ts) — see matchNegativePattern's
// comment above for why this file's reliable literal markers are reused rather than re-derived.
// posPatterns defaults to the stock-pick set; a forum with its own vocabulary passes its own (see
// ACTIONABLE_STRATEGY_BY_FEED below) rather than this function special-casing feed identity itself.
export function matchPositivePattern(text: string, posPatterns: [RegExp, ActionableResult][] = STOCK_POS_PATTERNS): ActionableResult | null {
  for (const [re, clause] of posPatterns) {
    if (re.test(text)) return clause;
  }
  return null;
}

export function classifySignal(text: string, minLength: number, posPatterns: [RegExp, ActionableResult][] = STOCK_POS_PATTERNS): ActionableResult {
  const neg = matchNegativePattern(text);
  if (neg) return neg;
  const pos = matchPositivePattern(text, posPatterns);
  if (pos) return pos;
  if (!ACTION_VERB.test(text)) return 'fail-no-action-verb';
  return text.length < minLength ? 'fail-too-short' : 'fail-no-signal';
}

export function containsActionableSignal(text: string, minLength = 200, posPatterns: [RegExp, ActionableResult][] = STOCK_POS_PATTERNS): boolean {
  return classifySignal(text, minLength, posPatterns).startsWith('pass');
}

// True only for the two outcomes that mean "the regex/action-verb gate has no opinion either
// way" -- every other ActionableResult (every pass-*, and every fail-* that isn't one of these
// two) is a definitive verdict from classifySignal, not something that should fall through to a
// live embedding call. The single place this distinction is expressed, so classifyActionableHybrid
// and the Worker's hybrid-candidacy check can't drift from each other or from classifySignal
// itself -- see classifyActionableHybrid's comment for why that drift is a real, not
// hypothetical, risk.
export function isSignalUndecided(result: ActionableResult): boolean {
  return result === 'fail-no-signal' || result === 'fail-too-short';
}

export function isFresh(pubDate: Date, maxAgeMs: number): boolean {
  return Date.now() - pubDate.getTime() <= maxAgeMs;
}

// The author/topic-star gate alone, factored out of isActionablePost so the Worker can reuse it
// to decide whether an item is worth spending a live embedding call on, without re-deriving these
// three lines. actionableAuthors is asserted to be lowercase.
export function isActionableCandidate(item: FilterItem, actionableAuthors: string[]): boolean {
  const author = (item.author ?? '').toLowerCase();
  const isActionableAuthor = actionableAuthors.some((a) => author.includes(a));
  const requiresStar = item.feedKey === FeedKeys.stockInsights || item.feedKey === FeedKeys.optionsInsights;
  const topicPass = !requiresStar || (item.title ?? '').startsWith('*');
  return isActionableAuthor && topicPass;
}

// A forum's whole "what counts as actionable" method: which closed-class regex patterns resolve a
// post definitively, and which labeled examples the embedding fallback compares against when regex
// has no opinion. One object per vocabulary, not per feed -- Members Forum and Stock Insights share
// STOCK_PICK_STRATEGY today because they share a discourse (both stock-pick content, differing only
// in the star-gate isActionableCandidate applies), the same reason they always have.
export interface ActionableStrategy {
  posPatterns: [RegExp, ActionableResult][];
  calibration: LabeledVector[];
}

const STOCK_PICK_STRATEGY: ActionableStrategy = { posPatterns: STOCK_POS_PATTERNS, calibration: ACTIONABLE_CALIBRATION_EXAMPLES };
const OPTIONS_STRATEGY: ActionableStrategy = { posPatterns: OPTIONS_POS_PATTERNS, calibration: OPTIONS_CALIBRATION_EXAMPLES };

// Members Area bypasses every filter tier unconditionally (see matchesFilter), so its
// actionable-ness is never computed at all -- this is unused data, not behavior. An empty
// posPatterns array can never produce a pass-* result, so isActionablePost already resolves false
// for it with no separate branch.
const NULL_STRATEGY: ActionableStrategy = { posPatterns: [], calibration: [] };

// One entry per feed, every consumer resolves it through actionableStrategyFor rather than
// checking feed identity itself.
const ACTIONABLE_STRATEGY_BY_FEED: Record<FeedKey, ActionableStrategy> = {
  [FeedKeys.membersArea]:     NULL_STRATEGY,
  [FeedKeys.membersForum]:    STOCK_PICK_STRATEGY,
  [FeedKeys.stockInsights]:   STOCK_PICK_STRATEGY,
  [FeedKeys.optionsInsights]: OPTIONS_STRATEGY,
};

export function actionableStrategyFor(feedKey: FeedKey): ActionableStrategy {
  return ACTIONABLE_STRATEGY_BY_FEED[feedKey];
}

// Regex-only actionable check. Exported: the Worker calls this directly for content that's already
// regex-definitive or isn't a valid candidate at all, and as the fallback when a live embedding
// call fails. actionableAuthors is asserted to be lowercase. Uses the item's own forum's
// posPatterns (via actionableStrategyFor) rather than assuming stock-pick vocabulary, so this
// resolves correctly against each forum's own discourse. Goes through classifySignal (via
// containsActionableSignal) rather than re-deriving the pattern/action-verb sequence by hand: two
// independent copies of that sequence can silently drift apart, since nothing but a full
// regression run would catch a gate added to one copy and not the other.
// pass-sell-fraction is the one regex pattern with a measured accuracy problem: 12/19 correct on
// the stock calibration set (every other pattern, positive or negative, across both the stock and
// options corpora, is 100% correct -- see the leave-one-out accuracy work in similarity.test.ts).
// "Sell half"/"sell all" language is used identically by a genuine group directive, a reply giving
// one person advice about their specific holding, and general educational discussion of the
// strategy itself -- three discourse roles sharing the same vocabulary, which no keyword or
// embedding-similarity check can separate (they're equally close in vector space to the same
// words). This is a live LLM judgment call, not a closed-class pattern, so it's resolved by
// classifySellFractionIntent (cloudflare-worker/src/intentClassifier.ts) rather than another regex.
export type IntentLabel = 'directive' | 'personal-advice' | 'general-education';
export type IntentConfidence = 'high' | 'medium' | 'low';

export interface IntentClassification {
  reasoning: string;
  evidence: string;
  label: IntentLabel;
  confidence: IntentConfidence;
}

export interface IntentGateResult {
  actionable: boolean;
  result: ActionableResult;
}

// A missed alert costs more than a false alarm (see CLAUDE.md's design philosophy for this
// classifier) -- so only a *confident* non-directive verdict suppresses the post. Anything less
// than full confidence, regardless of label, defaults to actionable rather than being trusted
// either way, mirroring pass-sell-fraction's own prior behavior (trust the regex) for the
// uncertain case.
export function resolveIntentGate(intent: IntentClassification): IntentGateResult {
  const confidentNonDirective = intent.label !== 'directive' && intent.confidence === 'high';
  const result: ActionableResult = !confidentNonDirective
    ? 'pass-sell-fraction'
    : intent.label === 'personal-advice' ? 'fail-personal-advice' : 'fail-general-education';
  return { actionable: !confidentNonDirective, result };
}

export function isActionablePost(item: FilterItem, actionableAuthors: string[]): boolean {
  if (!isActionableCandidate(item, actionableAuthors)) return false;
  return containsActionableSignal(item.content ?? '', 0, actionableStrategyFor(item.feedKey).posPatterns);
}

// Empty authors list = no author restriction. `authors` is asserted to be lowercase.
export function authorMatches(author: string | undefined, authors: string[]): boolean {
  if (authors.length === 0) return true;
  const a = (author ?? '').toLowerCase();
  return authors.some((f) => a.includes(f));
}

// The resolved per-item classification the Worker computes once per poll cycle, shared across
// every notification bucket. `members` is checked first and short-circuits `actionable` entirely
// (never computed, regex or hybrid) since Members Area bypasses every filter tier regardless of
// actionable-ness — there's no reason to spend a regex check, let alone a live embedding call, on
// content whose notification eligibility doesn't depend on it.
export interface ItemClassification {
  members: boolean;
  actionable: boolean;
}

// Members Area is unconditional; every other tier is a pure function of the already-resolved
// classification plus this bucket's own settings. matchesFilter no longer computes
// actionable-ness itself — see ItemClassification's comment for why that's resolved upstream,
// once per item, not per bucket.
export function matchesFilter(item: FilterItem, filter: ContentFilter, authors: string[], minLength: number, classification: ItemClassification): boolean {
  if (classification.members) return true;
  if (filter === 'members') return false;
  if (classification.actionable) return true;
  // 'length' is a strict superset of 'actionable': an actionable post already qualified above.
  // The personal whitelist only gates the other way in — merely-long content from a whitelisted
  // author.
  return filter === 'length' && authorMatches(item.author, authors) && (item.content ?? '').length >= minLength;
}
