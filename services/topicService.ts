import { FeedItem, FeedKey, FEEDS } from './feedService';
import { storageGetObject, storageSetObject } from './storageService';

export interface Topic {
  id: string; // Unique identifier: "{forumKey}:{topicName}"
  name: string; // Display name (e.g., "NVO", "Tesla Options")
  slug: string; // URL slug extracted from post link (e.g., "unsolicited-options-insights-testimonial")
  forumKey: FeedKey; // Which forum this topic belongs to
  discoveredAt: number; // Timestamp when first discovered
  itemCount: number; // Number of posts we know about in this topic
  latestAuthor?: string; // Author of the most recent post
  latestExcerpt?: string; // Excerpt from the most recent post (for preview)
  latestItemId?: string; // ID of the post providing the preview (to check read state)
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

    if (!newTopics.has(topicId)) {
      newTopics.set(topicId, {
        id: topicId,
        name: topicName,
        slug: topicSlug,
        forumKey,
        discoveredAt: now,
        itemCount: 0,
        latestAuthor: item.author,
        latestExcerpt: item.excerpt,
        latestItemId: item.id,
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
 * - New topics get current timestamp
 * - Item counts are cumulative
 */
async function mergeTopics(newTopics: Topic[]): Promise<Topic[]> {
  const existing = await getTopics();
  const existingMap = new Map(existing.map(t => [t.id, t]));

  for (const newTopic of newTopics) {
    const existing = existingMap.get(newTopic.id);
    if (existing) {
      // Keep old discovered time, update item count
      newTopic.discoveredAt = existing.discoveredAt;
      newTopic.itemCount = Math.max(existing.itemCount, newTopic.itemCount);
      // Preserve existing preview if new topic's preview is empty
      if (!newTopic.latestAuthor && existing.latestAuthor) {
        newTopic.latestAuthor = existing.latestAuthor;
      }
      if (!newTopic.latestExcerpt && existing.latestExcerpt) {
        newTopic.latestExcerpt = existing.latestExcerpt;
      }
      if (!newTopic.latestItemId && existing.latestItemId) {
        newTopic.latestItemId = existing.latestItemId;
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
 * Get topics for a specific forum.
 */
export async function getTopicsForForum(forumKey: FeedKey): Promise<Topic[]> {
  const all = await getTopics();
  return all.filter(t => t.forumKey === forumKey);
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
