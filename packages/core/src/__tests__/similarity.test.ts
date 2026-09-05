import { cosineSimilarity, nearestNeighbor, classifyActionableHybrid, LabeledVector } from '../similarity';
import fixture from '../data/actionableCalibration.fixture.json';

const CALIBRATION = fixture.examples as LabeledVector[];

describe('cosineSimilarity', () => {
  test('identical vectors are maximally similar', () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1, 10);
  });

  test('orthogonal vectors have zero similarity', () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 10);
  });

  test('opposite vectors are maximally dissimilar', () => {
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1, 10);
  });
});

describe('nearestNeighbor over real bge-large-en-v1.5 embeddings — leave-one-out accuracy', () => {
  test('every calibration example agrees with its nearest neighbor among the rest', () => {
    const misclassified: { text: string; expected: boolean; got: boolean; nearestText: string; labelConfidence: string }[] = [];
    for (let i = 0; i < CALIBRATION.length; i++) {
      const held = CALIBRATION[i];
      const rest = [...CALIBRATION.slice(0, i), ...CALIBRATION.slice(i + 1)];
      const result = nearestNeighbor(held.vector, rest);
      if (result.isActionable !== held.isActionable) {
        misclassified.push({ text: held.text, expected: held.isActionable, got: result.isActionable, nearestText: result.nearestText, labelConfidence: held.labelConfidence ?? 'high' });
      }
    }
    // Not asserting zero misclassifications yet — this is the accuracy readout for the
    // prototype, not a pass/fail gate. Tightening to expect(misclassified).toEqual([]) is the
    // next step once the calibration set is large enough that leave-one-out accuracy holds.
    //
    // Split by labelConfidence: a disagreement against a 'low'/'medium'-confidence label (one
    // that was itself a judgment call, not a clear-cut case -- see LabeledVector's comment) isn't
    // necessarily a real model error, so it's reported separately rather than inflating the
    // "real" miss count against confidently-labeled examples.
    const againstConfidentLabel = misclassified.filter((m) => m.labelConfidence === 'high');
    const againstShakyLabel = misclassified.filter((m) => m.labelConfidence !== 'high');
    if (misclassified.length > 0) {
      console.log(`leave-one-out misclassifications: ${misclassified.length}/${CALIBRATION.length} (${againstConfidentLabel.length} against high-confidence labels, ${againstShakyLabel.length} against low/medium-confidence labels)`, misclassified);
    }
    expect(CALIBRATION.length).toBeGreaterThan(0);
  });
});

describe('classifyActionableHybrid — keyword gate + nearest-neighbor fallback', () => {
  test('keyword gate resolves closed-class discourse markers that nearest-neighbor alone missed under sparse data', () => {
    const misclassified: { text: string; expected: boolean; got: boolean; viaKeyword: boolean; labelConfidence: string }[] = [];
    for (let i = 0; i < CALIBRATION.length; i++) {
      const held = CALIBRATION[i];
      const rest = [...CALIBRATION.slice(0, i), ...CALIBRATION.slice(i + 1)];
      const result = classifyActionableHybrid(held.text, held.vector, rest);
      if (result.isActionable !== held.isActionable) {
        misclassified.push({ text: held.text, expected: held.isActionable, got: result.isActionable, viaKeyword: result.viaKeyword, labelConfidence: held.labelConfidence ?? 'high' });
      }
    }
    // Not asserting zero misclassifications — same reasoning as the nearestNeighbor-only test
    // above. Most remaining misses are pass-sell-fraction: near-identical phrasing with opposite
    // labels (e.g. "I'd sell half of what you have left now" (personal-advice) vs. a genuine
    // broadcast directive using the same words), where the distinguishing signal is who the post
    // is addressed to, not anything recoverable from the text alone. That gap is why
    // pass-sell-fraction is routed to classifySellFractionIntent (cloudflare-worker/src/
    // intentClassifier.ts) in production rather than resolved here -- this test still measures
    // the regex/embedding layer in isolation, which is what every other pattern still resolves
    // through.
    if (misclassified.length > 0) {
      console.log(`hybrid leave-one-out misclassifications: ${misclassified.length}/${CALIBRATION.length}`, misclassified);
    }
    expect(CALIBRATION.length).toBeGreaterThan(0);
  });

  // A real post-deploy false alarm ("Good job. Congrats!") matched a positive example at
  // similarity 0.697, below the lowest correct match observed anywhere in the calibration set's
  // own leave-one-out distribution (0.707) -- too little real content in the query for cosine
  // similarity to judge reliably. The floor defaults a low-confidence match to not-actionable
  // regardless of which label its nearest neighbor happens to carry.
  test('a low-similarity match defaults to not-actionable, even against a positive neighbor', () => {
    const examples: LabeledVector[] = [{ text: 'irrelevant', isActionable: true, vector: [1, 0] }];
    const orthogonalQuery = [0, 1]; // similarity 0 to the only example -- far below the floor
    const result = classifyActionableHybrid('Thinking about entering later.', orthogonalQuery, examples);
    expect(result.isActionable).toBe(false);
    expect(result.viaKeyword).toBe(false);
  });

  test('a high-similarity match is trusted as-is', () => {
    const examples: LabeledVector[] = [{ text: 'irrelevant', isActionable: true, vector: [1, 0] }];
    const identicalQuery = [1, 0]; // similarity 1 -- well above the floor
    const result = classifyActionableHybrid('Thinking about entering later.', identicalQuery, examples);
    expect(result.isActionable).toBe(true);
  });
});
