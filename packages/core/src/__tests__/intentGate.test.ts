import { resolveIntentGate, type IntentClassification } from '../index';

function intent(label: IntentClassification['label'], confidence: IntentClassification['confidence']): IntentClassification {
  return { reasoning: 'irrelevant', evidence: 'irrelevant', label, confidence };
}

describe('resolveIntentGate', () => {
  test('a directive at high confidence stays actionable', () => {
    expect(resolveIntentGate(intent('directive', 'high'))).toEqual({ actionable: true, result: 'pass-sell-fraction' });
  });

  test('a directive at low confidence still stays actionable -- a missed alert costs more than a false alarm', () => {
    expect(resolveIntentGate(intent('directive', 'low'))).toEqual({ actionable: true, result: 'pass-sell-fraction' });
  });

  test('personal advice at high confidence is suppressed', () => {
    expect(resolveIntentGate(intent('personal-advice', 'high'))).toEqual({ actionable: false, result: 'fail-personal-advice' });
  });

  test('personal advice below high confidence defaults to actionable rather than being trusted either way', () => {
    expect(resolveIntentGate(intent('personal-advice', 'medium'))).toEqual({ actionable: true, result: 'pass-sell-fraction' });
    expect(resolveIntentGate(intent('personal-advice', 'low'))).toEqual({ actionable: true, result: 'pass-sell-fraction' });
  });

  test('general education at high confidence is suppressed', () => {
    expect(resolveIntentGate(intent('general-education', 'high'))).toEqual({ actionable: false, result: 'fail-general-education' });
  });

  test('general education below high confidence defaults to actionable', () => {
    expect(resolveIntentGate(intent('general-education', 'medium'))).toEqual({ actionable: true, result: 'pass-sell-fraction' });
  });
});
