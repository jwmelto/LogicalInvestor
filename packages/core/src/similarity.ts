import { classifySignal, isSignalUndecided, type ActionableResult } from './index';

export interface LabeledVector {
  text: string;
  isActionable: boolean;
  vector: number[];
}

export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

export interface NearestNeighborResult {
  isActionable: boolean;
  nearestText: string;
  similarity: number;
}

// Ties break toward the earlier entry in `examples` — irrelevant in practice since two
// real embeddings landing on an exact float tie is not a case worth resolving deliberately.
export function nearestNeighbor(query: number[], examples: LabeledVector[]): NearestNeighborResult {
  if (examples.length === 0) throw new Error('nearestNeighbor requires at least one labeled example');
  let best = examples[0];
  let bestSim = cosineSimilarity(query, best.vector);
  for (const ex of examples.slice(1)) {
    const sim = cosineSimilarity(query, ex.vector);
    if (sim > bestSim) {
      best = ex;
      bestSim = sim;
    }
  }
  return { isActionable: best.isActionable, nearestText: best.text, similarity: bestSim };
}

export interface HybridResult extends NearestNeighborResult {
  viaKeyword: boolean;
}

// Below this, nearest-neighbor's answer isn't trusted -- default to not-actionable instead.
// Grounded in the calibration set's own leave-one-out distribution: every correct match observed
// scores >= 0.707; a real post-deploy false alarm ("Good job. Congrats!", matched purely on
// generic congratulatory tone with nothing else to anchor on) scored 0.697, below that floor.
// 0.70 sits just under the lowest correct match seen. This doesn't fix within-distribution
// confusions -- the one remaining leave-one-out miss scores 0.834, well above any reasonable
// floor -- it's specifically a safety net for low-content queries with too little signal to
// judge at all, not a general accuracy lever. Based on only 9 leave-one-out data points that
// currently reach this path; worth revisiting as real misses accumulate.
const MIN_CONFIDENT_SIMILARITY = 0.7;

// Closed-class discourse markers (hedge modals, personal-address, historical reference,
// negation) are reliable enough to gate on directly — no reason to make the embedding step
// re-derive what a keyword already answers with confidence. Same for the necessary-condition
// action-verb check (see ACTION_VERB in index.ts) — absence of any trade-action verb is a
// definitive negative, not something worth spending a live embedding call to re-confirm.
//
// Every POS_PATTERN gates the same way, not just IMMEDIATELY. An earlier version trusted only
// IMMEDIATELY here, leaving the rest (sell-fraction, tranche-price, buy-with-price, ...) to
// nearest-neighbor on the theory that they're topically-confusable, directive-vs-retrospective
// cases. Measured leave-one-out against the calibration set showed the opposite: nearest-neighbor
// was overriding cases regex already got right — e.g. "Buy Quixtol (QTPZ) at the market as long
// as the stock is at $66 per share or LOWER" is an unambiguous match for pass-buy-with-price, but
// its nearest embedding neighbor happened to be a different, unrelated example. Gating regex's
// positive result in fixed every such regression (6 missed alerts) at the cost of reintroducing
// regex's own false positives on cases nearest-neighbor had been correctly overriding (3 false
// alarms) — the right trade when a missed alert costs more than a false alarm, which is the case
// here (a subscriber missing a real buy call vs. one extra notification). Only text with no
// keyword opinion at all reaches nearest-neighbor now — exactly the open-ended discourse-judgment
// cases this prototype exists to handle.
//
// Goes through classifySignal, the single source of truth for what regex/action-verb resolves
// definitively, rather than re-deriving the pattern sequence by hand: the action-verb gate was
// added to classifySignal, correctly, but this function still called matchNegativePattern/
// matchPositivePattern directly and silently missed it — caught only by re-running the
// leave-one-out suite, not by inspection. Duplicating the sequence is what made that possible;
// routing through classifySignal is what prevents it recurring for the next gate added here.
//
// examples and posPatterns both come from the same forum's ActionableStrategy (see
// actionableStrategyFor in index.ts) -- a caller comparing against one forum's calibration set
// while gating on a different forum's regex patterns would be a real, silent bug, not a
// hypothetical one, so both are threaded through together from the same lookup rather than chosen
// independently at each call site.
export function classifyActionableHybrid(text: string, vector: number[], examples: LabeledVector[], posPatterns?: [RegExp, ActionableResult][]): HybridResult {
  const signal = classifySignal(text, 0, posPatterns);
  if (!isSignalUndecided(signal)) {
    return { isActionable: signal.startsWith('pass'), nearestText: text, similarity: 1, viaKeyword: true };
  }
  const result = nearestNeighbor(vector, examples);
  const isActionable = result.similarity >= MIN_CONFIDENT_SIMILARITY && result.isActionable;
  return { ...result, isActionable, viaKeyword: false };
}
