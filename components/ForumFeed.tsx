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
import * as Linking from 'expo-linking';
import { fetchSingleFeed, fetchTopicFeed, FeedItem, FeedResult, FEEDS, FeedKey } from '../services/feedService';
import { getUnreadCount, markRead, isRead } from '../services/readStateService';
import { getHideSnippetOnRead, storageGetObject, storageSetObject } from '../services/storageService';
import { getTopicsForForum, generateTopicFeedUrl, extractTopicFromTitle, Topic } from '../services/topicService';
import { isTopicSubscribed, setTopicSubscription } from '../services/subscriptionService';

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

  decoded = decoded.replace(/&#(\d+);/g, (match, dec) => String.fromCharCode(parseInt(dec, 10)));
  decoded = decoded.replace(/&#x([0-9a-f]+);/gi, (match, hex) => String.fromCharCode(parseInt(hex, 16)));

  return decoded;
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]*>/g, '').replace(/&[^;]+;/g, ' ').trim();
}

async function getSectionExpandedState(feedKey: FeedKey): Promise<boolean> {
  const state = await storageGetObject<Record<FeedKey, boolean>>(`expanded_state_${feedKey}`);
  return state?.[feedKey] ?? false;
}

async function saveSectionExpandedState(feedKey: FeedKey, expanded: boolean): Promise<void> {
  await storageSetObject(`expanded_state_${feedKey}`, { [feedKey]: expanded });
}

async function getTopicExpandedStates(feedKey: FeedKey): Promise<Record<string, boolean>> {
  return (await storageGetObject<Record<string, boolean>>(`topic_expanded_${feedKey}`)) ?? {};
}

async function saveTopicExpandedStates(feedKey: FeedKey, states: Record<string, boolean>): Promise<void> {
  await storageSetObject(`topic_expanded_${feedKey}`, states);
}

export function ForumFeed({ feedKey, title }: { feedKey: FeedKey; title?: string }) {
  const [section, setSection] = useState<SectionState | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [hideSnippetOnRead, setHideSnippetOnRead] = useState(false);
  const [itemReadStates, setItemReadStates] = useState<ItemReadState>({});

  async function buildSection(result: FeedResult): Promise<SectionState> {
    const unreadCount = await getUnreadCount(result.items.map((i) => i.id));

    const feed = FEEDS[feedKey];
    let topicSections: TopicSection[] = []; // Always initialize

    if (feed.hasSubFeeds && result.accessible) {
      const allTopics = await getTopicsForForum(feedKey);
      const topicExpandedStates = await getTopicExpandedStates(feedKey);

      const subscribedTopics = await Promise.all(
        allTopics.map(async (topic) => ({
          topic,
          subscribed: await isTopicSubscribed(topic.id, feedKey),
        }))
      );

      topicSections = await Promise.all(
        subscribedTopics
          .filter(({ subscribed }) => subscribed)
          .map(async ({ topic }) => {
            const topicPosts = result.items.filter(
              item => extractTopicFromTitle(item.title) === topic.name
            );
            const unreadCount = await getUnreadCount(topicPosts.map(p => p.id));

            const isExpanded = topicExpandedStates[topic.id] ?? false;
            let items: FeedItem[] = [];

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

    return {
      items: result.items || [],
      topics: topicSections || [],
      unreadCount,
      accessible: result.accessible,
      loading: false,
      error: result.error,
    };
  }

  async function loadFeed() {
    try {
      const result = await fetchSingleFeed(feedKey);
      const built = await buildSection(result);
      setSection(built);

      const allItems = [...built.items, ...built.topics.flatMap(t => t.items)];
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
    loadFeed();
  }, [feedKey]);

  useFocusEffect(
    useCallback(() => {
      loadPreferences();
    }, [])
  );

  async function loadPreferences() {
    const hideSnippet = await getHideSnippetOnRead();
    setHideSnippetOnRead(hideSnippet);
  }

  function onRefresh() {
    setRefreshing(true);
    loadFeed();
  }


  async function toggleTopic(topicId: string) {
    if (!section) return;

    setSection((prev) => {
      if (!prev) return prev;

      const updated = {
        ...prev,
        topics: prev.topics.map((t) => {
          if (t.topic.id !== topicId) return t;

          const newExpanded = !t.expanded;
          const shouldLoad = newExpanded && t.items.length === 0 && !t.loading;

          if (shouldLoad) {
            loadTopicPosts(t.topic);
          }

          return { ...t, expanded: newExpanded, loading: shouldLoad ? true : t.loading };
        }),
      };

      // Save topic expanded states
      const topicStates = Object.fromEntries(
        updated.topics.map(t => [t.topic.id, t.expanded])
      );
      saveTopicExpandedStates(feedKey, topicStates);

      return updated;
    });
  }

  async function loadTopicPosts(topic: Topic) {
    setSection((prev) =>
      prev
        ? {
            ...prev,
            topics: prev.topics.map((t) =>
              t.topic.id === topic.id ? { ...t, loading: true } : t
            ),
          }
        : prev
    );

    try {
      const feedUrl = generateTopicFeedUrl(topic.slug);
      const posts = await fetchTopicFeed(feedUrl);

      const readStates: ItemReadState = {};
      for (const post of posts) {
        readStates[post.id] = await isRead(post.id);
      }
      setItemReadStates((prev) => ({ ...prev, ...readStates }));

      const topicUnreadCount = await getUnreadCount(posts.map((p) => p.id));

      setSection((prev) =>
        prev
          ? {
              ...prev,
              topics: prev.topics.map((t) =>
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
          : prev
      );
    } catch (error) {
      setSection((prev) =>
        prev
          ? {
              ...prev,
              topics: prev.topics.map((t) =>
                t.topic.id === topic.id ? { ...t, loading: false } : t
              ),
            }
          : prev
      );
    }
  }

  async function onPressItem(item: FeedItem) {
    await markRead(item.id);
    setItemReadStates((prev) => ({ ...prev, [item.id]: true }));
    setSection((prev) =>
      prev ? { ...prev, unreadCount: Math.max(0, prev.unreadCount - 1) } : prev
    );
    Linking.openURL(item.link);
  }

  async function unsubscribeTopic(topicId: string) {
    try {
      await setTopicSubscription(topicId, false);
      setSection((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          topics: prev.topics.filter((t) => t.topic.id !== topicId),
        };
      });
    } catch (error) {
      // Silently fail; topic remains in view until next refresh
    }
  }

  async function markTopicAsRead(topicId: string) {
    if (!section) return;

    setSection((prev) => {
      if (!prev) return prev;

      let itemsToMark: FeedItem[] = [];

      return {
        ...prev,
        topics: prev.topics.map((t) => {
          if (t.topic.id !== topicId) return t;

          itemsToMark = [
            ...t.items,
            ...prev.items.filter(item => extractTopicFromTitle(item.title) === t.topic.name),
          ];

          itemsToMark.forEach(async (item) => {
            if (!itemReadStates[item.id]) {
              await markRead(item.id);
            }
          });

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
    });

    setSection((prev) => {
      if (!prev) return prev;
      const totalUnread = prev.topics.reduce((sum, t) => sum + t.unreadCount, 0);
      return { ...prev, unreadCount: totalUnread };
    });
  }

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" />
      </View>
    );
  }

  if (!section) {
    return (
      <View style={styles.center}>
        <Text>Failed to load feed</Text>
      </View>
    );
  }

  if (!section.accessible) {
    return (
      <View style={styles.center}>
        <Text>You don&apos;t have access to this feed</Text>
      </View>
    );
  }

  return (
    <SafeAreaView style={styles.container}>
      {title && <Text style={styles.forumTitle}>{title}</Text>}
      <FlatList
        data={section ? [section] : []}
        keyExtractor={() => feedKey}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
        renderItem={() => (
          section ? (
            <View>
              {section.topics.length > 0
                ? section.topics.map((topicSection) => (
                    <View key={topicSection.topic.id}>
                      <View style={styles.topicHeader}>
                        <TouchableOpacity
                          style={styles.topicTitleButton}
                          onPress={() => toggleTopic(topicSection.topic.id)}
                        >
                          <Text style={styles.topicTitle}>
                            {topicSection.expanded ? '▼' : '▶'} {decodeHtmlEntities(topicSection.topic.name)}
                          </Text>
                        </TouchableOpacity>
                        <View style={styles.topicHeaderRight}>
                          {topicSection.unreadCount > 0 && (
                            <TouchableOpacity onPress={() => {
                              markTopicAsRead(topicSection.topic.id);
                              // Collapse the topic
                              if (topicSection.expanded) {
                                toggleTopic(topicSection.topic.id);
                              }
                            }}>
                              <Text style={styles.newIndicator}>[new]</Text>
                            </TouchableOpacity>
                          )}
                          <TouchableOpacity
                            onPress={() => unsubscribeTopic(topicSection.topic.id)}
                            style={styles.unsubscribeButton}
                          >
                            <Text style={styles.unsubscribeText}>✕</Text>
                          </TouchableOpacity>
                        </View>
                      </View>

                      {!topicSection.expanded && topicSection.topic.latestExcerpt && (() => {
                        const previewPostIsRead = topicSection.topic.latestItemId
                          ? itemReadStates[topicSection.topic.latestItemId]
                          : false;

                        if (previewPostIsRead) return null;

                        return (
                          <TouchableOpacity
                            style={styles.topicPreview}
                            onPress={() => {
                              if (topicSection.topic.latestItemLink && topicSection.topic.latestItemId) {
                                markRead(topicSection.topic.latestItemId);
                                setItemReadStates((prev) => ({ ...prev, [topicSection.topic.latestItemId!]: true }));
                                Linking.openURL(topicSection.topic.latestItemLink);
                              }
                            }}
                          >
                            {(topicSection.topic.latestAuthor || topicSection.topic.latestPubDate) && (
                              <Text style={styles.topicPreviewMeta}>
                                {topicSection.topic.latestAuthor ? `${decodeHtmlEntities(topicSection.topic.latestAuthor)}` : ''}
                                {topicSection.topic.latestAuthor && topicSection.topic.latestPubDate ? ' · ' : ''}
                                {topicSection.topic.latestPubDate ? new Date(topicSection.topic.latestPubDate).toLocaleDateString('en-US', {
                                  month: 'numeric',
                                  day: 'numeric',
                                  hour: '2-digit',
                                  minute: '2-digit',
                                }) : ''}
                              </Text>
                            )}
                            <Text style={styles.topicPreviewExcerpt} numberOfLines={2}>
                              {decodeHtmlEntities(stripHtml(topicSection.topic.latestExcerpt))}
                            </Text>
                          </TouchableOpacity>
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
                : section.items.map((item) => {
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
                  })}

              {section.topics.length === 0 && section.items.length === 0 && (
                <Text style={styles.empty}>No posts found.</Text>
              )}
            </View>
          ) : null
        )}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#fff' },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  forumTitle: { fontSize: 18, fontWeight: '600', color: '#1a1a1a', paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: '#f0f0f0' },
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
  topicTitleButton: { flex: 1 },
  topicTitle: { fontSize: 13, fontWeight: '600', color: '#555' },
  topicHeaderRight: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  unsubscribeButton: { padding: 4 },
  unsubscribeText: { fontSize: 16, color: '#999', fontWeight: '600' },
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
  empty: { padding: 16, color: '#888', fontStyle: 'italic' },
});
