import { matchNegativePattern, matchPositivePattern } from './index';

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

// Closed-class discourse markers (hedge modals, personal-address, historical reference,
// negation) are reliable enough to gate on directly — no reason to make the embedding step
// re-derive what a keyword already answers with confidence.
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
// keyword opinion at all (fail-no-signal/fail-too-short) reaches nearest-neighbor now — exactly
// the open-ended discourse-judgment cases this prototype exists to handle.
export function classifyActionableHybrid(text: string, vector: number[], examples: LabeledVector[]): HybridResult {
  if (matchNegativePattern(text)) {
    return { isActionable: false, nearestText: text, similarity: 1, viaKeyword: true };
  }
  if (matchPositivePattern(text) !== null) {
    return { isActionable: true, nearestText: text, similarity: 1, viaKeyword: true };
  }
  return { ...nearestNeighbor(vector, examples), viaKeyword: false };
}
