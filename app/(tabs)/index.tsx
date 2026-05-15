import { useEffect, useState, useCallback } from 'react';
import {
  View,
  Text,
  FlatList,
  TouchableOpacity,
  ActivityIndicator,
  StyleSheet,
  SafeAreaView,
  RefreshControl,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { router } from 'expo-router';
import { fetchAllFeeds, fetchSingleFeed, FeedItem, FeedResult, FEEDS, FeedKey } from '../../services/feedService';
import { getUnreadCount, markRead, isRead } from '../../services/readStateService';
import { getHideSnippetOnRead } from '../../services/storageService';

interface ItemReadState {
  [itemId: string]: boolean;
}

interface SectionState {
  feedKey: FeedKey;
  items: FeedItem[];
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
        return {
          feedKey: result.feedKey,
          items: result.items,
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

            {section.expanded && section.items.map((item) => {
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
            })}

            {section.expanded && section.items.length === 0 && (
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
  titleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 },
  itemTitle: { fontSize: 15, fontWeight: '500', color: '#1a1a1a', flex: 1 },
  newBadge: { fontSize: 11, fontWeight: '600', color: '#22c55e', marginLeft: 8 },
  itemExcerpt: { fontSize: 13, color: '#555', marginBottom: 4, lineHeight: 18 },
  itemMeta: { fontSize: 12, color: '#888' },
  sectionSeparator: { height: 1, backgroundColor: '#e0e0e0' },
  empty: { padding: 16, color: '#888', fontStyle: 'italic' },
});
