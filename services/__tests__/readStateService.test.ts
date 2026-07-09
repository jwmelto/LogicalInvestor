let readIds: string[] = [];

jest.mock('../storageService', () => ({
  storageGetObject: jest.fn((key: string) =>
    Promise.resolve(key === 'read_post_ids' ? readIds : null)
  ),
  storageSetObject: jest.fn().mockResolvedValue(undefined),
}));

import { computeFeedUnreadCounts } from '../readStateService';
import { RssItem, FeedResult } from '../feedService';

const item = (guid: string, feedKey: FeedResult['feedKey']): RssItem => ({
  guid, title: 'Post', author: 'Author', description: '', link: '', pubDate: '2024-01-01', feedKey,
});

describe('computeFeedUnreadCounts', () => {
  beforeEach(() => {
    readIds = [];
  });

  it('counts unread items per accessible feed, not clamped to a boolean', async () => {
    const results: FeedResult[] = [
      { feedKey: 'membersArea', accessible: true, items: [item('1', 'membersArea'), item('2', 'membersArea'), item('3', 'membersArea')] },
      { feedKey: 'membersForum', accessible: true, items: [item('4', 'membersForum')] },
    ];
    readIds = ['1'];

    expect(await computeFeedUnreadCounts(results)).toEqual({ membersArea: 2, membersForum: 1 });
  });

  it('skips inaccessible feeds', async () => {
    const results: FeedResult[] = [
      { feedKey: 'optionsInsights', accessible: false, items: [item('1', 'optionsInsights')] },
    ];

    expect(await computeFeedUnreadCounts(results)).toEqual({});
  });

  it('returns zero for a fully-read feed', async () => {
    const results: FeedResult[] = [
      { feedKey: 'membersArea', accessible: true, items: [item('1', 'membersArea')] },
    ];
    readIds = ['1'];

    expect(await computeFeedUnreadCounts(results)).toEqual({ membersArea: 0 });
  });
});
