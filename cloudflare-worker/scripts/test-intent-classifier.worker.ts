// ponytail: scratch tool for eyeballing classifySellFractionIntent's real output before wiring
// review, not part of the deployed worker. Run via:
//   npx wrangler dev -c scripts/wrangler.intent.toml
// then POST { "texts": string[], "temperature"?: number, "model"?: string } to it and inspect the
// reasoning per text. `model` is a scratch-only override for comparing model quality -- the real
// classifySellFractionIntent hardcodes its model, this just re-implements the same call shape
// against an arbitrary model id for experimentation.
import type { IntentClassification } from '@li/core';

const SYSTEM_PROMPT = `You are classifying a single forum post from a stock-trading newsletter. The post already contains "sell half"/"sell all"-style language, which can mean one of three different things:

- directive: a live instruction for readers to act now on a specific holding. Look for a specific trigger (a price, a % gain, a tranche number) tied to a plural or unaddressed/broadcast audience ("many of you", "y'all", "everyone", "those of you in X", or no addressee at all -- stated flatly as newsletter guidance).
- personal-advice: a reply giving one specific person advice about their own individual situation -- addressed to a singular "you"/"your" responding to THAT PERSON'S OWN reported gain or holding ("you're up that much", "what you have left"), not a plural or generic audience.
- general-education: explaining how the trading strategy or market mechanics work in general. The telltale sign is the post names no specific holding, no specific price, and no specific trigger to act on right now -- it's explaining WHY or HOW the approach works (a numbered list of reasons, "the reason we...", "so that...", describing the method itself), not reporting on a live position.

Confidence calibration -- do not default to a low or medium confidence out of general caution:
- Use "high" whenever the post clearly fits the telltale signs above, even if it also contains action words like "sell" or "buy". A numbered explanation of strategy mechanics is high-confidence general-education regardless of which action verbs appear inside it. A reply naming one person's own specific gain is high-confidence personal-advice regardless of brevity.
- Use "medium" only when the post has real signals pointing to more than one category (e.g. it names a specific price AND lacks any addressee at all).
- Use "low" only when the post is too short or too stripped of context to judge at all (e.g. a bare sentence fragment with no stated trigger, no stated addressee, and no explanatory content).

Read the post, quote the exact evidence, reason about which of the three categories it belongs to, then give your verdict. Respond only with the requested JSON.`;

const FEW_SHOT: { post: string; response: IntentClassification }[] = [
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
];

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

export default {
  async fetch(request: Request, env: { AI: Ai }): Promise<Response> {
    if (request.method !== 'POST') return new Response('POST only', { status: 405 });
    const { texts, temperature = 0, model = '@cf/meta/llama-3.1-8b-instruct-fast' } = await request.json() as { texts: string[]; temperature?: number; model?: string };
    const messages = [
      { role: 'system' as const, content: SYSTEM_PROMPT },
      ...FEW_SHOT.flatMap(({ post, response }) => [
        { role: 'user' as const, content: post },
        { role: 'assistant' as const, content: JSON.stringify(response) },
      ]),
    ];
    const results = await Promise.all(texts.map(async (text) => {
      try {
        const result = await env.AI.run(model as never, {
          messages: [...messages, { role: 'user' as const, content: text }],
          temperature,
          response_format: { type: 'json_schema', json_schema: RESPONSE_SCHEMA },
        } as never) as unknown as { response: unknown };
        return { text, ...(result.response as object) };
      } catch (err) {
        return { text, error: String(err) };
      }
    }));
    return Response.json(results);
  },
};
