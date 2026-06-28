// Mock React Native and storage modules before importing topicService
jest.mock('../storageService', () => ({
  storageGetObject: jest.fn().mockResolvedValue(null),
  storageSetObject: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('react-native', () => ({
  Platform: { OS: 'ios' },
}));

import {
  extractTopicFromTitle,
  extractTopicSlugFromLink,
  generateTopicFeedUrl,
  discoverTopicsFromFeedItems,
  generateTopicId,
} from '../topicService';
import { FeedItem } from '../feedService';
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

  describe('extractTopicFromTitle', () => {
    it('should strip "Reply To: " prefix', () => {
      expect(extractTopicFromTitle('Reply To: NVO')).toBe('NVO');
    });

    it('should handle "Reply To: " with multiple words', () => {
      expect(extractTopicFromTitle('Reply To: Tesla Options Strategy')).toBe(
        'Tesla Options Strategy'
      );
    });

    it('should trim whitespace after stripping prefix', () => {
      expect(extractTopicFromTitle('Reply To:   NVO  ')).toBe('NVO');
    });

    it('should return title as-is if no "Reply To: " prefix', () => {
      expect(extractTopicFromTitle('NVO')).toBe('NVO');
    });

    it('should handle titles with "Reply To:" in the middle', () => {
      expect(extractTopicFromTitle('NVO Reply To: Someone')).toBe(
        'NVO Reply To: Someone'
      );
    });

    it('should preserve case in topic names', () => {
      expect(extractTopicFromTitle('Reply To: TeSLa')).toBe('TeSLa');
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
    ): FeedItem => ({
      id: `item-${title}`,
      title,
      link: `https://logicalinvestor.net/forums/topic/${slug}/#post-123`,
      pubDate: '2024-01-01',
      author: 'Test Author',
      excerpt: 'Test excerpt',
      feedName: 'Test Feed',
      feedKey: feedKey as any,
    });

    it('should discover topics from feed items', async () => {
      const items = [
        createFeedItem('Reply To: NVO', 'nvo'),
        createFeedItem('Reply To: TSLA', 'tsla'),
        createFeedItem('Reply To: NVO', 'nvo'), // Duplicate
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
        createFeedItem('Reply To: NVO', 'nvo'),
        createFeedItem('Reply To: NVO', 'nvo'),
        createFeedItem('Reply To: NVO', 'nvo'),
      ];

      const discovered = await discoverTopicsFromFeedItems(items, FK.membersForum);

      expect(discovered).toHaveLength(1);
      expect(discovered[0].name).toBe('NVO');
      expect(discovered[0].slug).toBe('nvo');
    });

    it('should count items per topic', async () => {
      const items = [
        createFeedItem('Reply To: NVO', 'nvo'),
        createFeedItem('Reply To: NVO', 'nvo'),
        createFeedItem('Reply To: TSLA', 'tsla'),
      ];

      const discovered = await discoverTopicsFromFeedItems(items, FK.membersForum);

      const nvoTopic = discovered.find(t => t.name === 'NVO');
      const tslaTopic = discovered.find(t => t.name === 'TSLA');

      expect(nvoTopic?.itemCount).toBe(2);
      expect(tslaTopic?.itemCount).toBe(1);
    });

    it('should generate unique topic IDs by forum and name', async () => {
      const items = [createFeedItem('Reply To: NVO', 'nvo')];

      const discovered = await discoverTopicsFromFeedItems(items, FK.membersForum);

      expect(discovered[0].id).toBe('membersForum:NVO');
    });

    it('should set discoveredAt to current time', async () => {
      const items = [createFeedItem('Reply To: NVO')];
      const beforeTime = Date.now();

      const discovered = await discoverTopicsFromFeedItems(items, FK.membersForum);

      const afterTime = Date.now();
      expect(discovered[0].discoveredAt).toBeGreaterThanOrEqual(beforeTime);
      expect(discovered[0].discoveredAt).toBeLessThanOrEqual(afterTime);
    });

    it('should assign forumKey to each topic', async () => {
      const items = [createFeedItem('Reply To: NVO')];

      const discovered = await discoverTopicsFromFeedItems(items, FK.stockInsights);

      expect(discovered[0].forumKey).toBe(FK.stockInsights);
    });

    it('should handle mixed "Reply To:" and standalone titles', async () => {
      const items = [
        createFeedItem('Reply To: NVO', 'nvo'),
        createFeedItem('AAPL', 'aapl'), // Standalone topic
        createFeedItem('Reply To: AAPL', 'aapl'),
      ];

      const discovered = await discoverTopicsFromFeedItems(items, FK.membersForum);

      expect(discovered).toHaveLength(2);
      const applTopics = discovered.filter(t => t.name === 'AAPL');
      expect(applTopics).toHaveLength(1);
      expect(applTopics[0].itemCount).toBe(2); // Deduplicated
    });

    it('should handle empty feed items array', async () => {
      const discovered = await discoverTopicsFromFeedItems([], FK.membersForum);

      expect(discovered).toHaveLength(0);
    });

    it('should skip items with invalid links', async () => {
      const items = [
        createFeedItem('Reply To: NVO', 'nvo'),
        {
          id: 'invalid-item',
          title: 'Invalid Post',
          link: 'not-a-valid-url',
          pubDate: '2024-01-01',
          feedName: 'Test Feed',
          feedKey: FK.membersForum as any,
        },
      ];

      const discovered = await discoverTopicsFromFeedItems(items, FK.membersForum);

      expect(discovered).toHaveLength(1);
      expect(discovered[0].name).toBe('NVO');
    });
  });
});
