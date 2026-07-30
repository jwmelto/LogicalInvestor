// FEEDS[k].isVisible is pure — no I/O — but feedService.ts transitively imports authService
// (expo-secure-store) and topicService (which imports storageService/AsyncStorage), neither of
// which resolve cleanly under Jest without a native-module bridge. Mock them out; nothing under
// test here calls into either.
jest.mock('../authService', () => ({ getToken: jest.fn() }));
jest.mock('../topicService', () => ({ updateTopicsFromFeedItems: jest.fn() }));

import { FEEDS, fetchSingleFeed } from '../feedService';
import { getToken } from '../authService';

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

describe('FeedResult.hasConfirmedNoAccess vs isSubscribed', () => {
  const emptyRss = '<rss><channel></channel></rss>';

  beforeEach(() => {
    (getToken as jest.Mock).mockResolvedValue('tok');
    global.fetch = jest.fn();
  });

  it('a genuine 200-with-zero-items response is confirmed no access', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({ ok: true, text: () => Promise.resolve(emptyRss) });

    const result = await fetchSingleFeed('stockInsights');

    expect(result.isSubscribed()).toBe(false);
    expect(result.hasConfirmedNoAccess()).toBe(true);
  });

  it('an HTTP error response is not confirmed no access, despite also having zero items', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({ ok: false, status: 503 });

    const result = await fetchSingleFeed('stockInsights');

    expect(result.isSubscribed()).toBe(false);
    expect(result.hasConfirmedNoAccess()).toBe(false);
    expect(result.error).toBe('HTTP 503');
  });

  it('a network failure is not confirmed no access, despite also having zero items', async () => {
    (global.fetch as jest.Mock).mockRejectedValue(new Error('Network request failed'));

    const result = await fetchSingleFeed('stockInsights');

    expect(result.isSubscribed()).toBe(false);
    expect(result.hasConfirmedNoAccess()).toBe(false);
    expect(result.error).toBe('Network request failed');
  });
});
