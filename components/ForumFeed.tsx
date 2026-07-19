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
import { getAllScopes, viewScope, markRead, markAllRead, markGuidsRead, markScopesSeen } from '../services/readStateService';
import { getHideSnippetOnRead, storageGetObject, storageSetObject } from '../services/storageService';
import { getTopicsForForum, generateTopicUrl, Topic } from '../services/topicService';
import { getAllTopicSubscriptions, setTopicSubscription } from '../services/subscriptionService';
import { useFeed } from '../contexts/FeedContext';
import { addPushAuthor } from '../services/pushService';
import { reportMissedAlert, type ReportableItem } from '../services/reportService';
import { useColorScheme } from '../hooks/use-color-scheme';
import { Palette } from '../constants/theme';

interface ItemReadState {
  [itemId: string]: boolean;
}

interface TopicSection {
  topic: Topic;
  items: RssItem[];
  expanded: boolean;
  loading: boolean;
}

interface SectionState {
  items: RssItem[];
  topics: TopicSection[];
  accessible: boolean;
  loading: boolean;
  error?: string;
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
  const { feedResults, unread, topicUnread, refreshScopeUnread, triggerRefresh } = useFeed();
  const result = feedResults[feedKey];

  async function buildSection(result: FeedResult): Promise<SectionState> {
    const feed = FEEDS[feedKey];
    let topicSections: TopicSection[] = []; // Always initialize

    if (feed.hasSubFeeds && result.accessible) {
      const allTopics = await getTopicsForForum(feedKey);
      const topicExpandedStates = await getTopicExpandedStates(feedKey);
      const subs = await getAllTopicSubscriptions(); // one read, not one per topic
      const isSubscribed = (topicId: string) => subs[topicId] ?? true;

      topicSections = await Promise.all(
        allTopics
          .filter((topic) => isSubscribed(topic.id))
          .map(async (topic) => {
            const isExpanded = topicExpandedStates[topic.id] ?? false;
            let items: RssItem[] = [];

            if (isExpanded) {
              items = await fetchTopicFeed(generateTopicUrl(topic.slug), feedKey);
            }

            return {
              topic,
              items,
              expanded: isExpanded,
              loading: false,
            };
          })
      );
    }

    return {
      items: result.items || [],
      topics: topicSections,
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

        // One getAllScopes() read for the whole build — shared across the flat items, every
        // topic's items, and every topic's preview item, rather than a per-item storage read.
        const scopes = await getAllScopes();
        const readStates: ItemReadState = {};

        const flatView = viewScope(scopes[feedKey] ?? {});
        for (const item of built.items) {
          readStates[item.guid] = flatView.isRead(item.guid);
        }
        for (const t of built.topics) {
          const view = viewScope(scopes[t.topic.id] ?? {});
          for (const item of t.items) readStates[item.guid] = view.isRead(item.guid);
          if (!(t.topic.latestItemId in readStates)) {
            readStates[t.topic.latestItemId] = view.isRead(t.topic.latestItemId);
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

  function toggleTopic(topicId: string) {
    if (!section) return;
    const target = section.topics.find((t) => t.topic.id === topicId);
    if (!target) return;

    const newExpanded = !target.expanded;
    const shouldLoad = newExpanded && target.items.length === 0 && !target.loading;

    setSection((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        topics: prev.topics.map((t) =>
          t.topic.id === topicId
            ? { ...t, expanded: newExpanded, loading: shouldLoad ? true : t.loading }
            : t
        ),
      };
    });

    const topicStates = Object.fromEntries(
      section.topics.map((t) => [t.topic.id, t.topic.id === topicId ? newExpanded : t.expanded])
    );
    saveTopicExpandedStates(feedKey, topicStates);

    if (shouldLoad) loadTopicPosts(target.topic);
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
      const posts = await fetchTopicFeed(generateTopicUrl(topic.slug), feedKey);
      // Write-through to the same store detection uses, so a manual expand short-circuits the
      // next detection pass for this topic.
      await markScopesSeen({ [topic.id]: posts.map((p) => p.guid) });

      const scopes = await getAllScopes();
      const view = viewScope(scopes[topic.id] ?? {});
      setItemReadStates((prev) => {
        const updated = { ...prev };
        posts.forEach((p) => { updated[p.guid] = view.isRead(p.guid); });
        return updated;
      });

      setSection((prev) =>
        prev
          ? {
              ...prev,
              topics: prev.topics.map((t) =>
                t.topic.id === topic.id ? { ...t, items: posts, loading: false } : t
              ),
            }
          : prev
      );

      await refreshScopeUnread(feedKey, topic.id);
    } catch {
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

  async function onPressItem(item: RssItem, scopeId: string) {
    await markRead(scopeId, item.guid);
    setItemReadStates((prev) => ({ ...prev, [item.guid]: true }));
    await refreshScopeUnread(feedKey, scopeId);
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
    } catch {
      // Silently fail; topic remains in view until next refresh
    }
  }

  async function markAllFeedRead() {
    if (!section) return;

    if (section.topics.length > 0) {
      const scopes = await getAllScopes();
      const updates: Record<string, string[]> = {};
      for (const t of section.topics) {
        updates[t.topic.id] = Object.keys(scopes[t.topic.id] ?? {});
      }
      await markGuidsRead(updates); // one write for the whole forum, not one per topic

      setItemReadStates((prev) => {
        const updated = { ...prev };
        Object.values(updates).flat().forEach((guid) => { updated[guid] = true; });
        return updated;
      });

      await Promise.all(section.topics.map((t) => refreshScopeUnread(feedKey, t.topic.id)));
    } else {
      const allIds = section.items.map((i) => i.guid);
      if (allIds.length === 0) return;
      await markAllRead(feedKey, allIds);
      setItemReadStates((prev) => {
        const updated = { ...prev };
        allIds.forEach((id) => { updated[id] = true; });
        return updated;
      });
      await refreshScopeUnread(feedKey, feedKey);
    }
  }

  function showPostMenu(item: ReportableItem) {
    const name = item.author;
    Alert.alert(name, item.title, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Add author to alerts', onPress: () => addPushAuthor(name) },
      { text: 'Report: missed alert', onPress: () => reportMissedAlert(item) },
    ]);
  }

  // Marks every guid known for this topic as read, not just the ones currently displayed — the
  // store already holds the full known-guid set regardless of source (top-level attribution,
  // bounded deep-dive, or a prior fetch-on-expand), so a collapsed, never-expanded topic can still
  // be fully marked read from its "[new]" badge alone.
  async function markTopicAsRead(topicId: string) {
    if (!section) return;
    const topicSection = section.topics.find((t) => t.topic.id === topicId);
    if (!topicSection) return;

    const scopes = await getAllScopes();
    const allGuids = Object.keys(scopes[topicId] ?? {});
    if (allGuids.length > 0) {
      await markAllRead(topicId, allGuids);
    }

    setItemReadStates((prev) => {
      const updated = { ...prev };
      allGuids.forEach((guid) => { updated[guid] = true; });
      return updated;
    });

    await refreshScopeUnread(feedKey, topicId);
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

  const flatHasUnread = unread[feedKey] ?? false;
  const anyTopicUnread = section.topics.some((t) => topicUnread[feedKey]?.[t.topic.id] ?? false);
  const showMarkAllRead = anyTopicUnread || flatHasUnread;

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: c.bg }]}>
      {title && (
        <View style={[styles.feedHeader, { borderBottomColor: c.borderSubtle }]}>
          <Text style={[styles.forumTitle, { color: c.text }]}>{title}</Text>
          {showMarkAllRead && (
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
                ? section.topics.map((topicSection) => {
                    const topicHasUnread = topicUnread[feedKey]?.[topicSection.topic.id] ?? false;
                    return (
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
                          {topicHasUnread && (
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

                      {!topicSection.expanded && topicHasUnread && !itemReadStates[topicSection.topic.latestItemId] && (
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
                          return (
                            <TouchableOpacity
                              key={item.guid}
                              style={[styles.topicItem, { backgroundColor: c.bg }]}
                              onPress={() => onPressItem(item, topicSection.topic.id)}
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
                    );
                  })
                : section.items.map((item) => {
                    const itemIsRead = itemReadStates[item.guid];
                    const showSnippet = !itemIsRead || !hideSnippetOnRead;

                    return (
                      <TouchableOpacity
                        key={item.guid}
                        style={[styles.item, { backgroundColor: c.bg }]}
                        onPress={() => onPressItem(item, feedKey)}
                        onLongPress={() => showPostMenu(item)}
                      >
                        <View style={styles.titleRow}>
                          <Text style={[styles.itemTitle, { color: c.text }]}>{item.title}</Text>
                          {!itemIsRead && (
                            <TouchableOpacity
                              onPress={async (e) => {
                                e.stopPropagation();
                                await markRead(feedKey, item.guid);
                                setItemReadStates(prev => ({ ...prev, [item.guid]: true }));
                                await refreshScopeUnread(feedKey, feedKey);
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
