import { describe, it, expect } from 'vitest';
import { FeedKeys } from '@li/core';
import { intentStrategyFor } from './intentClassifier';

// Direct coverage of the IntentStrategy content itself, independent of whether any feed's
// ActionableStrategy.needsIntentConfirmation currently routes traffic to it. Options Insights'
// strategy has no live traffic today (see OPTIONS_NEEDS_INTENT_CONFIRMATION's comment, @li/core),
// but the strategy pattern is kept for every feed regardless -- this is what proves that content
// stays correct even while dormant.
describe('intentStrategyFor', () => {
  it('Members Forum and Stock Insights share the same stock strategy object', () => {
    expect(intentStrategyFor(FeedKeys.membersForum)).toBe(intentStrategyFor(FeedKeys.stockInsights));
  });

  it('Options Insights has its own strategy, distinct from the stock one', () => {
    expect(intentStrategyFor(FeedKeys.optionsInsights)).not.toBe(intentStrategyFor(FeedKeys.stockInsights));
  });

  it('the stock strategy prompt is stock-flavored', () => {
    expect(intentStrategyFor(FeedKeys.stockInsights).systemPrompt).toContain('stock-trading newsletter');
  });

  it('the options strategy prompt is options-flavored, not the stock one', () => {
    expect(intentStrategyFor(FeedKeys.optionsInsights).systemPrompt).toContain('options-trading newsletter');
  });

  it('each strategy has at least one few-shot example', () => {
    expect(intentStrategyFor(FeedKeys.stockInsights).fewShot.length).toBeGreaterThan(0);
    expect(intentStrategyFor(FeedKeys.optionsInsights).fewShot.length).toBeGreaterThan(0);
  });

  it('throws for a feed with no IntentStrategy entry', () => {
    expect(() => intentStrategyFor(FeedKeys.membersArea)).toThrow();
  });
});
