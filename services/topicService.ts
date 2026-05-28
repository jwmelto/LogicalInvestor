import { FeedItem, FeedKey, FEEDS } from './feedService';
import { storageGetObject, storageSetObject } from './storageService';

/**
 * Parse RFC 2822 or ISO 8601 date string to timestamp.
 * Returns the timestamp, or 0 if parsing fails.
 */
function parsePublishDate(pubDateStr: string): number {
  if (!pubDateStr) return 0;
  try {
    const timestamp = new Date(pubDateStr).getTime();
    return isNaN(timestamp) ? 0 : timestamp;
  } catch {
    return 0;
  }
}

export interface Topic {
  id: string; // Unique identifier: "{forumKey}:{topicName}"
  name: string; // Display name (e.g., "NVO", "Tesla Options")
  slug: string; // URL slug extracted from post link (e.g., "unsolicited-options-insights-testimonial")
  forumKey: FeedKey; // Which forum this topic belongs to
  discoveredAt: number; // Timestamp when first discovered
  lastUpdatedAt: number; // Timestamp when topic was last seen with new activity
  itemCount: number; // Number of posts we know about in this topic
  latestAuthor?: string; // Author of the most recent post
  latestExcerpt?: string; // Excerpt from the most recent post (for preview)
  latestItemId?: string; // ID of the post providing the preview (to check read state)
  latestItemLink?: string; // Link to the most recent post (for navigation to preview)
  latestPubDate?: string; // Publication date of the most recent post (RFC 2822 or ISO 8601 format)
}

const TOPICS_STORAGE_KEY = 'discovered_topics';

/**
 * Extract topic name from a feed item title.
 *
 * Format:
 * - Topic post: "Lorem Ipsum" → topic is "Lorem Ipsum"
 * - Reply post: "Reply To: Lorem Ipsum" → topic is "Lorem Ipsum"
 */
export function extractTopicFromTitle(title: string): string {
  if (title.startsWith('Reply To: ')) {
    return title.slice(10).trim();
  }
  return title;
}

/**
 * Extract topic slug from a post link.
 *
 * Expected format: https://logicalinvestor.net/forums/topic/{slug}/ or similar
 * Returns the slug portion from the URL.
 */
export function extractTopicSlugFromLink(link: string): string | null {
  try {
    const url = new URL(link);
    const match = url.pathname.match(/\/forums\/topic\/([^\/]+)\/?/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

/**
 * Generate a unique topic ID from forum key and topic name.
 */
export function generateTopicId(forumKey: FeedKey, topicName: string): string {
  return `${forumKey}:${topicName}`;
}

/**
 * Discover topics from an array of feed items.
 *
 * Extracts topic names from item titles and slugs from item links,
 * deduplicates, and merges with any existing discovered topics.
 *
 * Returns only NEW topics; existing topics are updated separately.
 */
export async function discoverTopicsFromFeedItems(
  items: FeedItem[],
  forumKey: FeedKey
): Promise<Topic[]> {
  const now = Date.now();
  const newTopics: Map<string, Topic> = new Map();

  // Extract and deduplicate topics from items
  for (const item of items) {
    const topicName = extractTopicFromTitle(item.title);
    const topicSlug = extractTopicSlugFromLink(item.link);

    // Skip if we couldn't extract the slug
    if (!topicSlug) continue;

    const topicId = generateTopicId(forumKey, topicName);
    const pubTimestamp = parsePublishDate(item.pubDate);

    if (!newTopics.has(topicId)) {
      newTopics.set(topicId, {
        id: topicId,
        name: topicName,
        slug: topicSlug,
        forumKey,
        discoveredAt: now,
        lastUpdatedAt: pubTimestamp || now,
        itemCount: 0,
        latestAuthor: item.author,
        latestExcerpt: item.excerpt,
        latestItemId: item.id,
        latestItemLink: item.link,
        latestPubDate: item.pubDate,
      });
    } else {
      // Keep the latest (first in RSS order) item's preview
      const topic = newTopics.get(topicId)!;
      if (!topic.latestAuthor) {
        topic.latestAuthor = item.author;
      }
      if (!topic.latestExcerpt) {
        topic.latestExcerpt = item.excerpt;
      }
      if (!topic.latestItemId) {
        topic.latestItemId = item.id;
      }
      if (!topic.latestItemLink) {
        topic.latestItemLink = item.link;
      }
      if (!topic.latestPubDate) {
        topic.latestPubDate = item.pubDate;
      }
    }

    // Increment item count for this topic
    const topic = newTopics.get(topicId)!;
    topic.itemCount++;
  }

  return Array.from(newTopics.values());
}

/**
 * Merge newly discovered topics with existing topics.
 *
 * - Existing topics keep their discoveredAt timestamp
 * - lastUpdatedAt uses the actual pubDate of posts, not fetch time
 * - Item counts are cumulative
 */
async function mergeTopics(newTopics: Topic[]): Promise<Topic[]> {
  const existing = await getTopics();
  const existingMap = new Map(existing.map(t => [t.id, t]));

  for (const newTopic of newTopics) {
    const existingTopic = existingMap.get(newTopic.id);
    if (existingTopic) {
      // Keep old discovered time
      newTopic.discoveredAt = existingTopic.discoveredAt;

      // Keep the most recent lastUpdatedAt (prefer existing if it's newer, but newTopic's pubDate should be the actual post date)
      // Since newTopic.lastUpdatedAt is set to the pubDate of the discovered item, use it unless existing is newer
      if (existingTopic.lastUpdatedAt && existingTopic.lastUpdatedAt > newTopic.lastUpdatedAt) {
        newTopic.lastUpdatedAt = existingTopic.lastUpdatedAt;
      }

      newTopic.itemCount = Math.max(existingTopic.itemCount, newTopic.itemCount);

      // Preserve existing preview if new topic's preview is empty
      if (!newTopic.latestAuthor && existingTopic.latestAuthor) {
        newTopic.latestAuthor = existingTopic.latestAuthor;
      }
      if (!newTopic.latestExcerpt && existingTopic.latestExcerpt) {
        newTopic.latestExcerpt = existingTopic.latestExcerpt;
      }
      if (!newTopic.latestItemId && existingTopic.latestItemId) {
        newTopic.latestItemId = existingTopic.latestItemId;
      }
      if (!newTopic.latestItemLink && existingTopic.latestItemLink) {
        newTopic.latestItemLink = existingTopic.latestItemLink;
      }
      if (!newTopic.latestPubDate && existingTopic.latestPubDate) {
        newTopic.latestPubDate = existingTopic.latestPubDate;
      }
    }
    existingMap.set(newTopic.id, newTopic);
  }

  return Array.from(existingMap.values());
}

/**
 * Store discovered topics to storage.
 */
export async function storeTopics(topics: Topic[]): Promise<void> {
  await storageSetObject(TOPICS_STORAGE_KEY, topics);
}

/**
 * Retrieve all discovered topics from storage.
 */
export async function getTopics(): Promise<Topic[]> {
  const topics = await storageGetObject<Topic[]>(TOPICS_STORAGE_KEY);
  return topics ?? [];
}

/**
 * Get topics for a specific forum, sorted by most recently updated first.
 */
export async function getTopicsForForum(forumKey: FeedKey): Promise<Topic[]> {
  const all = await getTopics();
  return all
    .filter(t => t.forumKey === forumKey)
    .sort((a, b) => (b.lastUpdatedAt || 0) - (a.lastUpdatedAt || 0));
}

/**
 * Add new discovered topics and update storage in one step.
 *
 * This is the main entry point for topic discovery during feed fetches.
 */
export async function updateTopicsFromFeedItems(
  items: FeedItem[],
  forumKey: FeedKey
): Promise<Topic[]> {
  const newTopics = await discoverTopicsFromFeedItems(items, forumKey);
  const merged = await mergeTopics(newTopics);
  await storeTopics(merged);
  return merged;
}

/**
 * Get a single topic by ID.
 */
export async function getTopic(topicId: string): Promise<Topic | null> {
  const all = await getTopics();
  return all.find(t => t.id === topicId) ?? null;
}

/**
 * Clear all discovered topics (for testing/reset).
 */
export async function clearTopics(): Promise<void> {
  await storeTopics([]);
}

/**
 * Generate a topic feed URL from a topic slug.
 *
 * Pattern: https://logicalinvestor.net/forums/topic/{slug}/feed/
 */
export function generateTopicFeedUrl(slug: string): string {
  return `https://logicalinvestor.net/forums/topic/${slug}/feed/`;
}
