import { resolveIntentGate, type IntentClassification, type IntentLabel } from '../index';

function intent(label: IntentClassification['label'], confidence: IntentClassification['confidence']): IntentClassification {
  return { reasoning: 'irrelevant', evidence: 'irrelevant', label, confidence };
}

// Mirrors STOCK_PICK_STRATEGY.suppressibleLabels (@li/core) -- both non-directive labels suppress.
const STOCK_SUPPRESSIBLE: Set<IntentLabel> = new Set(['personal-advice', 'general-education']);
// Mirrors OPTIONS_STRATEGY.suppressibleLabels (@li/core) -- personal-advice never suppresses,
// since a reply naming a concrete strike and expiry is exactly as actionable as a broadcast one.
const OPTIONS_SUPPRESSIBLE: Set<IntentLabel> = new Set(['general-education']);

describe('resolveIntentGate', () => {
  test('a directive at high confidence stays actionable', () => {
    expect(resolveIntentGate(intent('directive', 'high'), STOCK_SUPPRESSIBLE)).toEqual({ actionable: true, result: 'pass-sell-fraction' });
  });

  test('a directive at low confidence still stays actionable -- a missed alert costs more than a false alarm', () => {
    expect(resolveIntentGate(intent('directive', 'low'), STOCK_SUPPRESSIBLE)).toEqual({ actionable: true, result: 'pass-sell-fraction' });
  });

  test('personal advice at high confidence is suppressed when personal-advice is in suppressibleLabels', () => {
    expect(resolveIntentGate(intent('personal-advice', 'high'), STOCK_SUPPRESSIBLE)).toEqual({ actionable: false, result: 'fail-personal-advice' });
  });

  test('personal advice below high confidence defaults to actionable rather than being trusted either way', () => {
    expect(resolveIntentGate(intent('personal-advice', 'medium'), STOCK_SUPPRESSIBLE)).toEqual({ actionable: true, result: 'pass-sell-fraction' });
    expect(resolveIntentGate(intent('personal-advice', 'low'), STOCK_SUPPRESSIBLE)).toEqual({ actionable: true, result: 'pass-sell-fraction' });
  });

  test('general education at high confidence is suppressed', () => {
    expect(resolveIntentGate(intent('general-education', 'high'), STOCK_SUPPRESSIBLE)).toEqual({ actionable: false, result: 'fail-general-education' });
  });

  test('general education below high confidence defaults to actionable', () => {
    expect(resolveIntentGate(intent('general-education', 'medium'), STOCK_SUPPRESSIBLE)).toEqual({ actionable: true, result: 'pass-sell-fraction' });
  });

  // Options's own suppressibleLabels excludes personal-advice -- see OPTIONS_STRATEGY (@li/core)
  // and its comment for why: an options reply naming a concrete strike and expiry is only
  // tradeable for a narrow window, so it's worth alerting on regardless of who it was addressed to.
  test('personal advice at high confidence still stays actionable when personal-advice is not in suppressibleLabels', () => {
    expect(resolveIntentGate(intent('personal-advice', 'high'), OPTIONS_SUPPRESSIBLE)).toEqual({ actionable: true, result: 'pass-sell-fraction' });
  });

  test('general education at high confidence is still suppressed under the options policy', () => {
    expect(resolveIntentGate(intent('general-education', 'high'), OPTIONS_SUPPRESSIBLE)).toEqual({ actionable: false, result: 'fail-general-education' });
  });
});
