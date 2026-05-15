import { useEffect, useState, useCallback } from 'react';
import {
  View,
  Text,
  FlatList,
  TouchableOpacity,
  ActivityIndicator,
  StyleSheet,
  RefreshControl,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect } from '@react-navigation/native';
import { router } from 'expo-router';
import { fetchAllFeeds, fetchSingleFeed, fetchTopicFeed, FeedItem, FeedResult, FEEDS, FeedKey } from '../../services/feedService';
import { getUnreadCount, markRead, isRead } from '../../services/readStateService';
import { getHideSnippetOnRead, storageGetObject, storageSetObject } from '../../services/storageService';
import { getTopicsForForum, generateTopicFeedUrl, extractTopicFromTitle, Topic } from '../../services/topicService';
import { isTopicSubscribed } from '../../services/subscriptionService';

interface ItemReadState {
  [itemId: string]: boolean;
}

interface TopicSection {
  topic: Topic;
  items: FeedItem[];
  unreadCount: number;
  expanded: boolean;
  loading: boolean;
}

interface SectionState {
  feedKey: FeedKey;
  items: FeedItem[];
  topics: TopicSection[];
  unreadCount: number;
  expanded: boolean;
  accessible: boolean;
  loading: boolean;
  error?: string;
}

function decodeHtmlEntities(html: string): string {
  const entities: Record<string, string> = {
    '&amp;': '&',
    '&lt;': '<',
    '&gt;': '>',
    '&quot;': '"',
    '&#039;': "'",
    '&#038;': '&',
    '&apos;': "'",
  };

  let decoded = html;
  Object.entries(entities).forEach(([entity, char]) => {
    decoded = decoded.replace(new RegExp(entity, 'g'), char);
  });

  // Decode numeric entities (&#123; or &#x1F;)
  decoded = decoded.replace(/&#(\d+);/g, (match, dec) => String.fromCharCode(parseInt(dec, 10)));
  decoded = decoded.replace(/&#x([0-9a-f]+);/gi, (match, hex) => String.fromCharCode(parseInt(hex, 16)));

  return decoded;
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]*>/g, '').replace(/&[^;]+;/g, ' ').trim();
}

interface ExpandedState {
  sections: Record<FeedKey, boolean>;
  topics: Record<string, boolean>;
}

async function getExpandedState(): Promise<ExpandedState | null> {
  return storageGetObject<ExpandedState>('expanded_state');
}

async function saveExpandedState(state: ExpandedState): Promise<void> {
  await storageSetObject('expanded_state', state);
}

export default function FeedScreen() {
  const [sections, setSections] = useState<SectionState[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [hideSnippetOnRead, setHideSnippetOnRead] = useState(false);
  const [itemReadStates, setItemReadStates] = useState<ItemReadState>({});

  async function buildSections(results: FeedResult[]): Promise<SectionState[]> {
    const savedState = await getExpandedState();

    return Promise.all(
      results.map(async (result, index) => {
        const unreadCount = await getUnreadCount(result.items.map((i) => i.id));

        // For forums with topics, build topic sections
        const feed = FEEDS[result.feedKey];
        let topicSections: TopicSection[] = [];

        if (feed.hasSubFeeds && result.accessible) {
          const allTopics = await getTopicsForForum(result.feedKey);

          // Filter to only subscribed topics
          const subscribedTopics = await Promise.all(
            allTopics.map(async (topic) => ({
              topic,
              subscribed: await isTopicSubscribed(topic.id, result.feedKey),
            }))
          );

          // Calculate initial unread counts from main feed items
          topicSections = await Promise.all(
            subscribedTopics
              .filter(({ subscribed }) => subscribed)
              .map(async ({ topic }) => {
                // Find posts in main feed that belong to this topic
                const topicPosts = result.items.filter(
                  item => extractTopicFromTitle(item.title) === topic.name
                );
                // Count how many are unread
                const unreadCount = await getUnreadCount(topicPosts.map(p => p.id));

                const isExpanded = savedState?.topics[topic.id] ?? false;
                let items: FeedItem[] = [];

                // If this topic was expanded before (from saved state), load its posts now
                if (isExpanded) {
                  const feedUrl = generateTopicFeedUrl(topic.slug);
                  items = await fetchTopicFeed(feedUrl);
                }

                return {
                  topic,
                  items,
                  unreadCount,
                  expanded: isExpanded,
                  loading: false,
                };
              })
          );
        }

        const sectionExpanded = savedState?.sections[result.feedKey] ?? false;

        return {
          feedKey: result.feedKey,
          items: result.items,
          topics: topicSections,
          unreadCount,
          expanded: sectionExpanded,
          accessible: result.accessible,
          loading: false,
          error: result.error,
        };
      })
    );
  }

  async function loadFeeds() {
    try {
      const results = await fetchAllFeeds();
      results.forEach(r => {
        console.log(r.feedKey, 'accessible:', r.accessible, 'items:', r.items.length, 'error:', r.error);
      });
      const built = await buildSections(results);
      setSections(built);

      // Load read states for all items
      const allItems = built.flatMap((s) => s.items);
      const readStates: ItemReadState = {};
      for (const item of allItems) {
        readStates[item.id] = await isRead(item.id);
      }
      setItemReadStates(readStates);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }

  useEffect(() => {
    loadPreferences();
    loadFeeds();
  }, []);

  useFocusEffect(
    useCallback(() => {
      // Reload preferences when screen comes into focus (may have changed in Settings)
      loadPreferences();
    }, [])
  );

  async function loadPreferences() {
    const hideSnippet = await getHideSnippetOnRead();
    setHideSnippetOnRead(hideSnippet);
  }

  function onRefresh() {
    setRefreshing(true);
    loadFeeds();
  }

  function toggleSection(feedKey: FeedKey) {
    setSections((prev) => {
      const updated = prev.map((s) =>
        s.feedKey === feedKey ? { ...s, expanded: !s.expanded } : s
      );

      // Save expanded state
      const expandedState: ExpandedState = {
        sections: Object.fromEntries(
          updated.map(s => [s.feedKey, s.expanded])
        ) as Record<FeedKey, boolean>,
        topics: {},
      };
      saveExpandedState(expandedState);

      return updated;
    });
  }

  async function toggleTopic(feedKey: FeedKey, topicId: string) {
    setSections((prev) => {
      const updated = prev.map((s) => {
        if (s.feedKey !== feedKey) return s;

        return {
          ...s,
          topics: s.topics.map((t) => {
            if (t.topic.id !== topicId) return t;

            const newExpanded = !t.expanded;
            const shouldLoad = newExpanded && t.items.length === 0 && !t.loading;

            // Load topic posts if expanding and not already loaded
            if (shouldLoad) {
              loadTopicPosts(feedKey, t.topic);
            }

            return { ...t, expanded: newExpanded, loading: shouldLoad ? true : t.loading };
          }),
        };
      });

      // Save expanded state
      const expandedState: ExpandedState = {
        sections: Object.fromEntries(
          updated.map(s => [s.feedKey, s.expanded])
        ) as Record<FeedKey, boolean>,
        topics: Object.fromEntries(
          updated.flatMap(s =>
            s.topics.map(t => [t.topic.id, t.expanded])
          )
        ),
      };
      saveExpandedState(expandedState);

      return updated;
    });
  }

  async function loadTopicPosts(feedKey: FeedKey, topic: Topic) {
    setSections((prev) =>
      prev.map((s) =>
        s.feedKey === feedKey
          ? {
              ...s,
              topics: s.topics.map((t) =>
                t.topic.id === topic.id ? { ...t, loading: true } : t
              ),
            }
          : s
      )
    );

    try {
      const feedUrl = generateTopicFeedUrl(topic.slug);
      const posts = await fetchTopicFeed(feedUrl);

      // Load read states for topic posts
      const readStates: ItemReadState = {};
      for (const post of posts) {
        readStates[post.id] = await isRead(post.id);
      }
      setItemReadStates((prev) => ({ ...prev, ...readStates }));

      // Update unread count for topic
      const topicUnreadCount = await getUnreadCount(posts.map((p) => p.id));

      setSections((prev) =>
        prev.map((s) =>
          s.feedKey === feedKey
            ? {
                ...s,
                topics: s.topics.map((t) =>
                  t.topic.id === topic.id
                    ? {
                        ...t,
                        items: posts,
                        unreadCount: topicUnreadCount,
                        loading: false,
                      }
                    : t
                ),
              }
            : s
        )
      );
    } catch (error) {
      console.error(`Failed to load topic posts for ${topic.name}:`, error);
      setSections((prev) =>
        prev.map((s) =>
          s.feedKey === feedKey
            ? {
                ...s,
                topics: s.topics.map((t) =>
                  t.topic.id === topic.id ? { ...t, loading: false } : t
                ),
              }
            : s
        )
      );
    }
  }

  async function onPressItem(item: FeedItem) {
    await markRead(item.id);
    setItemReadStates((prev) => ({ ...prev, [item.id]: true }));
    setSections((prev) =>
      prev.map((s) =>
        s.feedKey === item.feedKey
          ? { ...s, unreadCount: Math.max(0, s.unreadCount - 1) }
          : s
      )
    );
    router.push({
      pathname: '/post',
      params: { url: item.link, title: item.title },
    });
  }

  async function markTopicAsRead(feedKey: FeedKey, topicId: string) {
    // Find the topic to get its name for matching
    let topicName = '';
    setSections((prev) => {
      const section = prev.find(s => s.feedKey === feedKey);
      if (section) {
        const topic = section.topics.find(t => t.topic.id === topicId);
        if (topic) {
          topicName = topic.topic.name;
        }
      }
      return prev;
    });

    // Mark all items as read
    setSections((prev) =>
      prev.map((s) => {
        if (s.feedKey !== feedKey) return s;

        let itemsToMark: FeedItem[] = [];

        return {
          ...s,
          topics: s.topics.map((t) => {
            if (t.topic.id !== topicId) return t;

            // Collect all items to mark: topic-specific posts + main feed posts
            itemsToMark = [
              ...t.items, // Expanded topic posts
              ...s.items.filter(item => extractTopicFromTitle(item.title) === t.topic.name), // Main feed posts
            ];

            // Mark items as read in storage
            itemsToMark.forEach(async (item) => {
              if (!itemReadStates[item.id]) {
                await markRead(item.id);
              }
            });

            // Update read states immediately
            setItemReadStates((prev) => {
              const updated = { ...prev };
              itemsToMark.forEach((item) => {
                updated[item.id] = true;
              });
              return updated;
            });

            return { ...t, unreadCount: 0 };
          }),
        };
      })
    );

    // Update forum unread count
    setSections((prev) =>
      prev.map((s) => {
        if (s.feedKey !== feedKey) return s;
        const totalUnread = s.topics.reduce((sum, t) => sum + t.unreadCount, 0);
        return { ...s, unreadCount: totalUnread };
      })
    );
  }

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" />
      </View>
    );
  }

  return (
    <SafeAreaView style={styles.container}>
      <FlatList
        data={sections.filter((s) => s.accessible)}
        keyExtractor={(s) => s.feedKey}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
        renderItem={({ item: section }) => (
          <View>
            <TouchableOpacity
              style={styles.sectionHeader}
              onPress={() => toggleSection(section.feedKey)}
            >
              <Text style={styles.sectionTitle}>
                {section.expanded ? '▼' : '▶'} {decodeHtmlEntities(FEEDS[section.feedKey].name)}
              </Text>
              {section.unreadCount > 0 && <Text style={styles.newIndicator}>[new]</Text>}
            </TouchableOpacity>

            {section.expanded && section.topics.length > 0 ? (
              // Nested view: Topics with posts
              section.topics.map((topicSection) => (
                <View key={topicSection.topic.id}>
                  <TouchableOpacity
                    style={styles.topicHeader}
                    onPress={() => toggleTopic(section.feedKey, topicSection.topic.id)}
                  >
                    <Text style={styles.topicTitle}>
                      {topicSection.expanded ? '▼' : '▶'} {decodeHtmlEntities(topicSection.topic.name)}
                    </Text>
                    <View style={styles.topicHeaderRight}>
                      {topicSection.unreadCount > 0 && (
                        <TouchableOpacity
                          onPress={() => markTopicAsRead(section.feedKey, topicSection.topic.id)}
                        >
                          <Text style={styles.newIndicator}>[new]</Text>
                        </TouchableOpacity>
                      )}
                    </View>
                  </TouchableOpacity>

                  {!topicSection.expanded && topicSection.topic.latestExcerpt && (() => {
                    const previewPostIsRead = topicSection.topic.latestItemId
                      ? itemReadStates[topicSection.topic.latestItemId]
                      : false;

                    // Hide entire preview if the post has been read
                    if (previewPostIsRead) return null;

                    return (
                      <View style={styles.topicPreview}>
                        {topicSection.topic.latestAuthor && (
                          <Text style={styles.topicPreviewMeta}>
                            {decodeHtmlEntities(topicSection.topic.latestAuthor)}
                          </Text>
                        )}
                        <Text style={styles.topicPreviewExcerpt} numberOfLines={2}>
                          {decodeHtmlEntities(stripHtml(topicSection.topic.latestExcerpt))}
                        </Text>
                      </View>
                    );
                  })()}

                  {topicSection.expanded && topicSection.loading && (
                    <View style={styles.topicLoading}>
                      <ActivityIndicator size="small" />
                    </View>
                  )}

                  {topicSection.expanded &&
                    !topicSection.loading &&
                    topicSection.items.map((item) => {
                      const itemIsRead = itemReadStates[item.id];
                      // Strip "Reply To: {topic}" from title when inside the topic
                      let displayTitle = item.title.startsWith('Reply To: ')
                        ? item.title.slice(10).trim()
                        : item.title;
                      displayTitle = decodeHtmlEntities(displayTitle);

                      return (
                        <TouchableOpacity
                          key={item.id}
                          style={styles.topicItem}
                          onPress={() => onPressItem(item)}
                        >
                          <View style={styles.itemMeta}>
                            <Text style={styles.itemMetaText}>
                              {item.author ? `${decodeHtmlEntities(item.author)} · ` : ''}
                              {new Date(item.pubDate).toLocaleDateString('en-US', {
                                month: 'numeric',
                                day: 'numeric',
                                hour: '2-digit',
                                minute: '2-digit',
                              })}
                            </Text>
                          </View>
                          {displayTitle !== topicSection.topic.name && (
                            <View style={styles.titleRow}>
                              <Text style={styles.itemTitle}>{displayTitle}</Text>
                              {!itemIsRead && <Text style={styles.newBadge}>[new]</Text>}
                            </View>
                          )}
                          {item.excerpt ? (
                            <Text style={styles.itemExcerpt} numberOfLines={2}>
                              {decodeHtmlEntities(stripHtml(item.excerpt))}
                            </Text>
                          ) : null}
                        </TouchableOpacity>
                      );
                    })}

                  {topicSection.expanded && topicSection.items.length === 0 && !topicSection.loading && (
                    <Text style={styles.empty}>No posts found.</Text>
                  )}
                </View>
              ))
            ) : section.expanded ? (
              // Flat view: Posts directly (for non-forum feeds like Members Area)
              section.items.map((item) => {
                const itemIsRead = itemReadStates[item.id];
                const showSnippet = !itemIsRead || !hideSnippetOnRead;

                return (
                  <TouchableOpacity
                    key={item.id}
                    style={styles.item}
                    onPress={() => onPressItem(item)}
                  >
                    <View style={styles.titleRow}>
                      <Text style={styles.itemTitle}>{decodeHtmlEntities(item.title)}</Text>
                      {!itemIsRead && <Text style={styles.newBadge}>[new]</Text>}
                    </View>
                    {showSnippet && item.excerpt ? (
                      <Text style={styles.itemExcerpt} numberOfLines={2}>
                        {decodeHtmlEntities(stripHtml(item.excerpt))}
                      </Text>
                    ) : null}
                    <Text style={styles.itemMeta}>
                      {item.author ? `${decodeHtmlEntities(item.author)} · ` : ''}
                      {new Date(item.pubDate).toLocaleDateString()}
                    </Text>
                  </TouchableOpacity>
                );
              })
            ) : null}

            {section.expanded && section.topics.length === 0 && section.items.length === 0 && (
              <Text style={styles.empty}>No posts found.</Text>
            )}
          </View>
        )}
        ItemSeparatorComponent={() => <View style={styles.sectionSeparator} />}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#fff' },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: 16,
    backgroundColor: '#f5f5f5',
    borderBottomWidth: 1,
    borderBottomColor: '#e0e0e0',
  },
  sectionTitle: { fontSize: 15, fontWeight: '700', color: '#1a1a1a' },
  newIndicator: { fontSize: 11, fontWeight: '600', color: '#22c55e' },
  item: { padding: 16, backgroundColor: '#fff' },
  topicHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 12,
    paddingHorizontal: 16,
    backgroundColor: '#fafafa',
    borderBottomWidth: 1,
    borderBottomColor: '#f0f0f0',
  },
  topicTitle: { fontSize: 13, fontWeight: '600', color: '#555', flex: 1 },
  topicHeaderRight: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  topicPreview: { paddingVertical: 8, paddingHorizontal: 32, backgroundColor: '#fbfbfb', borderBottomWidth: 1, borderBottomColor: '#f0f0f0' },
  topicPreviewMeta: { fontSize: 11, color: '#888', marginBottom: 4 },
  topicPreviewExcerpt: { fontSize: 12, color: '#666', lineHeight: 16 },
  topicItem: { paddingVertical: 12, paddingHorizontal: 32, backgroundColor: '#fff' },
  topicLoading: { paddingVertical: 12, paddingHorizontal: 32, alignItems: 'center' },
  itemMeta: { marginBottom: 8 },
  itemMetaText: { fontSize: 12, color: '#888' },
  titleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 },
  itemTitle: { fontSize: 15, fontWeight: '500', color: '#1a1a1a', flex: 1 },
  newBadge: { fontSize: 11, fontWeight: '600', color: '#22c55e', marginLeft: 8 },
  itemExcerpt: { fontSize: 13, color: '#555', marginBottom: 4, lineHeight: 18 },
  sectionSeparator: { height: 1, backgroundColor: '#e0e0e0' },
  empty: { padding: 16, color: '#888', fontStyle: 'italic' },
});
