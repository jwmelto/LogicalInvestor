// FEEDS[k].isVisible is pure — no I/O — but feedService.ts transitively imports authService
// (expo-secure-store) and topicService (which imports storageService/AsyncStorage), neither of
// which resolve cleanly under Jest without a native-module bridge. Mock them out; nothing under
// test here calls into either.
jest.mock('../authService', () => ({ getToken: jest.fn() }));
// topicService pulls in storageService (AsyncStorage/react-native), which doesn't resolve under
// Jest without a native-module bridge — stub it out so requireActual below can load topicService's
// real (pure) extractTopicSlugFromLink/generateTopicUrl without touching real storage.
jest.mock('../storageService', () => ({ storageGetObject: jest.fn(), storageSetObject: jest.fn() }));
jest.mock('../topicService', () => ({
  ...jest.requireActual('../topicService'),
  updateTopicsFromFeedItems: jest.fn(),
  deleteTopic: jest.fn(),
}));

import { FEEDS, fetchSingleFeed, fetchTopicFeed } from '../feedService';
import { getToken } from '../authService';
import { deleteTopic, Topic } from '../topicService';

const mockDeleteTopic = deleteTopic as jest.Mock;

const makeTopic = (slug: string, forumKey: Topic['forumKey'] = 'stockInsights'): Topic => ({
  id: `${forumKey}:${slug}`,
  name: slug,
  slug,
  forumKey,
  discoveredAt: 0,
  lastUpdatedAt: 0,
  itemCount: 1,
  latestAuthor: 'Author',
  latestExcerpt: '',
  latestItemId: `${slug}-latest`,
  latestItemLink: '',
});

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

describe('fetchTopicFeed', () => {
  beforeEach(() => {
    (getToken as jest.Mock).mockResolvedValue('tok');
    global.fetch = jest.fn();
    mockDeleteTopic.mockReset();
  });

  it('returns items as-is when the first item matches the requested topic slug', async () => {
    const rss = `<rss><channel>
      <item>
        <guid>g1</guid><title>First</title>
        <link>https://logicalinvestor.net/forums/topic/zqr/#post-1</link>
        <pubDate>Wed, 29 Jul 2026 12:00:00 +0000</pubDate>
        <dc:creator>Author</dc:creator><description>a</description>
      </item>
      <item>
        <guid>g2</guid><title>Reply To: First</title>
        <link>https://logicalinvestor.net/forums/topic/zqr/page/2/#post-2</link>
        <pubDate>Wed, 29 Jul 2026 11:00:00 +0000</pubDate>
        <dc:creator>Other</dc:creator><description>b</description>
      </item>
    </channel></rss>`;
    (global.fetch as jest.Mock).mockResolvedValue({ ok: true, text: () => Promise.resolve(rss) });

    const { items, deleted } = await fetchTopicFeed(makeTopic('zqr', 'membersForum'), 'membersForum');

    expect(items.map((i) => i.guid)).toEqual(['g1', 'g2']);
    expect(deleted).toBe(false);
    expect(mockDeleteTopic).not.toHaveBeenCalled();
  });

  // A dead/deleted topic's permalink doesn't reliably 404 on the /feed/ suffix — confirmed live:
  // it 200s with the parent forum's general feed instead. A genuine topic feed's items always
  // link back to that same topic, so a first-item mismatch is proof this is the wrong feed
  // entirely, not just a bad item.
  it('deletes the topic and returns nothing when the first item does not match the requested slug', async () => {
    const rss = `<rss><channel>
      <item>
        <guid>g1</guid><title>Unrelated content</title>
        <link>https://logicalinvestor.net/forums/topic/some-other-topic/#post-2</link>
        <pubDate>Wed, 29 Jul 2026 11:00:00 +0000</pubDate>
        <dc:creator>Other</dc:creator><description>unrelated</description>
      </item>
    </channel></rss>`;
    (global.fetch as jest.Mock).mockResolvedValue({ ok: true, text: () => Promise.resolve(rss) });

    const { items, deleted } = await fetchTopicFeed(makeTopic('ecolab-inc', 'stockInsights'), 'stockInsights');

    expect(items).toEqual([]);
    expect(deleted).toBe(true);
    expect(mockDeleteTopic).toHaveBeenCalledWith('stockInsights:ecolab-inc');
  });
});
