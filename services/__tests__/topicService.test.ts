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
  generateTopicFeedUrl,
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

  describe('generateTopicFeedUrl', () => {
    it('should generate feed URL from slug', () => {
      expect(generateTopicFeedUrl('nvo')).toBe(
        'https://logicalinvestor.net/forums/topic/nvo/feed/'
      );
    });

    it('should handle complex slugs', () => {
      expect(
        generateTopicFeedUrl('unsolicited-options-insights-testimonial')
      ).toBe(
        'https://logicalinvestor.net/forums/topic/unsolicited-options-insights-testimonial/feed/'
      );
    });

    it('should preserve slug as-is', () => {
      expect(generateTopicFeedUrl('my-topic-slug')).toBe(
        'https://logicalinvestor.net/forums/topic/my-topic-slug/feed/'
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

    it('should deduplicate topics by name', async () => {
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

    it('should generate unique topic IDs by forum and name', async () => {
      const items = [createFeedItem('NVO', 'nvo')];

      const discovered = await discoverTopicsFromFeedItems(items, FK.membersForum);

      expect(discovered[0].id).toBe('membersForum:NVO');
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
        },
      ];

      const discovered = await discoverTopicsFromFeedItems(items, FK.membersForum);

      expect(discovered).toHaveLength(1);
      expect(discovered[0].name).toBe('NVO');
    });
  });
});
