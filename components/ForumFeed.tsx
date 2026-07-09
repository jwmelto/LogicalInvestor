import { useEffect, useState, useCallback } from 'react';
import {
  View,
  Text,
  FlatList,
  TouchableOpacity,
  ActivityIndicator,
  StyleSheet,
  RefreshControl,
  Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect } from '@react-navigation/native';
import * as Linking from 'expo-linking';
import { fetchTopicFeed, RssItem, FeedResult, FEEDS, FeedKey } from '../services/feedService';
import { getUnreadCount, markRead, markAllRead, isRead } from '../services/readStateService';
import { getHideSnippetOnRead, storageGetObject, storageSetObject } from '../services/storageService';
import { getTopicsForForum, generateTopicFeedUrl, Topic } from '../services/topicService';
import { isTopicSubscribed, setTopicSubscription } from '../services/subscriptionService';
import { useFeed } from '../contexts/FeedContext';
import { addNotificationAuthor } from '../services/notificationService';
import { reportMissedAlert, type ReportableItem } from '../services/reportService';
import { getCachedUnreadCounts, setCachedUnreadCounts } from '../services/storageService';
import { useColorScheme } from '../hooks/use-color-scheme';
import { Palette } from '../constants/theme';

interface ItemReadState {
  [itemId: string]: boolean;
}

interface TopicSection {
  topic: Topic;
  items: RssItem[];
  unreadCount: number;
  expanded: boolean;
  loading: boolean;
}

interface SectionState {
  items: RssItem[];
  topics: TopicSection[];
  unreadCount: number;
  accessible: boolean;
  loading: boolean;
  error?: string;
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
  const scheme = useColorScheme();
  const c = scheme === 'dark' ? Palette.dark : Palette.light;
  const [section, setSection] = useState<SectionState | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [hideSnippetOnRead, setHideSnippetOnRead] = useState(false);
  const [itemReadStates, setItemReadStates] = useState<ItemReadState>({});
  const { feedResults, setFeedUnreadCount, triggerRefresh } = useFeed();
  const result = feedResults[feedKey];

  async function buildSection(result: FeedResult): Promise<SectionState> {
    const unreadCount = await getUnreadCount(result.items.map((i) => i.guid));

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
              item => item.title === topic.name
            );
            const unreadCount = await getUnreadCount(topicPosts.map(p => p.guid));

            const isExpanded = topicExpandedStates[topic.id] ?? false;
            let items: RssItem[] = [];

            if (isExpanded) {
              const feedUrl = generateTopicFeedUrl(topic.slug);
              items = await fetchTopicFeed(feedUrl, feedKey);
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

  useEffect(() => {
    if (!result) return;

    (async () => {
      try {
        const built = await buildSection(result);
        setSection(built);

        const totalUnread = built.topics.length > 0
          ? built.topics.reduce((sum, t) => sum + t.unreadCount, 0)
          : built.unreadCount;
        setFeedUnreadCount(feedKey, totalUnread);

        const cached = await getCachedUnreadCounts();
        await setCachedUnreadCounts({ ...cached, [feedKey]: totalUnread });

        const allItems = [...built.items, ...built.topics.flatMap(t => t.items)];
        const previewItemIds = built.topics
          .map(t => t.topic.latestItemId)
          .filter((id): id is string => !!id);

        const readStates: ItemReadState = {};
        for (const item of allItems) {
          readStates[item.guid] = await isRead(item.guid);
        }
        for (const id of previewItemIds) {
          if (!(id in readStates)) {
            readStates[id] = await isRead(id);
          }
        }
        setItemReadStates(readStates);
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    })();
  // ponytail: result object ref changes on every fetch — that's the intended trigger
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result]);

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
    triggerRefresh();
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
      const posts = await fetchTopicFeed(feedUrl, feedKey);

      const readStates: ItemReadState = {};
      for (const post of posts) {
        readStates[post.guid] = await isRead(post.guid);
      }
      setItemReadStates((prev) => ({ ...prev, ...readStates }));

      const topicUnreadCount = await getUnreadCount(posts.map((p) => p.guid));

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

  async function onPressItem(item: RssItem) {
    await markRead(item.guid);
    setItemReadStates((prev) => ({ ...prev, [item.guid]: true }));
    setSection((prev) => {
      if (!prev) return prev;
      return { ...prev, unreadCount: Math.max(0, prev.unreadCount - 1) };
    });
    const newCount = Math.max(0, (section?.unreadCount ?? 1) - 1);
    setFeedUnreadCount(feedKey, newCount);
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

  async function markAllFeedRead() {
    if (!section) return;
    const allIds = [
      ...section.items.map(i => i.guid),
      ...section.topics.flatMap(t => [
        ...t.items.map(i => i.guid),
        ...section.items
          .filter(i => i.title === t.topic.name)
          .map(i => i.guid),
      ]),
    ];
    if (allIds.length === 0) return;
    await markAllRead(allIds);
    setItemReadStates(prev => {
      const updated = { ...prev };
      allIds.forEach(id => { updated[id] = true; });
      return updated;
    });
    setSection(prev => {
      if (!prev) return prev;
      return {
        ...prev,
        unreadCount: 0,
        topics: prev.topics.map(t => ({ ...t, unreadCount: 0 })),
      };
    });
    setFeedUnreadCount(feedKey, 0);
    const cached = await getCachedUnreadCounts();
    await setCachedUnreadCounts({ ...cached, [feedKey]: 0 });
  }

  function showPostMenu(item: ReportableItem) {
    const name = item.author;
    Alert.alert(name, item.title, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Add author to alerts', onPress: () => addNotificationAuthor(name) },
      { text: 'Report: missed alert', onPress: () => reportMissedAlert(item) },
    ]);
  }

  async function markTopicAsRead(topicId: string) {
    if (!section) return;

    const topicSection = section.topics.find((t) => t.topic.id === topicId);
    if (!topicSection) return;

    // Collect all items for this topic from both the expanded list and the
    // top-level feed items (which contain replies filed under the topic name).
    const itemsToMark = [
      ...topicSection.items,
      ...section.items.filter(
        (item) => item.title === topicSection.topic.name
      ),
    ];

    // Single atomic read-modify-write for all IDs. Using Promise.all with
    // individual markRead calls would race (each does its own read-modify-write
    // on the same key and they overwrite each other).
    const unreadIds = itemsToMark
      .filter((item) => !itemReadStates[item.guid])
      .map((item) => item.guid);
    if (unreadIds.length > 0) {
      await markAllRead(unreadIds);
    }

    // Storage is settled — now update in-memory state.
    setItemReadStates((prev) => {
      const updated = { ...prev };
      itemsToMark.forEach((item) => { updated[item.guid] = true; });
      return updated;
    });

    setSection((prev) => {
      if (!prev) return prev;
      const updatedTopics = prev.topics.map((t) =>
        t.topic.id === topicId ? { ...t, unreadCount: 0 } : t
      );
      const totalUnread = updatedTopics.reduce((sum, t) => sum + t.unreadCount, 0);
      return { ...prev, topics: updatedTopics, unreadCount: totalUnread };
    });
    // Compute total from current section state (topics already zeroed for this topic)
    const totalUnread = (section?.topics ?? [])
      .reduce((sum, t) => t.topic.id === topicId ? sum : sum + t.unreadCount, 0);
    setFeedUnreadCount(feedKey, totalUnread);
  }

  if (loading) {
    return (
      <View style={[styles.center, { backgroundColor: c.bg }]}>
        <ActivityIndicator size="large" />
      </View>
    );
  }

  if (!section) {
    return (
      <View style={[styles.center, { backgroundColor: c.bg }]}>
        <Text style={{ color: c.text }}>Failed to load feed</Text>
      </View>
    );
  }

  if (!section.accessible) {
    return (
      <View style={[styles.center, { backgroundColor: c.bg }]}>
        <Text style={{ color: c.text }}>You don&apos;t have access to this feed</Text>
      </View>
    );
  }

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: c.bg }]}>
      {title && (
        <View style={[styles.feedHeader, { borderBottomColor: c.borderSubtle }]}>
          <Text style={[styles.forumTitle, { color: c.text }]}>{title}</Text>
          {section && section.unreadCount > 0 && (
            <TouchableOpacity onPress={markAllFeedRead} style={styles.markAllButton}>
              <Text style={[styles.markAllText, { color: c.tint }]}>Mark all read</Text>
            </TouchableOpacity>
          )}
        </View>
      )}
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
                      <View style={[styles.topicHeader, { backgroundColor: c.surface, borderBottomColor: c.borderSubtle }]}>
                        <TouchableOpacity
                          style={styles.topicTitleButton}
                          onPress={() => toggleTopic(topicSection.topic.id)}
                        >
                          <Text style={[styles.topicTitle, { color: c.textSecondary }]}>
                            {topicSection.expanded ? '▼' : '▶'} {topicSection.topic.name}
                          </Text>
                        </TouchableOpacity>
                        <View style={styles.topicHeaderRight}>
                          {topicSection.unreadCount > 0 && (
                            <TouchableOpacity onPress={async () => {
                              await markTopicAsRead(topicSection.topic.id);
                              // Collapse the topic
                              if (topicSection.expanded) {
                                toggleTopic(topicSection.topic.id);
                              }
                            }}>
                              <Text style={[styles.newIndicator, { color: c.newBadge }]}>[new]</Text>
                            </TouchableOpacity>
                          )}
                          <TouchableOpacity
                            onPress={() => unsubscribeTopic(topicSection.topic.id)}
                            style={styles.unsubscribeButton}
                          >
                            <Text style={[styles.unsubscribeText, { color: c.textMuted }]}>✕</Text>
                          </TouchableOpacity>
                        </View>
                      </View>

                      {!topicSection.expanded && topicSection.unreadCount > 0 && !itemReadStates[topicSection.topic.latestItemId] && (
                        <TouchableOpacity
                          style={[styles.topicPreview, { backgroundColor: c.surfaceAlt, borderBottomColor: c.borderSubtle }]}
                          onPress={async () => {
                            await markTopicAsRead(topicSection.topic.id);
                            Linking.openURL(topicSection.topic.latestItemLink);
                          }}
                          onLongPress={() => showPostMenu({ title: topicSection.topic.name, author: topicSection.topic.latestAuthor, link: topicSection.topic.latestItemLink, description: topicSection.topic.latestExcerpt })}
                        >
                          <Text style={[styles.topicPreviewMeta, { color: c.textMuted }]}>
                            {topicSection.topic.latestAuthor} · {new Date(topicSection.topic.lastUpdatedAt).toLocaleDateString('en-US', {
                              month: 'numeric',
                              day: 'numeric',
                              hour: '2-digit',
                              minute: '2-digit',
                            })}
                          </Text>
                          <Text style={[styles.topicPreviewExcerpt, { color: c.textSecondary }]} numberOfLines={2}>
                            {topicSection.topic.latestExcerpt}
                          </Text>
                        </TouchableOpacity>
                      )}

                      {topicSection.expanded && topicSection.loading && (
                        <View style={styles.topicLoading}>
                          <ActivityIndicator size="small" />
                        </View>
                      )}

                      {topicSection.expanded &&
                        !topicSection.loading &&
                        topicSection.items.map((item) => {
                          const itemIsRead = itemReadStates[item.guid];

                          return (
                            <TouchableOpacity
                              key={item.guid}
                              style={[styles.topicItem, { backgroundColor: c.bg }]}
                              onPress={() => onPressItem(item)}
                              onLongPress={() => showPostMenu(item)}
                            >
                              <View style={styles.itemMeta}>
                                <Text style={[styles.itemMetaText, { color: c.textMuted }]}>
                                  {item.author} · {item.pubDate.toLocaleDateString('en-US', {
                                    month: 'numeric',
                                    day: 'numeric',
                                    hour: '2-digit',
                                    minute: '2-digit',
                                  })}
                                </Text>
                              </View>
                              {item.title !== topicSection.topic.name && (
                                <View style={styles.titleRow}>
                                  <Text style={[styles.itemTitle, { color: c.text }]}>{item.title}</Text>
                                </View>
                              )}
                              <Text style={[styles.itemExcerpt, { color: c.textSecondary }]} numberOfLines={2}>
                                {item.description}
                              </Text>
                            </TouchableOpacity>
                          );
                        })}

                      {topicSection.expanded && topicSection.items.length === 0 && !topicSection.loading && (
                        <Text style={[styles.empty, { color: c.textMuted }]}>No posts found.</Text>
                      )}
                    </View>
                  ))
                : section.items.map((item) => {
                    const itemIsRead = itemReadStates[item.guid];
                    const showSnippet = !itemIsRead || !hideSnippetOnRead;

                    return (
                      <TouchableOpacity
                        key={item.guid}
                        style={[styles.item, { backgroundColor: c.bg }]}
                        onPress={() => onPressItem(item)}
                        onLongPress={() => showPostMenu(item)}
                      >
                        <View style={styles.titleRow}>
                          <Text style={[styles.itemTitle, { color: c.text }]}>{item.title}</Text>
                          {!itemIsRead && (
                            <TouchableOpacity
                              onPress={async (e) => {
                                e.stopPropagation();
                                await markRead(item.guid);
                                setItemReadStates(prev => ({ ...prev, [item.guid]: true }));
                                setSection(prev => prev ? { ...prev, unreadCount: Math.max(0, prev.unreadCount - 1) } : prev);
                                setFeedUnreadCount(feedKey, Math.max(0, (section?.unreadCount ?? 1) - 1));
                              }}
                              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                            >
                              <Text style={[styles.newBadge, { color: c.newBadge }]}>[new]</Text>
                            </TouchableOpacity>
                          )}
                        </View>
                        {showSnippet && (
                          <Text style={[styles.itemExcerpt, { color: c.textSecondary }]} numberOfLines={2}>
                            {item.description}
                          </Text>
                        )}
                        <Text style={[styles.itemMetaText, { color: c.textMuted }]}>
                          {item.author} · {item.pubDate.toLocaleDateString()}
                        </Text>
                      </TouchableOpacity>
                    );
                  })}

              {section.topics.length === 0 && section.items.length === 0 && (
                <Text style={[styles.empty, { color: c.textMuted }]}>
                  {section.error ? `Failed to load: ${section.error}` : 'No posts found.'}
                </Text>
              )}
            </View>
          ) : null
        )}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  feedHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderBottomWidth: 1 },
  forumTitle: { fontSize: 18, fontWeight: '600', paddingHorizontal: 16, paddingVertical: 12 },
  markAllButton: { paddingHorizontal: 16, paddingVertical: 12 },
  markAllText: { fontSize: 13, fontWeight: '500' },
  newIndicator: { fontSize: 11, fontWeight: '600' },
  item: { padding: 16 },
  topicHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderBottomWidth: 1,
  },
  topicTitleButton: { flex: 1 },
  topicTitle: { fontSize: 13, fontWeight: '600' },
  topicHeaderRight: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  unsubscribeButton: { padding: 4 },
  unsubscribeText: { fontSize: 16, fontWeight: '600' },
  topicPreview: { paddingVertical: 8, paddingHorizontal: 32, borderBottomWidth: 1 },
  topicPreviewMeta: { fontSize: 11, marginBottom: 4 },
  topicPreviewExcerpt: { fontSize: 12, lineHeight: 16 },
  topicItem: { paddingVertical: 12, paddingHorizontal: 32 },
  topicLoading: { paddingVertical: 12, paddingHorizontal: 32, alignItems: 'center' },
  itemMeta: { marginBottom: 8 },
  itemMetaText: { fontSize: 12 },
  titleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 },
  itemTitle: { fontSize: 15, fontWeight: '500', flex: 1 },
  newBadge: { fontSize: 11, fontWeight: '600', marginLeft: 8 },
  itemExcerpt: { fontSize: 13, marginBottom: 4, lineHeight: 18 },
  empty: { padding: 16, fontStyle: 'italic' },
});
