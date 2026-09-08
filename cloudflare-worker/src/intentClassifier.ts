import { FeedKeys, type FeedKey, type IntentClassification } from '@li/core';

// The regexes that route a post here (NEEDS_INTENT_CONFIRMATION in @li/core: pass-sell-fraction,
// pass-close-enough, pass-options-contract) are all deliberately tuned for recall over precision
// -- each is worded broadly enough that the same trigger phrase ("sell half", "close enough...
// now", a strike+expiry mention) is used identically by a genuine group directive, a reply giving
// one person advice about their own situation, and general strategy/mechanics education. No
// keyword or embedding-similarity check can separate those (see resolveIntentGate's comment in
// @li/core for the measured leave-one-out evidence), so precision is recovered here instead of by
// narrowing the regex.
//
// One IntentStrategy per vocabulary, not one shared prompt -- same reasoning as
// ActionableStrategy in @li/core keeping posPatterns/calibration per forum rather than pooled:
// stock-pick and options discourse are different enough that a fix tuned for one shouldn't risk
// changing the other's behavior. Members Forum and Stock Insights share STOCK_INTENT_STRATEGY for
// the same reason they share STOCK_PICK_STRATEGY.
export interface IntentStrategy {
  systemPrompt: string;
  fewShot: { post: string; response: IntentClassification }[];
}

const CATEGORY_DEFINITIONS = `- directive: a live instruction for readers to act now on a specific holding or contract. Look for a specific trigger (a price, a % gain, a tranche number, an options strike/expiry) tied to a plural or unaddressed/broadcast audience ("many of you", "y'all", "everyone", "those of you in X", or no addressee at all -- stated flatly as newsletter guidance).
- personal-advice: a reply giving one specific person advice about their own individual situation -- addressed to a singular "you"/"your" responding to THAT PERSON'S OWN reported gain or holding ("you're up that much", "what you have left"), not a plural or generic audience.
- general-education: explaining how the trading strategy or market mechanics work in general. The telltale sign is the post names no specific holding, no specific price, and no specific trigger to act on right now -- it's explaining WHY or HOW the approach works (a numbered list of reasons, "the reason we...", "so that...", describing the method itself), not reporting on a live position.

Confidence calibration -- do not default to a low or medium confidence out of general caution:
- Use "high" whenever the post clearly fits the telltale signs above, even if it also contains action words like "sell" or "buy". A numbered explanation of strategy mechanics is high-confidence general-education regardless of which action verbs appear inside it. A reply naming one person's own specific gain is high-confidence personal-advice regardless of brevity.
- Use "medium" only when the post has real signals pointing to more than one category (e.g. it names a specific price AND lacks any addressee at all).
- Use "low" only when the post is too short or too stripped of context to judge at all (e.g. a bare sentence fragment with no stated trigger, no stated addressee, and no explanatory content).

Read the post, quote the exact evidence, reason about which of the three categories it belongs to, then give your verdict. Respond only with the requested JSON.`;

const STOCK_INTENT_STRATEGY: IntentStrategy = {
  systemPrompt: `You are classifying a single forum post from a stock-trading newsletter. The post already matched a broad, recall-tuned pattern for trade-related language (a "sell half"/"sell all" style call, or a "close enough...now" immediacy trigger), but that match alone doesn't tell you what the post actually means -- it could be one of three different things:

${CATEGORY_DEFINITIONS}`,
  fewShot: [
    {
      post: 'Because many of you are up 15%+ in ONE day, you can sell half of your 1st tranche and if it pulls back to your breakeven, you can put that half back on.',
      response: {
        reasoning: 'Addressed to "many of you" -- a plural, broadcast audience, not one individual. It states a specific action (sell half of the 1st tranche) tied to a stated trigger (up 15%+ today), which is live guidance for every reader holding this position, not a description of the strategy in the abstract.',
        evidence: 'Because many of you are up 15%+ in ONE day, you can sell half of your 1st tranche',
        label: 'directive',
        confidence: 'high',
      },
    },
    {
      post: "Because you're up that much, you can sell half and I'd not sell the last bit until we officially sell around $47ish or so.",
      response: {
        reasoning: 'Addressed to a singular "you" about "that much" gain -- a specific, individual amount, not a broadcast trigger stated for the whole readership. "I\'d not sell the last bit" is the author\'s personal reply to one person\'s situation, not a general call to action.',
        evidence: "Because you're up that much, you can sell half",
        label: 'personal-advice',
        confidence: 'high',
      },
    },
    {
      post: "Ways that we use volatility to our advantage: 1) We let downside volatility give us great eventual buying opportunities 2) We benefit from the snapback/upside volatility and then, 3) We sell half (or if up enough even half of that remaining half), so that when the next downside volatility happens, it's far less impactful... So, volatility is our friend and not our enemy.",
      response: {
        reasoning: 'A numbered explanation of the overall strategy\'s philosophy -- why the approach of selling half works in general -- not a report on any specific holding or a call to act today. "We sell half... so that" describes the general method, not a live instruction.',
        evidence: "We sell half (or if up enough even half of that remaining half), so that when the next downside volatility happens, it's far less impactful",
        label: 'general-education',
        confidence: 'high',
      },
    },
  ],
};

const OPTIONS_INTENT_STRATEGY: IntentStrategy = {
  systemPrompt: `You are classifying a single forum post from an options-trading newsletter. The post already matched a broad, recall-tuned pattern naming an options strike and expiry, but that match alone doesn't tell you what the post actually means -- it could be one of three different things:

${CATEGORY_DEFINITIONS}`,
  fewShot: [
    {
      post: 'March $95 strike, 2026 expiry, yes you can get into it now.',
      response: {
        reasoning: 'Names a specific contract (strike and expiry) with a live entry instruction ("you can get into it now"), stated flatly as newsletter guidance rather than addressed to one person\'s own reported situation. No addressee narrows this to a single individual, so it reads as broadcast confirmation of a real contract to enter.',
        evidence: 'March $95 strike, 2026 expiry, yes you can get into it now',
        label: 'directive',
        confidence: 'high',
      },
    },
  ],
};

// One entry per feed, mirroring actionableStrategyFor in @li/core -- every consumer resolves it
// through this rather than checking feed identity itself. Members Area is never a candidate for
// intent confirmation at all (it bypasses every filter tier, see ItemClassification in @li/core),
// so it has no entry here.
const INTENT_STRATEGY_BY_FEED: Partial<Record<FeedKey, IntentStrategy>> = {
  [FeedKeys.membersForum]:    STOCK_INTENT_STRATEGY,
  [FeedKeys.stockInsights]:   STOCK_INTENT_STRATEGY,
  [FeedKeys.optionsInsights]: OPTIONS_INTENT_STRATEGY,
};

export function intentStrategyFor(feedKey: FeedKey): IntentStrategy {
  const strategy = INTENT_STRATEGY_BY_FEED[feedKey];
  if (!strategy) throw new Error(`intentStrategyFor: no IntentStrategy for feed ${feedKey}`);
  return strategy;
}

const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    reasoning: { type: 'string' },
    evidence: { type: 'string' },
    label: { type: 'string', enum: ['directive', 'personal-advice', 'general-education'] },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
  },
  required: ['reasoning', 'evidence', 'label', 'confidence'],
} as const;

function isIntentClassification(value: unknown): value is IntentClassification {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.reasoning === 'string'
    && typeof v.evidence === 'string'
    && (v.label === 'directive' || v.label === 'personal-advice' || v.label === 'general-education')
    && (v.confidence === 'high' || v.confidence === 'medium' || v.confidence === 'low');
}

// The model, unlike temperature, isn't a caller-supplied tuning knob -- a repeated-trial
// validation against the calibration set showed model choice affects accuracy and
// confidence-stability far more than prompt wording does (llama-3.3-70b-instruct-fp8-fast: 17/19
// correct across 3 trials each vs. llama-3.1-8b-instruct-fast's 14/19, with the smaller model's
// confidence flipping low/high/low across identical repeated calls on at least one real example).
// Swapping models is a real behavioral change that needs the same validation pass before trusting
// it, not something safe to flip via an env var at 2am -- same reasoning as POS_PATTERNS/
// NEG_PATTERNS being hardcoded constants rather than configurable, not a tuning-knob axis like
// temperature. Must be one of Cloudflare's JSON-Mode-capable chat models (messages +
// response_format/json_schema).
const MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';

// Confirms whether a NEEDS_INTENT_CONFIRMATION regex match (@li/core) is a genuine directive,
// personal advice, or general education, using the calling forum's own IntentStrategy (see
// intentStrategyFor above). Throws on any failure (model error, schema violation); the caller
// owns the fail-open behavior (see runChannel in index.ts). temperature is caller-supplied
// (SELL_FRACTION_INTENT_TEMPERATURE) since it's a genuine tuning knob -- any value in its valid
// range is safe, it only adjusts randomness, not which reasoning engine is doing the judging.
export async function classifyActionableIntent(env: { AI: Ai }, text: string, temperature: number, strategy: IntentStrategy): Promise<IntentClassification> {
  const messages = [
    { role: 'system' as const, content: strategy.systemPrompt },
    ...strategy.fewShot.flatMap(({ post, response }) => [
      { role: 'user' as const, content: post },
      { role: 'assistant' as const, content: JSON.stringify(response) },
    ]),
    { role: 'user' as const, content: text },
  ];
  const result = await env.AI.run(MODEL as never, {
    messages,
    temperature,
    response_format: { type: 'json_schema', json_schema: RESPONSE_SCHEMA },
  } as never) as unknown as { response: unknown };
  if (!isIntentClassification(result.response)) {
    throw new Error('classifyActionableIntent: model response did not match the expected shape');
  }
  return result.response;
}
