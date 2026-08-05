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
// re-derive what a keyword already answers with confidence. IMMEDIATELY gets the same
// treatment on the positive side: it's a literal author convention (see its comment in
// index.ts), not open-ended phrasing, so it's exactly as gate-safe as the negative markers —
// unlike the rest of POS_PATTERNS (sell-fraction, averaging-down, ...), which stay with
// nearest-neighbor because they're the topically-confusable, directive-vs-retrospective cases
// this prototype exists to handle. Only text that clears both gates falls through.
export function classifyActionableHybrid(text: string, vector: number[], examples: LabeledVector[]): HybridResult {
  if (matchNegativePattern(text)) {
    return { isActionable: false, nearestText: text, similarity: 1, viaKeyword: true };
  }
  if (matchPositivePattern(text) === 'pass-immediately') {
    return { isActionable: true, nearestText: text, similarity: 1, viaKeyword: true };
  }
  return { ...nearestNeighbor(vector, examples), viaKeyword: false };
}
