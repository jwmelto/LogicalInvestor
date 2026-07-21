// Mock React Native and storage modules before importing topicService
jest.mock('../storageService', () => ({
  storageGetObject: jest.fn().mockResolvedValue(null),
  storageSetObject: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('react-native', () => ({
  Platform: { OS: 'ios' },
}));

import {
  extractTopicSlugFromLink,
  generateTopicUrl,
  discoverTopicsFromFeedItems,
  generateTopicId,
} from '../topicService';
import { RssItem } from '../feedService';
import { FeedKeys } from '@li/core';

const FK = FeedKeys;

describe('topicService', () => {
  describe('extractTopicSlugFromLink', () => {
    it('should extract slug from standard topic link', () => {
      expect(
        extractTopicSlugFromLink('https://logicalinvestor.net/forums/topic/nvo/')
      ).toBe('nvo');
    });

    it('should extract slug from link with post anchor', () => {
      expect(
        extractTopicSlugFromLink(
          'https://logicalinvestor.net/forums/topic/unsolicited-options-insights-testimonial/#post-123456'
        )
      ).toBe('unsolicited-options-insights-testimonial');
    });

    it('should handle links with trailing slash', () => {
      expect(
        extractTopicSlugFromLink('https://logicalinvestor.net/forums/topic/tsla/')
      ).toBe('tsla');
    });

    it('should return null for invalid URLs', () => {
      expect(extractTopicSlugFromLink('not a url')).toBeNull();
    });

    it('should return null if topic path not found', () => {
      expect(
        extractTopicSlugFromLink('https://logicalinvestor.net/some/other/path/')
      ).toBeNull();
    });
  });

  describe('generateTopicId', () => {
    it('should build the id from forum key and slug, not title', () => {
      expect(generateTopicId(FK.membersForum, 'nvo')).toBe('membersForum:nvo');
    });

    it('should produce different ids for different forums with the same slug', () => {
      expect(generateTopicId(FK.membersForum, 'nvo')).not.toBe(
        generateTopicId(FK.stockInsights, 'nvo')
      );
    });
  });

  describe('generateTopicUrl', () => {
    it('should generate the bare topic URL from slug', () => {
      expect(generateTopicUrl('nvo')).toBe(
        'https://logicalinvestor.net/forums/topic/nvo/'
      );
    });

    it('should handle complex slugs', () => {
      expect(
        generateTopicUrl('unsolicited-options-insights-testimonial')
      ).toBe(
        'https://logicalinvestor.net/forums/topic/unsolicited-options-insights-testimonial/'
      );
    });

    it('should preserve slug as-is', () => {
      expect(generateTopicUrl('my-topic-slug')).toBe(
        'https://logicalinvestor.net/forums/topic/my-topic-slug/'
      );
    });
  });

  describe('discoverTopicsFromFeedItems', () => {
    const createFeedItem = (
      title: string,
      slug = 'test-topic',
      feedKey = FK.membersForum
    ): RssItem => ({
      guid: `item-${title}`,
      title,
      link: `https://logicalinvestor.net/forums/topic/${slug}/#post-123`,
      pubDate: new Date('2024-01-01'),
      author: 'Test Author',
      description: 'Test excerpt',
      feedKey: feedKey as any,
      isFirstPost: true,
    });

    // item.title is passed in already normalized here (extractRssItems strips "Reply To: "
    // before discoverTopicsFromFeedItems ever sees a title — see packages/core/src/index.ts and
    // its own stripReplyPrefix coverage), so fixtures below use plain topic names throughout.

    it('should discover topics from feed items', async () => {
      const items = [
        createFeedItem('NVO', 'nvo'),
        createFeedItem('TSLA', 'tsla'),
        createFeedItem('NVO', 'nvo'), // Duplicate
      ];

      const discovered = await discoverTopicsFromFeedItems(items, FK.membersForum);

      expect(discovered).toHaveLength(2);
      expect(discovered.map(t => t.name)).toContain('NVO');
      expect(discovered.map(t => t.name)).toContain('TSLA');
      expect(discovered.map(t => t.slug)).toContain('nvo');
      expect(discovered.map(t => t.slug)).toContain('tsla');
    });

    it('should deduplicate topics by slug', async () => {
      const items = [
        createFeedItem('NVO', 'nvo'),
        createFeedItem('NVO', 'nvo'),
        createFeedItem('NVO', 'nvo'),
      ];

      const discovered = await discoverTopicsFromFeedItems(items, FK.membersForum);

      expect(discovered).toHaveLength(1);
      expect(discovered[0].name).toBe('NVO');
      expect(discovered[0].slug).toBe('nvo');
    });

    it('should treat the same title with two different slugs as two distinct topics', async () => {
      // Title alone is not a stable identity — a moderator edit or an unrelated topic reusing a
      // title must not collide. Slug (from the URL) is what actually distinguishes them.
      const items = [
        createFeedItem('NVO', 'nvo-original'),
        createFeedItem('NVO', 'nvo-relaunch'),
      ];

      const discovered = await discoverTopicsFromFeedItems(items, FK.membersForum);

      expect(discovered).toHaveLength(2);
      expect(discovered.map(t => t.id).sort()).toEqual([
        'membersForum:nvo-original',
        'membersForum:nvo-relaunch',
      ]);
    });

    it('should not fork into a second topic when the same slug appears under a changed title', async () => {
      // The first item encountered for a topicId sets the record (RSS lists items newest-first);
      // a later item with the same slug but a different title doesn't create a second record.
      const items = [
        createFeedItem('NVO', 'nvo'),
        createFeedItem('NVO (renamed)', 'nvo'),
      ];

      const discovered = await discoverTopicsFromFeedItems(items, FK.membersForum);

      expect(discovered).toHaveLength(1);
      expect(discovered[0].id).toBe('membersForum:nvo');
      expect(discovered[0].name).toBe('NVO');
      expect(discovered[0].itemCount).toBe(2);
    });

    it('should count items per topic', async () => {
      const items = [
        createFeedItem('NVO', 'nvo'),
        createFeedItem('NVO', 'nvo'),
        createFeedItem('TSLA', 'tsla'),
      ];

      const discovered = await discoverTopicsFromFeedItems(items, FK.membersForum);

      const nvoTopic = discovered.find(t => t.name === 'NVO');
      const tslaTopic = discovered.find(t => t.name === 'TSLA');

      expect(nvoTopic?.itemCount).toBe(2);
      expect(tslaTopic?.itemCount).toBe(1);
    });

    it('should generate unique topic IDs by forum and slug', async () => {
      const items = [createFeedItem('NVO', 'nvo')];

      const discovered = await discoverTopicsFromFeedItems(items, FK.membersForum);

      expect(discovered[0].id).toBe('membersForum:nvo');
    });

    it('should set discoveredAt to current time', async () => {
      const items = [createFeedItem('NVO')];
      const beforeTime = Date.now();

      const discovered = await discoverTopicsFromFeedItems(items, FK.membersForum);

      const afterTime = Date.now();
      expect(discovered[0].discoveredAt).toBeGreaterThanOrEqual(beforeTime);
      expect(discovered[0].discoveredAt).toBeLessThanOrEqual(afterTime);
    });

    it('should assign forumKey to each topic', async () => {
      const items = [createFeedItem('NVO')];

      const discovered = await discoverTopicsFromFeedItems(items, FK.stockInsights);

      expect(discovered[0].forumKey).toBe(FK.stockInsights);
    });

    it('should handle empty feed items array', async () => {
      const discovered = await discoverTopicsFromFeedItems([], FK.membersForum);

      expect(discovered).toHaveLength(0);
    });

    it('should skip items with invalid links', async () => {
      const items = [
        createFeedItem('NVO', 'nvo'),
        {
          guid: 'invalid-item',
          title: 'Invalid Post',
          link: 'not-a-valid-url',
          pubDate: new Date('2024-01-01'),
          author: 'Test Author',
          description: 'Test excerpt',
          feedKey: FK.membersForum as any,
          isFirstPost: true,
        },
      ];

      const discovered = await discoverTopicsFromFeedItems(items, FK.membersForum);

      expect(discovered).toHaveLength(1);
      expect(discovered[0].name).toBe('NVO');
    });
  });
});
