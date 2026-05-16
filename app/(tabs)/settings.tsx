import React, { useEffect, useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Switch, ScrollView } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect } from '@react-navigation/native';
import { router } from 'expo-router';
import { logout } from '../../services/authService';
import { getHideSnippetOnRead, setHideSnippetOnRead } from '../../services/storageService';
import { useForumVisibility } from '../../contexts/ForumVisibilityContext';
import { getTopics } from '../../services/topicService';
import { getAllTopicSubscriptions, setTopicSubscription } from '../../services/subscriptionService';
import type { Topic } from '../../services/topicService';

export default function SettingsScreen() {
  const [hideSnippet, setHideSnippet] = useState(false);
  const [loading, setLoading] = useState(true);
  const [silencedTopics, setSilencedTopics] = useState<Topic[]>([]);
  const [expandedForum, setExpandedForum] = useState<string | null>(null);
  const { visibility: forumVisibility, updateVisibility } = useForumVisibility();

  useEffect(() => {
    loadPreferences();
  }, []);

  useFocusEffect(
    React.useCallback(() => {
      loadPreferences();
    }, [])
  );

  async function loadPreferences() {
    const hideValue = await getHideSnippetOnRead();
    setHideSnippet(hideValue);

    const allTopics = await getTopics();
    const subscriptions = await getAllTopicSubscriptions();
    const silenced = allTopics.filter((topic) => subscriptions[topic.id] === false);
    setSilencedTopics(silenced);

    setLoading(false);
  }

  async function handleToggleHideSnippet(value: boolean) {
    setHideSnippet(value);
    await setHideSnippetOnRead(value);
  }

  async function handleToggleForumVisibility(forum: 'stockInsights' | 'optionsInsights', value: boolean) {
    await updateVisibility(forum, value);
  }

  async function handleLogout() {
    await logout();
    router.replace('/login');
  }

  async function resubscribeTopic(topic: Topic) {
    try {
      await setTopicSubscription(topic.id, true);
      setSilencedTopics((prev) => prev.filter((t) => t.id !== topic.id));
    } catch (error) {
      console.error(`Failed to resubscribe to topic ${topic.id}:`, error);
    }
  }

  const membersForumSilenced = silencedTopics.filter((t) => t.forumKey === 'membersForum');
  const stockInsightsSilenced = silencedTopics.filter((t) => t.forumKey === 'stockInsights');
  const optionsInsightsSilenced = silencedTopics.filter((t) => t.forumKey === 'optionsInsights');

  const renderSilencedTopicsForForum = (topics: Topic[]) => {
    return (
      <View style={styles.silencedTopicsContainer}>
        <Text style={styles.silencedTopicsLabel}>Silenced Topics</Text>
        {topics.length === 0 ? (
          <Text style={styles.emptyState}>None</Text>
        ) : (
          <View style={styles.silencedTopicsList}>
            {topics.map((topic) => (
              <View key={topic.id} style={styles.silencedTopic}>
                <Text style={styles.silencedTopicName}>{topic.name}</Text>
                <TouchableOpacity
                  style={styles.resubscribeButton}
                  onPress={() => resubscribeTopic(topic)}
                >
                  <Text style={styles.resubscribeButtonText}>Re-subscribe</Text>
                </TouchableOpacity>
              </View>
            ))}
          </View>
        )}
      </View>
    );
  };

  const renderForumSection = (title: string, forumKey: 'membersForum' | 'stockInsights' | 'optionsInsights', silencedTopics: Topic[]) => {
    const isOptional = forumKey !== 'membersForum';
    const isVisible = !isOptional || (forumKey === 'stockInsights' ? forumVisibility.stockInsights : forumVisibility.optionsInsights);
    const isExpanded = expandedForum === forumKey;

    return (
      <View key={forumKey} style={styles.forumSection}>
        <TouchableOpacity
          style={styles.forumHeaderButton}
          onPress={() => setExpandedForum(isExpanded ? null : forumKey)}
        >
          <View style={styles.forumHeaderLeft}>
            <Text style={styles.forumHeaderArrow}>{isExpanded ? '▼' : '▶'}</Text>
            <Text style={styles.forumTitle}>{title}</Text>
          </View>
          {isOptional && (
            <Switch
              value={isVisible}
              onValueChange={(value) => handleToggleForumVisibility(forumKey as any, value)}
              disabled={loading}
            />
          )}
        </TouchableOpacity>
        {isExpanded && isVisible && renderSilencedTopicsForForum(silencedTopics)}
      </View>
    );
  };

  return (
    <SafeAreaView style={styles.container}>
      <ScrollView style={styles.scrollContent} showsVerticalScrollIndicator={false}>
        <Text style={styles.title}>Settings</Text>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Display</Text>
          <View style={styles.preference}>
            <Text style={styles.preferenceLabel}>Hide snippets on read items</Text>
            <Switch
              value={hideSnippet}
              onValueChange={handleToggleHideSnippet}
              disabled={loading}
            />
          </View>
        </View>

        <Text style={styles.sectionTitle}>Forums</Text>

        {renderForumSection('Members Forum', 'membersForum', membersForumSilenced)}
        {renderForumSection('Stock Insights', 'stockInsights', stockInsightsSilenced)}
        {renderForumSection('Options Insights', 'optionsInsights', optionsInsightsSilenced)}
      </ScrollView>

      <View style={styles.footerSection}>
        <TouchableOpacity style={styles.button} onPress={handleLogout}>
          <Text style={styles.buttonText}>Log Out</Text>
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#fff' },
  scrollContent: { flex: 1, paddingHorizontal: 24, paddingTop: 24 },
  footerSection: { paddingHorizontal: 24, paddingVertical: 16, borderTopWidth: 1, borderTopColor: '#e0e0e0' },
  title: { fontSize: 24, fontWeight: 'bold', marginBottom: 32 },
  section: { marginBottom: 24 },
  sectionTitle: { fontSize: 14, fontWeight: '600', color: '#888', marginBottom: 12, textTransform: 'uppercase' },
  preference: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: '#e0e0e0' },
  preferenceLabel: { fontSize: 16, color: '#1a1a1a' },
  forumSection: { marginBottom: 28, paddingBottom: 20, borderBottomWidth: 1, borderBottomColor: '#f0f0f0' },
  forumHeaderButton: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 12, paddingHorizontal: 12, backgroundColor: '#f9f9f9', borderRadius: 8, marginBottom: 12 },
  forumHeaderLeft: { flexDirection: 'row', alignItems: 'center', gap: 8, flex: 1 },
  forumHeaderArrow: { fontSize: 14, color: '#666', fontWeight: '600', width: 16 },
  forumTitle: { fontSize: 16, fontWeight: '600', color: '#1a1a1a' },
  silencedTopicsContainer: { marginTop: 12, backgroundColor: '#fafafa', borderRadius: 8, padding: 12 },
  silencedTopicsLabel: { fontSize: 12, fontWeight: '600', color: '#666', marginBottom: 8, textTransform: 'uppercase' },
  emptyState: { fontSize: 13, color: '#999', fontStyle: 'italic', paddingVertical: 8 },
  silencedTopicsList: { gap: 8 },
  silencedTopic: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 8, paddingHorizontal: 8, backgroundColor: '#fff', borderRadius: 6, borderWidth: 1, borderColor: '#e0e0e0' },
  silencedTopicName: { fontSize: 13, fontWeight: '500', color: '#1a1a1a', flex: 1 },
  button: { backgroundColor: '#cc0000', borderRadius: 8, padding: 16, alignItems: 'center' },
  buttonText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  resubscribeButton: { paddingHorizontal: 10, paddingVertical: 6, backgroundColor: '#f0f0f0', borderRadius: 4 },
  resubscribeButtonText: { fontSize: 11, fontWeight: '600', color: '#0066cc' },
});
