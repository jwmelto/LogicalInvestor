// FEEDS[k].isVisible is pure — no I/O — but feedService.ts transitively imports authService
// (expo-secure-store) and topicService (which imports storageService/AsyncStorage), neither of
// which resolve cleanly under Jest without a native-module bridge. Mock them out; nothing under
// test here calls into either.
jest.mock('../authService', () => ({ getToken: jest.fn() }));
jest.mock('../topicService', () => ({ updateTopicsFromFeedItems: jest.fn() }));

import { FEEDS } from '../feedService';

describe('FEEDS[k].isVisible', () => {
  it('membersArea is always visible, regardless of the visibility prefs', () => {
    expect(FEEDS.membersArea.isVisible({ stockInsights: false, optionsInsights: false })).toBe(true);
  });

  it('membersForum is always visible, regardless of the visibility prefs', () => {
    expect(FEEDS.membersForum.isVisible({ stockInsights: false, optionsInsights: false })).toBe(true);
  });

  it('stockInsights follows the stored preference', () => {
    expect(FEEDS.stockInsights.isVisible({ stockInsights: true, optionsInsights: false })).toBe(true);
    expect(FEEDS.stockInsights.isVisible({ stockInsights: false, optionsInsights: false })).toBe(false);
  });

  it('optionsInsights follows the stored preference', () => {
    expect(FEEDS.optionsInsights.isVisible({ stockInsights: false, optionsInsights: true })).toBe(true);
    expect(FEEDS.optionsInsights.isVisible({ stockInsights: false, optionsInsights: false })).toBe(false);
  });
});
