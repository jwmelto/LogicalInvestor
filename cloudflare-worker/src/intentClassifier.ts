import { FeedKeys, type FeedKey, type IntentClassification } from '@li/core';

// The regexes that route a post here (each forum's own ActionableStrategy.needsIntentConfirmation,
// @li/core) are tuned for recall over precision -- worded broadly enough that the same trigger
// phrase can be used identically by a genuine group directive, a reply giving one person advice
// about their own situation, and general strategy/mechanics education. No keyword or
// embedding-similarity check can separate those (see resolveIntentGate's comment in @li/core for
// the measured leave-one-out evidence), so precision is recovered here instead of by narrowing
// the regex.
//
// One IntentStrategy per vocabulary, same reasoning as ActionableStrategy in @li/core keeping
// posPatterns/calibration per forum: stock-pick and options discourse are different enough that a
// fix tuned for one shouldn't risk changing the other's behavior. Members Forum and Stock
// Insights share STOCK_INTENT_STRATEGY for the same reason they share STOCK_PICK_STRATEGY.
export interface IntentStrategy {
  systemPrompt: string;
  fewShot: { post: string; response: IntentClassification }[];
}

// Shared across vocabularies deliberately -- unlike the category definitions below, uniform
// confidence rules are what make "high" mean the same thing whether the strategy is stock or
// options.
const CONFIDENCE_CALIBRATION = `Do not default to low or medium confidence out of caution. Apply these rules directly:
- Use high when the post clearly and completely matches one category's own definition above, with no real signal pointing to a different category.
- Use medium when the post has real signals pointing to more than one category. For example, it names a specific trigger but has no addressee at all.
- Use low when the post is too short or too stripped of context to judge at all. For example, a bare sentence fragment with no stated trigger, no stated addressee, and no explanatory content.

Read the post. Quote the exact evidence. Reason about which of the three categories it belongs to. Then give your verdict. Respond only with the requested JSON.`;

const STOCK_CATEGORY_DEFINITIONS = `- directive: a live instruction to act now on a specific holding. It names a specific trigger: a price, a percent gain, or a tranche number. It is addressed to a plural or broadcast audience, such as "many of you", "y'all", "everyone", or "those of you in X". Or it has no addressee at all and reads as flat newsletter guidance. Or it addresses a singular "you" with a general condition anyone could meet, such as "if you're up 20%+, go ahead and sell half" -- the condition is stated fresh in this post as a rule, not a fact already known about one person. An action word like "sell" or "buy", stated directly or clearly implied, is core evidence for this category.
- personal-advice: a reply giving one specific person advice about a fact of their situation already established before this post, such as "you're up that much" or "what you have left" -- referencing an amount or holding the post treats as already known, not a fresh conditional rule stated in the same post. It is not addressed to a plural or generic audience, and it is not a general "if you meet this condition" rule. This category can apply even to a very short post, such as one line naming the person's own already-known gain or holding.
- general-education: an explanation of how the trading strategy or market mechanics work in general. It names no specific holding, no specific price, and no specific trigger to act on right now. It explains why or how the approach works, often with a numbered list of reasons or phrases like "the reason we..." or "so that...". It describes the method itself. It does not report on a live position. It may still contain action words like "sell" or "buy"; there, they describe the method, not a live call.`;

const OPTIONS_CATEGORY_DEFINITIONS = `- directive: a live instruction to act now on a specific options contract. It names a strike price and an expiry month and year, such as "March $95 strike, 2026 expiry". It is addressed to a plural or broadcast audience. Or it has no addressee at all and reads as flat newsletter guidance. Or it addresses a singular "you" with a general condition anyone could meet, stated fresh in this post as a rule, not a fact already known about one person. An action word like "sell" or "buy", stated directly or clearly implied, is core evidence for this category.
- personal-advice: a reply giving one specific person advice about a fact of their situation already established before this post, such as their own reported gain or holding treated as already known, not a fresh conditional rule stated in the same post. It is not addressed to a plural or generic audience, and it is not a general "if you meet this condition" rule. This category can apply even to a very short post, such as one line naming the person's own already-known gain or holding.
- general-education: an explanation of how the options strategy or market mechanics work in general. It names no specific contract, no specific strike or expiry, and no specific trigger to act on right now. It explains why or how the approach works. It describes the method itself. It does not report on a live position. It may still contain action words like "sell" or "buy"; there, they describe the method, not a live call.`;

const STOCK_INTENT_STRATEGY: IntentStrategy = {
  systemPrompt: `You are classifying a single forum post from a stock-trading newsletter. The post already matched a broad, recall-tuned pattern for trade-related language: a "sell half"/"sell all" style call, or a "close enough...now" immediacy trigger. That match alone doesn't tell you what the post actually means. It is one of three things:

${STOCK_CATEGORY_DEFINITIONS}

${CONFIDENCE_CALIBRATION}`,
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
      post: "If you've not done a \"sell half\" on VNP yet and you're up 20%+, I'd go ahead and do that now.",
      response: {
        reasoning: 'The "you" here is a stand-in for anyone who meets the stated condition (up 20%+ and hasn\'t sold half yet), not a reply to one person\'s already-known situation. The condition itself is stated fresh in this post as a rule, the same as if it read "if anyone is up 20%+...". That makes it broadcast guidance despite the singular pronoun.',
        evidence: "If you've not done a \"sell half\" on VNP yet and you're up 20%+, I'd go ahead and do that now",
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
  systemPrompt: `You are classifying a single forum post from an options-trading newsletter. The post already matched a broad, recall-tuned pattern naming an options strike and expiry. That match alone doesn't tell you what the post actually means. It is one of three things:

${OPTIONS_CATEGORY_DEFINITIONS}

${CONFIDENCE_CALIBRATION}`,
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

// Confirms whether a needsIntentConfirmation regex match (@li/core) is a genuine directive,
// personal advice, or general education, using the calling forum's own IntentStrategy (see
// intentStrategyFor above). Throws on any failure (model error, schema violation); on error, the
// caller (runChannel in index.ts) keeps the regex's own verdict rather than suppressing the
// alert. temperature is caller-supplied (ACTIONABLE_INTENT_TEMPERATURE) since it's a genuine
// tuning knob -- any value in its valid range is safe, it only adjusts randomness, not which
// reasoning engine is doing the judging.
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
