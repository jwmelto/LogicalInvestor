// isFeedVisible/FEEDS are pure — no I/O — but feedService.ts transitively imports authService
// (expo-secure-store) and topicService (which imports storageService/AsyncStorage), neither of
// which resolve cleanly under Jest without a native-module bridge. Mock them out; nothing under
// test here calls into either.
jest.mock('../authService', () => ({ getToken: jest.fn() }));
jest.mock('../topicService', () => ({ updateTopicsFromFeedItems: jest.fn() }));

import { FeedKeys } from '@li/core';
import { isFeedVisible, FEEDS } from '../feedService';

describe('isFeedVisible', () => {
  it('is always visible for a feed with alwaysVisible: true, regardless of the visibility prefs', () => {
    expect(FEEDS.membersArea.alwaysVisible).toBe(true);
    expect(isFeedVisible(FeedKeys.membersArea, { stockInsights: false, optionsInsights: false })).toBe(true);
  });

  it('follows the stored preference for stockInsights', () => {
    expect(isFeedVisible(FeedKeys.stockInsights, { stockInsights: true, optionsInsights: false })).toBe(true);
    expect(isFeedVisible(FeedKeys.stockInsights, { stockInsights: false, optionsInsights: false })).toBe(false);
  });

  it('follows the stored preference for optionsInsights', () => {
    expect(isFeedVisible(FeedKeys.optionsInsights, { stockInsights: false, optionsInsights: true })).toBe(true);
    expect(isFeedVisible(FeedKeys.optionsInsights, { stockInsights: false, optionsInsights: false })).toBe(false);
  });
});
