import { useEffect, useState } from 'react';
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
import { router } from 'expo-router';
import { fetchAllFeeds, FeedItem, FeedResult } from '../../services/feedService';

export default function FeedScreen() {
  const [items, setItems] = useState<FeedItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function loadFeeds() {
    try {
      const results: FeedResult[] = await fetchAllFeeds();
      const allItems = results
        .filter((r) => r.accessible)
        .flatMap((r) => r.items)
        .sort((a, b) => new Date(b.pubDate).getTime() - new Date(a.pubDate).getTime());
      setItems(allItems);
      setError(null);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }

  useEffect(() => {
    loadFeeds();
  }, []);

  function onRefresh() {
    setRefreshing(true);
    loadFeeds();
  }

  function onPressItem(item: FeedItem) {
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

  if (error) {
    return (
      <View style={styles.center}>
        <Text style={styles.errorText}>{error}</Text>
        <TouchableOpacity onPress={loadFeeds}>
          <Text style={styles.retryText}>Tap to retry</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <SafeAreaView style={styles.container}>
      <FlatList
        data={items}
        keyExtractor={(item) => item.id}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
        renderItem={({ item }) => (
          <TouchableOpacity style={styles.item} onPress={() => onPressItem(item)}>
            <Text style={styles.feedName}>{item.feedName}</Text>
            <Text style={styles.title}>{item.title}</Text>
            <Text style={styles.meta}>
              {item.author ? `${item.author} · ` : ''}
              {new Date(item.pubDate).toLocaleDateString()}
            </Text>
          </TouchableOpacity>
        )}
        ItemSeparatorComponent={() => <View style={styles.separator} />}
        ListEmptyComponent={<Text style={styles.empty}>No posts found.</Text>}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#fff' },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  item: { padding: 16 },
  feedName: { fontSize: 11, color: '#2563eb', fontWeight: '600', marginBottom: 4, textTransform: 'uppercase' },
  title: { fontSize: 16, fontWeight: '500', color: '#1a1a1a', marginBottom: 4 },
  meta: { fontSize: 12, color: '#888' },
  separator: { height: 1, backgroundColor: '#eee' },
  empty: { textAlign: 'center', padding: 32, color: '#888' },
  errorText: { color: '#cc0000', marginBottom: 16 },
  retryText: { color: '#2563eb' },
});