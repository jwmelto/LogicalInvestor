let store: Record<string, unknown> = {};

jest.mock('../storageService', () => ({
  storageGetObject: jest.fn((key: string) => Promise.resolve((store as any)[key] ?? null)),
  storageSetObject: jest.fn((key: string, value: unknown) => {
    (store as any)[key] = value;
    return Promise.resolve();
  }),
}));

jest.mock('../feedService', () => ({
  fetchTopicFeed: jest.fn(),
}));

jest.mock('../topicService', () => ({
  ...jest.requireActual('../topicService'),
  getTopicsForForum: jest.fn(),
}));

jest.mock('../subscriptionService', () => ({
  getAllTopicSubscriptions: jest.fn(),
}));

import {
  markScopesSeen,
  markGuidsRead,
  viewScope,
  hasUnread,
  isRead,
  markRead,
  markAllRead,
  markFlatFeedSeen,
  detectForumUnread,
  getAllScopes,
  topicUnreadForForum,
} from '../readStateService';
import { FeedKeys } from '@li/core';
import { fetchTopicFeed, RssItem } from '../feedService';
import { getTopicsForForum, Topic } from '../topicService';
import { getAllTopicSubscriptions } from '../subscriptionService';
import { storageGetObject, storageSetObject } from '../storageService';

const FK = FeedKeys;

const mockFetchTopicFeed = fetchTopicFeed as jest.Mock;
const mockGetTopicsForForum = getTopicsForForum as jest.Mock;
const mockGetAllTopicSubscriptions = getAllTopicSubscriptions as jest.Mock;
const mockStorageGetObject = storageGetObject as jest.Mock;

const item = (guid: string, slug = 'nvo'): RssItem => ({
  guid,
  title: 'Post',
  author: 'Author',
  description: '',
  link: `https://logicalinvestor.net/forums/topic/${slug}/#post-${guid}`,
  pubDate: new Date('2024-01-01'),
  feedKey: FK.membersForum,
  isFirstPost: true,
});

const topic = (slug: string, lastUpdatedAt = 1): Topic => ({
  id: `membersForum:${slug}`,
  name: slug,
  slug,
  forumKey: FK.membersForum,
  discoveredAt: 0,
  lastUpdatedAt,
  itemCount: 1,
  latestAuthor: 'Author',
  latestExcerpt: '',
  latestItemId: `${slug}-latest`,
  latestItemLink: '',
});

beforeEach(() => {
  store = {};
  mockFetchTopicFeed.mockReset().mockResolvedValue([]);
  mockGetTopicsForForum.mockReset().mockResolvedValue([]);
  mockGetAllTopicSubscriptions.mockReset().mockResolvedValue({});
  mockStorageGetObject.mockClear();
  (storageSetObject as jest.Mock).mockClear();
});

describe('viewScope', () => {
  it('reports hasUnread when any guid is unread', () => {
    expect(viewScope({ a: true, b: false }).hasUnread).toBe(true);
  });

  it('reports no unread when every guid is read', () => {
    expect(viewScope({ a: true, b: true }).hasUnread).toBe(false);
  });

  it('reports no unread for an empty scope', () => {
    expect(viewScope({}).hasUnread).toBe(false);
  });

  it('answers isRead per guid, defaulting to false for an unknown guid', () => {
    const view = viewScope({ a: true });
    expect(view.isRead('a')).toBe(true);
    expect(view.isRead('unknown')).toBe(false);
  });
});

describe('markScopesSeen / markGuidsRead', () => {
  it('inserts new guids as unread, never resurrecting an already-read guid', async () => {
    await markGuidsRead({ 'membersForum:nvo': ['guid-1'] }); // guid-1 starts out read
    await markScopesSeen({ 'membersForum:nvo': ['guid-1', 'guid-2'] }); // resurfaces + one new

    const scopes = await getAllScopes();
    expect(scopes['membersForum:nvo']).toEqual({ 'guid-1': true, 'guid-2': false });
  });

  it('keeps two scopes independent even when guids are identical strings', async () => {
    await markScopesSeen({
      [FK.membersArea]: ['shared-guid'],
      'membersForum:nvo': ['shared-guid'],
    });
    await markGuidsRead({ [FK.membersArea]: ['shared-guid'] });

    const scopes = await getAllScopes();
    expect(scopes[FK.membersArea]).toEqual({ 'shared-guid': true });
    expect(scopes['membersForum:nvo']).toEqual({ 'shared-guid': false });
  });

  it('writes a multi-scope markGuidsRead call in a single storage write', async () => {
    await markScopesSeen({
      'membersForum:nvo': ['g1'],
      'membersForum:tsla': ['g2'],
    });
    (storageSetObject as jest.Mock).mockClear();

    await markGuidsRead({
      'membersForum:nvo': ['g1'],
      'membersForum:tsla': ['g2'],
    });

    expect(storageSetObject).toHaveBeenCalledTimes(1);
    const scopes = await getAllScopes();
    expect(scopes['membersForum:nvo']).toEqual({ g1: true });
    expect(scopes['membersForum:tsla']).toEqual({ g2: true });
  });

  it('is a no-op when every update list is empty', async () => {
    await markScopesSeen({ 'membersForum:nvo': [] });
    expect(storageSetObject).not.toHaveBeenCalled();
  });
});

describe('hasUnread / isRead / markRead / markAllRead (single-scope wrappers)', () => {
  it('hasUnread is false for a scope that has never been seen', async () => {
    expect(await hasUnread('membersForum:nvo')).toBe(false);
  });

  it('hasUnread flips to false once every known guid is read', async () => {
    await markScopesSeen({ 'membersForum:nvo': ['g1', 'g2'] });
    expect(await hasUnread('membersForum:nvo')).toBe(true);

    await markAllRead('membersForum:nvo', ['g1', 'g2']);
    expect(await hasUnread('membersForum:nvo')).toBe(false);
  });

  it('isRead reflects a single guid without affecting others in the same scope', async () => {
    await markScopesSeen({ 'membersForum:nvo': ['g1', 'g2'] });
    await markRead('membersForum:nvo', 'g1');

    expect(await isRead('membersForum:nvo', 'g1')).toBe(true);
    expect(await isRead('membersForum:nvo', 'g2')).toBe(false);
  });
});

describe('markFlatFeedSeen', () => {
  it('records every item guid under the feedKey scope', async () => {
    await markFlatFeedSeen(FK.membersArea, [item('g1'), item('g2')]);
    const scopes = await getAllScopes();
    expect(scopes[FK.membersArea]).toEqual({ g1: false, g2: false });
  });
});

describe('topicUnreadForForum', () => {
  it('includes only topics whose id is prefixed with this forum key', () => {
    const scopes = {
      'membersForum:nvo': { g1: false },
      'stockInsights:tsla': { g2: false },
    };
    expect(topicUnreadForForum(FK.membersForum, scopes, {})).toEqual({
      'membersForum:nvo': true,
    });
  });

  it('excludes a silenced topic entirely, not just as false', () => {
    const scopes = { 'membersForum:nvo': { g1: false } };
    const subs = { 'membersForum:nvo': false };
    expect(topicUnreadForForum(FK.membersForum, scopes, subs)).toEqual({});
  });

  it('defaults an unlisted topic to subscribed (included), not silenced', () => {
    const scopes = { 'membersForum:nvo': { g1: false } };
    expect(topicUnreadForForum(FK.membersForum, scopes, {})).toEqual({
      'membersForum:nvo': true,
    });
  });

  it('reports false for a topic whose known guids are all read', () => {
    const scopes = { 'membersForum:nvo': { g1: true } };
    expect(topicUnreadForForum(FK.membersForum, scopes, {})).toEqual({
      'membersForum:nvo': false,
    });
  });

  it('returns an empty map for a forum with no scope entries at all', () => {
    expect(topicUnreadForForum(FK.membersForum, {}, {})).toEqual({});
  });
});

describe('detectForumUnread', () => {
  it('fast path: newest considered item already known — zero fetchTopicFeed calls, zero touched topics', async () => {
    await markScopesSeen({ 'membersForum:nvo': ['g1'] });

    const result = await detectForumUnread(FK.membersForum, [item('g1', 'nvo')]);

    expect(result).toEqual({});
    expect(mockFetchTopicFeed).not.toHaveBeenCalled();
    expect(mockGetTopicsForForum).not.toHaveBeenCalled();
  });

  it('complete window: a known item partway through the list bounds the new set — zero fetchTopicFeed calls', async () => {
    await markScopesSeen({ 'membersForum:nvo': ['g-old'] });

    // Newest-first: g-new-2, g-new-1, g-old (known) — g-old proves completeness.
    const items = [item('g-new-2', 'tsla'), item('g-new-1', 'nvo'), item('g-old', 'nvo')];
    const result = await detectForumUnread(FK.membersForum, items);

    expect(result).toEqual({ 'membersForum:tsla': true, 'membersForum:nvo': true });
    expect(mockFetchTopicFeed).not.toHaveBeenCalled();
    expect(mockGetTopicsForForum).not.toHaveBeenCalled();

    const scopes = await getAllScopes();
    expect(scopes['membersForum:nvo']).toEqual({ 'g-old': false, 'g-new-1': false });
    expect(scopes['membersForum:tsla']).toEqual({ 'g-new-2': false });
  });

  it('incomplete window: nothing known in the whole window — bounded fallback deep-dive, restricted to subscribed topics', async () => {
    mockGetTopicsForForum.mockResolvedValue([
      topic('nvo', 3),
      topic('tsla', 2),
      topic('silenced-topic', 1),
    ]);
    mockGetAllTopicSubscriptions.mockResolvedValue({ 'membersForum:silenced-topic': false });
    mockFetchTopicFeed.mockImplementation(async (url: string) =>
      url.includes('/nvo/') ? [item('deep-g1', 'nvo')] : [item('deep-g2', 'tsla')]
    );

    const items = [item('g-new', 'nvo')]; // never-before-seen, window exhausted with no boundary
    const result = await detectForumUnread(FK.membersForum, items);

    expect(mockFetchTopicFeed).toHaveBeenCalledTimes(2); // nvo + tsla, not the silenced topic
    expect(result['membersForum:nvo']).toBe(true);
    expect(result['membersForum:tsla']).toBe(true);
    expect(result['membersForum:silenced-topic']).toBeUndefined();
  });

  it('bounds the fallback deep-dive to at most 10 topics', async () => {
    mockGetTopicsForForum.mockResolvedValue(
      Array.from({ length: 15 }, (_, i) => topic(`topic-${i}`, 15 - i))
    );
    mockGetAllTopicSubscriptions.mockResolvedValue({});

    await detectForumUnread(FK.membersForum, [item('g-new', 'topic-0')]);

    expect(mockFetchTopicFeed).toHaveBeenCalledTimes(10);
  });

  it('reads the scope store a constant number of times, not once per item in the window', async () => {
    // One read for detectForumUnread's own snapshot, at most one more inside markScopesSeen's
    // own read-modify-write when there's anything to persist — never proportional to how many
    // items/topics were in the window (a 25-item, 25-topic window must not cause 25 reads).
    const items = Array.from({ length: 25 }, (_, i) => item(`g${i}`, `topic-${i}`));
    await detectForumUnread(FK.membersForum, items);

    const scopeReads = mockStorageGetObject.mock.calls.filter(([key]) => key === 'scope_guids');
    expect(scopeReads.length).toBeLessThanOrEqual(2);
    expect(mockGetAllTopicSubscriptions).toHaveBeenCalledTimes(1);
  });

  it('returns an empty result for an empty window', async () => {
    expect(await detectForumUnread(FK.membersForum, [])).toEqual({});
    expect(mockFetchTopicFeed).not.toHaveBeenCalled();
  });
});
