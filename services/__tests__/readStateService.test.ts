import {
  markScopesSeen,
  markGuidsRead,
  markScopesRead,
  viewScope,
  hasUnread,
  isRead,
  markRead,
  markAllRead,
  markFlatFeedSeen,
  detectForumUnread,
  getAllScopes,
  topicUnreadForForum,
  feedHasUnread,
  clearScope,
  pruneOrphanedScopes,
  pruneOrphanedScopesForAllFeeds,
  updateTopic,
} from '../readStateService';
import { FeedKeys } from '@li/core';
import { fetchTopicFeed, RssItem } from '../feedService';
import { getTopicsForForum, Topic } from '../topicService';
import { getAllTopicSubscriptions } from '../subscriptionService';
import { storageGetObject, storageSetObject } from '../storageService';

let store: Record<string, unknown> = {};

// jest.mock calls are hoisted above every import above at compile time regardless of where
// they're written in source — this position (after the imports) is what satisfies both that
// hoisting and eslint's import/first rule at once.
jest.mock('../storageService', () => ({
  storageGetObject: jest.fn((key: string) => Promise.resolve((store as any)[key] ?? null)),
  storageSetObject: jest.fn((key: string, value: unknown) => {
    (store as any)[key] = value;
    return Promise.resolve();
  }),
}));

// FEEDS is pure static config, safe to pull in via requireActual — but feedService.ts also
// imports authService (expo-secure-store), which doesn't resolve under Jest without a
// native-module bridge, so that needs stubbing out too even though nothing here calls it.
jest.mock('../authService', () => ({ getToken: jest.fn() }));
jest.mock('../feedService', () => ({
  ...jest.requireActual('../feedService'),
  fetchTopicFeed: jest.fn(),
}));

jest.mock('../topicService', () => ({
  ...jest.requireActual('../topicService'),
  getTopicsForForum: jest.fn(),
}));

jest.mock('../subscriptionService', () => ({
  getAllTopicSubscriptions: jest.fn(),
}));

const FK = FeedKeys;

const mockFetchTopicFeed = fetchTopicFeed as jest.Mock;
const mockGetTopicsForForum = getTopicsForForum as jest.Mock;
const mockGetAllTopicSubscriptions = getAllTopicSubscriptions as jest.Mock;
const mockStorageGetObject = storageGetObject as jest.Mock;

const item = (guid: string, slug = 'zqr'): RssItem => ({
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
  mockFetchTopicFeed.mockReset().mockResolvedValue({ items: [], deleted: false });
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
    await markGuidsRead({ 'membersForum:zqr': ['guid-1'] }); // guid-1 starts out read
    await markScopesSeen({ 'membersForum:zqr': ['guid-1', 'guid-2'] }); // resurfaces + one new

    const scopes = await getAllScopes();
    expect(scopes['membersForum:zqr']).toEqual({ 'guid-1': true, 'guid-2': false });
  });

  it('keeps two scopes independent even when guids are identical strings', async () => {
    await markScopesSeen({
      [FK.membersArea]: ['shared-guid'],
      'membersForum:zqr': ['shared-guid'],
    });
    await markGuidsRead({ [FK.membersArea]: ['shared-guid'] });

    const scopes = await getAllScopes();
    expect(scopes[FK.membersArea]).toEqual({ 'shared-guid': true });
    expect(scopes['membersForum:zqr']).toEqual({ 'shared-guid': false });
  });

  it('writes a multi-scope markGuidsRead call in a single storage write', async () => {
    await markScopesSeen({
      'membersForum:zqr': ['g1'],
      'membersForum:plmk': ['g2'],
    });
    (storageSetObject as jest.Mock).mockClear();

    await markGuidsRead({
      'membersForum:zqr': ['g1'],
      'membersForum:plmk': ['g2'],
    });

    expect(storageSetObject).toHaveBeenCalledTimes(1);
    const scopes = await getAllScopes();
    expect(scopes['membersForum:zqr']).toEqual({ g1: true });
    expect(scopes['membersForum:plmk']).toEqual({ g2: true });
  });

  it('is a no-op when every update list is empty', async () => {
    await markScopesSeen({ 'membersForum:zqr': [] });
    expect(storageSetObject).not.toHaveBeenCalled();
  });
});

describe('markScopesRead', () => {
  it('marks every known guid in each given scope read, regardless of read state, and returns what it marked', async () => {
    await markScopesSeen({ 'membersForum:zqr': ['g1', 'g2'] });
    await markGuidsRead({ 'membersForum:zqr': ['g1'] }); // g1 already read, g2 still unread

    const updates = await markScopesRead(['membersForum:zqr']);

    expect(updates).toEqual({ 'membersForum:zqr': ['g1', 'g2'] });
    const scopes = await getAllScopes();
    expect(scopes['membersForum:zqr']).toEqual({ g1: true, g2: true });
  });

  it('treats a flat feed key exactly like a topic id — same operation, no special case', async () => {
    await markScopesSeen({ [FK.membersArea]: ['g1'] });

    const updates = await markScopesRead([FK.membersArea]);

    expect(updates).toEqual({ [FK.membersArea]: ['g1'] });
  });

  it('marks multiple scopes in one call, independently', async () => {
    await markScopesSeen({
      'membersForum:zqr': ['g1'],
      'membersForum:plmk': ['g2'],
    });

    const updates = await markScopesRead(['membersForum:zqr', 'membersForum:plmk']);

    expect(updates).toEqual({
      'membersForum:zqr': ['g1'],
      'membersForum:plmk': ['g2'],
    });
  });

  it('returns an empty guid list for a scope that has never been seen, without erroring', async () => {
    const updates = await markScopesRead(['membersForum:never-seen']);

    expect(updates).toEqual({ 'membersForum:never-seen': [] });
  });
});

describe('clearScope', () => {
  it('removes the scope entirely, leaving other scopes untouched', async () => {
    await markScopesSeen({
      'membersForum:zqr': ['g1', 'g2'],
      'membersForum:plmk': ['g3'],
    });

    await clearScope('membersForum:zqr');

    const scopes = await getAllScopes();
    expect(scopes['membersForum:zqr']).toBeUndefined();
    expect(scopes['membersForum:plmk']).toEqual({ g3: false });
  });

  it('is a no-op when the scope does not exist', async () => {
    await markScopesSeen({ 'membersForum:plmk': ['g1'] });
    (storageSetObject as jest.Mock).mockClear();

    await clearScope('membersForum:does-not-exist');

    expect(storageSetObject).not.toHaveBeenCalled();
  });
});

describe('pruneOrphanedScopes', () => {
  it('removes any scope not in the valid set, leaving valid ones untouched', async () => {
    await markScopesSeen({
      'membersForum:zqr': ['g1'],
      'membersForum:gone': ['g2'],
      [FK.membersArea]: ['g3'],
    });

    await pruneOrphanedScopes(new Set(['membersForum:zqr', FK.membersArea]));

    const scopes = await getAllScopes();
    expect(Object.keys(scopes).sort()).toEqual([FK.membersArea, 'membersForum:zqr'].sort());
    expect(scopes['membersForum:zqr']).toEqual({ g1: false });
  });

  it('is a no-op (no write) when nothing is orphaned', async () => {
    await markScopesSeen({ 'membersForum:zqr': ['g1'] });
    (storageSetObject as jest.Mock).mockClear();

    await pruneOrphanedScopes(new Set(['membersForum:zqr']));

    expect(storageSetObject).not.toHaveBeenCalled();
  });
});

describe('pruneOrphanedScopesForAllFeeds', () => {
  it('removes a topic scope whose topic no longer exists in any forum, keeping real ones', async () => {
    await markScopesSeen({
      'membersForum:zqr': ['g1'],
      'membersForum:gone': ['g2'], // orphan: no longer returned by getTopicsForForum
      [FK.membersArea]: ['g3'],
    });
    mockGetTopicsForForum.mockImplementation(async (forumKey: string) =>
      forumKey === FK.membersForum ? [topic('zqr')] : []
    );

    await pruneOrphanedScopesForAllFeeds();

    const scopes = await getAllScopes();
    expect(scopes['membersForum:gone']).toBeUndefined();
    expect(scopes['membersForum:zqr']).toEqual({ g1: false });
    expect(scopes[FK.membersArea]).toEqual({ g3: false });
  });
});

describe('updateTopic', () => {
  beforeEach(() => {
    mockFetchTopicFeed.mockReset();
  });

  it('marks the fetched items seen when the topic is still alive', async () => {
    mockFetchTopicFeed.mockResolvedValue({ items: [item('g1', 'zqr'), item('g2', 'zqr')], deleted: false });

    const result = await updateTopic(topic('zqr'), FK.membersForum);

    expect(result.deleted).toBe(false);
    const scopes = await getAllScopes();
    expect(scopes['membersForum:zqr']).toEqual({ g1: false, g2: false });
  });

  it('clears the scope instead of marking anything seen when the topic is confirmed deleted', async () => {
    await markScopesSeen({ 'membersForum:zqr': ['stale-guid'] });
    mockFetchTopicFeed.mockResolvedValue({ items: [], deleted: true });

    const result = await updateTopic(topic('zqr'), FK.membersForum);

    expect(result.deleted).toBe(true);
    const scopes = await getAllScopes();
    expect(scopes['membersForum:zqr']).toBeUndefined();
  });
});

describe('hasUnread / isRead / markRead / markAllRead (single-scope wrappers)', () => {
  it('hasUnread is false for a scope that has never been seen', async () => {
    expect(await hasUnread('membersForum:zqr')).toBe(false);
  });

  it('hasUnread flips to false once every known guid is read', async () => {
    await markScopesSeen({ 'membersForum:zqr': ['g1', 'g2'] });
    expect(await hasUnread('membersForum:zqr')).toBe(true);

    await markAllRead('membersForum:zqr', ['g1', 'g2']);
    expect(await hasUnread('membersForum:zqr')).toBe(false);
  });

  it('isRead reflects a single guid without affecting others in the same scope', async () => {
    await markScopesSeen({ 'membersForum:zqr': ['g1', 'g2'] });
    await markRead('membersForum:zqr', 'g1');

    expect(await isRead('membersForum:zqr', 'g1')).toBe(true);
    expect(await isRead('membersForum:zqr', 'g2')).toBe(false);
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
      'membersForum:zqr': { g1: false },
      'stockInsights:plmk': { g2: false },
    };
    expect(topicUnreadForForum(FK.membersForum, scopes, {})).toEqual({
      'membersForum:zqr': true,
    });
  });

  it('excludes a silenced topic entirely, not just as false', () => {
    const scopes = { 'membersForum:zqr': { g1: false } };
    const subs = { 'membersForum:zqr': false };
    expect(topicUnreadForForum(FK.membersForum, scopes, subs)).toEqual({});
  });

  it('defaults an unlisted topic to subscribed (included), not silenced', () => {
    const scopes = { 'membersForum:zqr': { g1: false } };
    expect(topicUnreadForForum(FK.membersForum, scopes, {})).toEqual({
      'membersForum:zqr': true,
    });
  });

  it('reports false for a topic whose known guids are all read', () => {
    const scopes = { 'membersForum:zqr': { g1: true } };
    expect(topicUnreadForForum(FK.membersForum, scopes, {})).toEqual({
      'membersForum:zqr': false,
    });
  });

  it('returns an empty map for a forum with no scope entries at all', () => {
    expect(topicUnreadForForum(FK.membersForum, {}, {})).toEqual({});
  });
});

describe('feedHasUnread', () => {
  it('for a flat feed, reads its own single scope directly', () => {
    const scopes = { [FK.membersArea]: { g1: false } };
    expect(feedHasUnread(FK.membersArea, false, scopes, {})).toBe(true);
  });

  it('for a flat feed with everything read, is false', () => {
    const scopes = { [FK.membersArea]: { g1: true } };
    expect(feedHasUnread(FK.membersArea, false, scopes, {})).toBe(false);
  });

  it('for a topic-based forum, is true if any non-silenced topic has unread', () => {
    const scopes = {
      'membersForum:zqr': { g1: true },
      'membersForum:plmk': { g2: false },
    };
    expect(feedHasUnread(FK.membersForum, true, scopes, {})).toBe(true);
  });

  it('for a topic-based forum, is false when every topic is read', () => {
    const scopes = { 'membersForum:zqr': { g1: true } };
    expect(feedHasUnread(FK.membersForum, true, scopes, {})).toBe(false);
  });

  it('for a topic-based forum, ignores a silenced topic even if it has unread guids', () => {
    const scopes = { 'membersForum:zqr': { g1: false } };
    const subs = { 'membersForum:zqr': false };
    expect(feedHasUnread(FK.membersForum, true, scopes, subs)).toBe(false);
  });

  it('for a feed with no scope entries at all, is false either way', () => {
    expect(feedHasUnread(FK.membersArea, false, {}, {})).toBe(false);
    expect(feedHasUnread(FK.membersForum, true, {}, {})).toBe(false);
  });
});

describe('detectForumUnread', () => {
  it('fast path: newest considered item already known — zero fetchTopicFeed calls, zero touched topics', async () => {
    await markScopesSeen({ 'membersForum:zqr': ['g1'] });

    const result = await detectForumUnread(FK.membersForum, [item('g1', 'zqr')]);

    expect(result).toEqual({});
    expect(mockFetchTopicFeed).not.toHaveBeenCalled();
    expect(mockGetTopicsForForum).not.toHaveBeenCalled();
  });

  it('complete window: a known item partway through the list bounds the new set — zero fetchTopicFeed calls', async () => {
    await markScopesSeen({ 'membersForum:zqr': ['g-old'] });

    // Newest-first: g-new-2, g-new-1, g-old (known) — g-old proves completeness.
    const items = [item('g-new-2', 'plmk'), item('g-new-1', 'zqr'), item('g-old', 'zqr')];
    const result = await detectForumUnread(FK.membersForum, items);

    expect(result).toEqual({ 'membersForum:plmk': true, 'membersForum:zqr': true });
    expect(mockFetchTopicFeed).not.toHaveBeenCalled();
    expect(mockGetTopicsForForum).not.toHaveBeenCalled();

    const scopes = await getAllScopes();
    expect(scopes['membersForum:zqr']).toEqual({ 'g-old': false, 'g-new-1': false });
    expect(scopes['membersForum:plmk']).toEqual({ 'g-new-2': false });
  });

  it('incomplete window: nothing known in the whole window — deep-dive restricted to subscribed topics', async () => {
    mockGetTopicsForForum.mockResolvedValue([
      topic('zqr', 3),
      topic('plmk', 2),
      topic('silenced-topic', 1),
    ]);
    mockGetAllTopicSubscriptions.mockResolvedValue({ 'membersForum:silenced-topic': false });
    mockFetchTopicFeed.mockImplementation(async (t: Topic) => ({
      items: t.slug === 'zqr' ? [item('deep-g1', 'zqr')] : [item('deep-g2', 'plmk')],
      deleted: false,
    }));

    const items = [item('g-new', 'zqr')]; // never-before-seen, window exhausted with no boundary
    const result = await detectForumUnread(FK.membersForum, items);

    expect(mockFetchTopicFeed).toHaveBeenCalledTimes(2); // zqr + plmk, not the silenced topic
    expect(result['membersForum:zqr']).toBe(true);
    expect(result['membersForum:plmk']).toBe(true);
    expect(result['membersForum:silenced-topic']).toBeUndefined();
  });

  // A topic whose item is in the top-level window is demonstrably alive at fetch time, so this
  // combination (staged by the main walk, then found deleted by the dive) only happens if the
  // topic was deleted in the narrow gap between the two fetches — not worth preventing, but
  // recovery from it must still be clean, not leave a resurrected guid behind.
  it('gracefully recovers when a topic is deleted between the top-level fetch and its own deep-dive', async () => {
    await markScopesSeen({ 'membersForum:gone': ['stale-guid'] }); // leftover from before it was deleted
    mockGetTopicsForForum.mockResolvedValue([topic('gone', 5)]);
    mockGetAllTopicSubscriptions.mockResolvedValue({});
    mockFetchTopicFeed.mockResolvedValue({ items: [], deleted: true });

    const result = await detectForumUnread(FK.membersForum, [item('g-new', 'gone')]);

    expect(result['membersForum:gone']).toBeUndefined();
    const scopes = await getAllScopes();
    expect(scopes['membersForum:gone']).toBeUndefined();
  });

  it('dives every subscribed topic when the window is incomplete — no arbitrary cap', async () => {
    // A cap here previously meant a cold/inactive topic ranked below the cutoff could never be
    // checked. Concurrent (Promise.all) dives cost latency once, not per topic, so there's no
    // reason to bound the count.
    mockGetTopicsForForum.mockResolvedValue(
      Array.from({ length: 15 }, (_, i) => topic(`topic-${i}`, 15 - i))
    );
    mockGetAllTopicSubscriptions.mockResolvedValue({});

    await detectForumUnread(FK.membersForum, [item('g-new', 'topic-0')]);

    expect(mockFetchTopicFeed).toHaveBeenCalledTimes(15);
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
