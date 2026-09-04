import { matchesFilter, isActionablePost, isActionableCandidate, actionableStrategyFor, FeedKeys, type FilterItem, type ItemClassification } from '../index';

const ACTIONABLE_AUTHORS = ['sean hyman'];

function item(overrides: Partial<FilterItem> = {}): FilterItem {
  return { feedKey: FeedKeys.membersForum, author: 'sean hyman', title: '', content: '', ...overrides };
}

describe('isActionableCandidate', () => {
  it('passes for a matching author on a non-star-gated feed regardless of title', () => {
    expect(isActionableCandidate(item({ feedKey: FeedKeys.membersForum, title: '' }), ACTIONABLE_AUTHORS)).toBe(true);
  });

  it('fails for a non-matching author', () => {
    expect(isActionableCandidate(item({ author: 'Joe Blow' }), ACTIONABLE_AUTHORS)).toBe(false);
  });

  it.each([FeedKeys.stockInsights, FeedKeys.optionsInsights])('%s requires a starred title', (feedKey) => {
    expect(isActionableCandidate(item({ feedKey, title: 'Discussion' }), ACTIONABLE_AUTHORS)).toBe(false);
    expect(isActionableCandidate(item({ feedKey, title: '*Trade' }), ACTIONABLE_AUTHORS)).toBe(true);
  });
});

describe('isActionablePost (regex-only)', () => {
  it('is true for a matching author with a genuine positive signal', () => {
    expect(isActionablePost(item({ content: 'You need to get into this position IMMEDIATELY.' }), ACTIONABLE_AUTHORS)).toBe(true);
  });

  it('is false when the candidate gate fails, even with a positive signal', () => {
    expect(isActionablePost(item({ author: 'Joe Blow', content: 'IMMEDIATELY' }), ACTIONABLE_AUTHORS)).toBe(false);
  });

  it('is false with no regex signal at all', () => {
    expect(isActionablePost(item({ content: 'Just checking in, nothing new today.' }), ACTIONABLE_AUTHORS)).toBe(false);
  });

  it('resolves an Options Insights post against its own pattern set, not stock-pick vocabulary', () => {
    const post = item({ feedKey: FeedKeys.optionsInsights, title: '*Trade', content: 'You can get into the January $55 strike put, 2026 expiry now.' });
    expect(isActionablePost(post, ACTIONABLE_AUTHORS)).toBe(true);
  });

  it('a stock-pick-only signal does not resolve as actionable on Options Insights', () => {
    const post = item({ feedKey: FeedKeys.optionsInsights, title: '*Trade', content: "I've got a new pick for subscribers this month." });
    expect(isActionablePost(post, ACTIONABLE_AUTHORS)).toBe(false);
  });

  it('is false for Members Area, which has no actionable strategy', () => {
    const post = item({ feedKey: FeedKeys.membersArea, content: 'You need to get into this position IMMEDIATELY.' });
    expect(isActionablePost(post, ACTIONABLE_AUTHORS)).toBe(false);
  });
});

describe('actionableStrategyFor', () => {
  it('has an empty pattern set and calibration for Members Area, which bypasses the actionable tier entirely', () => {
    expect(actionableStrategyFor(FeedKeys.membersArea)).toEqual({ posPatterns: [], calibration: [] });
  });

  it.each([FeedKeys.membersForum, FeedKeys.stockInsights])('%s shares the same stock-pick strategy object', (feedKey) => {
    expect(actionableStrategyFor(feedKey)).toBe(actionableStrategyFor(FeedKeys.membersForum));
  });

  it('Options Insights has its own strategy, distinct from the stock-pick one', () => {
    expect(actionableStrategyFor(FeedKeys.optionsInsights)).not.toBe(actionableStrategyFor(FeedKeys.stockInsights));
  });
});

describe('matchesFilter (classification-driven dispatch)', () => {
  const actionable: ItemClassification = { members: false, actionable: true };
  const notActionable: ItemClassification = { members: false, actionable: false };
  const members: ItemClassification = { members: true, actionable: false };

  it('members classification alerts at every tier, regardless of authors/minLength', () => {
    for (const filter of ['members', 'actionable', 'length'] as const) {
      expect(matchesFilter(item(), filter, ['someone else'], 200, members)).toBe(true);
    }
  });

  it('members tier never alerts on a non-members classification', () => {
    expect(matchesFilter(item(), 'members', [], 200, actionable)).toBe(false);
    expect(matchesFilter(item(), 'members', [], 200, notActionable)).toBe(false);
  });

  it('actionable tier trusts the precomputed classification directly, no author whitelist check', () => {
    expect(matchesFilter(item(), 'actionable', ['someone else entirely'], 200, actionable)).toBe(true);
    expect(matchesFilter(item(), 'actionable', [], 200, notActionable)).toBe(false);
  });

  it('length tier is a strict superset: actionable classification qualifies unconditionally', () => {
    expect(matchesFilter(item(), 'length', ['someone else entirely'], 200, actionable)).toBe(true);
  });

  it('length tier falls through to its own author/minLength check when not already actionable', () => {
    const longPost = item({ author: 'Joe Blow', content: 'x'.repeat(210) });
    expect(matchesFilter(longPost, 'length', ['joe blow'], 200, notActionable)).toBe(true);
    expect(matchesFilter(longPost, 'length', ['someone else'], 200, notActionable)).toBe(false);
  });

  it('length tier still requires minLength when not already actionable', () => {
    const shortPost = item({ author: 'Joe Blow', content: 'short' });
    expect(matchesFilter(shortPost, 'length', ['joe blow'], 200, notActionable)).toBe(false);
  });
});
