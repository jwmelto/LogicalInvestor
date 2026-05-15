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
import { getHideSnippetOnRead } from '../../services/storageService';
import { getTopicsForForum, generateTopicFeedUrl, Topic } from '../../services/topicService';
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

function stripHtml(html: string): string {
  return html.replace(/<[^>]*>/g, '').replace(/&[^;]+;/g, ' ').trim();
}

export default function FeedScreen() {
  const [sections, setSections] = useState<SectionState[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [hideSnippetOnRead, setHideSnippetOnRead] = useState(false);
  const [itemReadStates, setItemReadStates] = useState<ItemReadState>({});

  async function buildSections(results: FeedResult[]): Promise<SectionState[]> {
    return Promise.all(
      results.map(async (result, index) => {
        const isFirst = index === 0;
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

          topicSections = subscribedTopics
            .filter(({ subscribed }) => subscribed)
            .map(({ topic }) => ({
              topic,
              items: [], // Will be loaded lazily on expand
              unreadCount: 0,
              expanded: false,
              loading: false,
            }));
        }

        return {
          feedKey: result.feedKey,
          items: result.items,
          topics: topicSections,
          unreadCount,
          expanded: isFirst,
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
    setSections((prev) =>
      prev.map((s) =>
        s.feedKey === feedKey ? { ...s, expanded: !s.expanded } : s
      )
    );
  }

  async function toggleTopic(feedKey: FeedKey, topicId: string) {
    setSections((prev) =>
      prev.map((s) => {
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
      })
    );
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
                {section.expanded ? '▼' : '▶'} {FEEDS[section.feedKey].name}
              </Text>
              {section.unreadCount > 0 && (
                <View style={styles.badge}>
                  <Text style={styles.badgeText}>{section.unreadCount}</Text>
                </View>
              )}
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
                      {topicSection.expanded ? '▼' : '▶'} {topicSection.topic.name}
                    </Text>
                    {topicSection.unreadCount > 0 && (
                      <View style={styles.badge}>
                        <Text style={styles.badgeText}>{topicSection.unreadCount}</Text>
                      </View>
                    )}
                  </TouchableOpacity>

                  {topicSection.expanded && topicSection.loading && (
                    <View style={styles.topicLoading}>
                      <ActivityIndicator size="small" />
                    </View>
                  )}

                  {topicSection.expanded &&
                    !topicSection.loading &&
                    topicSection.items.map((item) => {
                      const itemIsRead = itemReadStates[item.id];
                      const showSnippet = !itemIsRead || !hideSnippetOnRead;

                      return (
                        <TouchableOpacity
                          key={item.id}
                          style={styles.topicItem}
                          onPress={() => onPressItem(item)}
                        >
                          <View style={styles.titleRow}>
                            <Text style={styles.itemTitle}>{item.title}</Text>
                            {!itemIsRead && <Text style={styles.newBadge}>[new]</Text>}
                          </View>
                          {showSnippet && item.excerpt ? (
                            <Text style={styles.itemExcerpt} numberOfLines={2}>
                              {stripHtml(item.excerpt)}
                            </Text>
                          ) : null}
                          <Text style={styles.itemMeta}>
                            {item.author ? `${item.author} · ` : ''}
                            {new Date(item.pubDate).toLocaleDateString()}
                          </Text>
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
                      <Text style={styles.itemTitle}>{item.title}</Text>
                      {!itemIsRead && <Text style={styles.newBadge}>[new]</Text>}
                    </View>
                    {showSnippet && item.excerpt ? (
                      <Text style={styles.itemExcerpt} numberOfLines={2}>
                        {stripHtml(item.excerpt)}
                      </Text>
                    ) : null}
                    <Text style={styles.itemMeta}>
                      {item.author ? `${item.author} · ` : ''}
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
  badge: {
    backgroundColor: '#2563eb',
    borderRadius: 10,
    minWidth: 20,
    height: 20,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 6,
  },
  badgeText: { color: '#fff', fontSize: 11, fontWeight: '700' },
  item: { padding: 16, backgroundColor: '#fff' },
  topicHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 12,
    paddingHorizontal: 24,
    backgroundColor: '#fafafa',
    borderBottomWidth: 1,
    borderBottomColor: '#f0f0f0',
  },
  topicTitle: { fontSize: 13, fontWeight: '600', color: '#555' },
  topicItem: { paddingVertical: 12, paddingHorizontal: 32, backgroundColor: '#fff' },
  topicLoading: { paddingVertical: 12, paddingHorizontal: 32, alignItems: 'center' },
  titleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 },
  itemTitle: { fontSize: 15, fontWeight: '500', color: '#1a1a1a', flex: 1 },
  newBadge: { fontSize: 11, fontWeight: '600', color: '#22c55e', marginLeft: 8 },
  itemExcerpt: { fontSize: 13, color: '#555', marginBottom: 4, lineHeight: 18 },
  itemMeta: { fontSize: 12, color: '#888' },
  sectionSeparator: { height: 1, backgroundColor: '#e0e0e0' },
  empty: { padding: 16, color: '#888', fontStyle: 'italic' },
});
