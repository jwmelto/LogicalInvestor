jest.mock('react-native', () => ({
  Platform: { OS: 'ios' },
}));

const scheduleNotificationAsync = jest.fn().mockResolvedValue('id');
jest.mock('expo-notifications', () => ({
  scheduleNotificationAsync: (...args: unknown[]) => scheduleNotificationAsync(...args),
}));

let stored: Record<string, unknown> = {};
jest.mock('../storageService', () => ({
  storageGetObject: jest.fn((key: string) => Promise.resolve(stored[key] ?? null)),
  storageSetObject: jest.fn((key: string, value: unknown) => {
    stored[key] = value;
    return Promise.resolve();
  }),
}));

jest.mock('../pushService', () => ({
  getPushLevel: jest.fn().mockResolvedValue('none'), // 'none' => wouldServerPush always false
}));

// feedService.ts (imported for FEEDS) pulls in authService.ts -> expo-secure-store, which isn't
// transformable under this project's jest config; cut the chain before it gets there.
jest.mock('../authService', () => ({ getToken: jest.fn() }));

const isTopicSubscribed = jest.fn();
jest.mock('../subscriptionService', () => ({
  isTopicSubscribed: (...args: unknown[]) => isTopicSubscribed(...args),
}));

import { processNewItemsForNotifications } from '../notificationService';
import { RssItem } from '../feedService';

// title is pre-normalized here to match what extractRssItems actually produces (the "Reply To: "
// prefix is stripped at parse time — see packages/core/src/index.ts).
function topicReply(overrides: Partial<RssItem> = {}): RssItem {
  return {
    guid: 'post-2',
    title: 'NVO',
    link: 'https://logicalinvestor.net/forums/topic/nvo/#post-2',
    pubDate: new Date(),
    author: 'Sean Hyman',
    description: 'x'.repeat(250),
    feedKey: 'membersForum',
    ...overrides,
  };
}

describe('processNewItemsForNotifications', () => {
  beforeEach(() => {
    stored = { notification_seen_ids: { membersForum: ['post-1'] } }; // not a first-run for this feed
    scheduleNotificationAsync.mockClear();
    isTopicSubscribed.mockReset();
  });

  it('does not notify for a silenced topic', async () => {
    isTopicSubscribed.mockResolvedValue(false);
    await processNewItemsForNotifications([topicReply()]);
    expect(scheduleNotificationAsync).not.toHaveBeenCalled();
  });

  it('notifies for a subscribed topic', async () => {
    isTopicSubscribed.mockResolvedValue(true);
    await processNewItemsForNotifications([topicReply()]);
    expect(scheduleNotificationAsync).toHaveBeenCalledTimes(1);
  });

  it('does not notify for stale backlog content even if subscribed', async () => {
    isTopicSubscribed.mockResolvedValue(true);
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    await processNewItemsForNotifications([topicReply({ pubDate: threeDaysAgo })]);
    expect(scheduleNotificationAsync).not.toHaveBeenCalled();
  });

  it('does not consult subscriptions for flat feeds (Members Area has no topics)', async () => {
    stored = { notification_seen_ids: { membersArea: ['post-1'] } };
    await processNewItemsForNotifications([
      topicReply({ guid: 'post-2', feedKey: 'membersArea', title: 'Weekly Update' }),
    ]);
    expect(isTopicSubscribed).not.toHaveBeenCalled();
    expect(scheduleNotificationAsync).toHaveBeenCalledTimes(1);
  });
});
