import React, { useEffect, useState } from 'react';
import * as Application from 'expo-application';
import { View, Text, TouchableOpacity, StyleSheet, Switch, ScrollView, TextInput } from 'react-native';
import Slider from '@react-native-community/slider';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useFocusEffect } from '@react-navigation/native';
import { logout } from '../../services/authService';
import { useAuth } from '../../contexts/AuthContext';
import { getHideSnippetOnRead, setHideSnippetOnRead, getRefreshInterval, setRefreshInterval } from '../../services/storageService';
import { getPushFilter, getPushAuthors, getPushMinLength, updatePushSettings, unregisterPushToken } from '../../services/pushService';
import { FILTER_TIERS, type ContentFilter } from '@li/core';
import { useForumVisibility } from '../../contexts/ForumVisibilityContext';
import { getTopics } from '../../services/topicService';
import { getAllTopicSubscriptions, setTopicSubscription } from '../../services/subscriptionService';
import type { Topic } from '../../services/topicService';
import { useColorScheme } from '../../hooks/use-color-scheme';
import { Palette } from '../../constants/theme';

// Single source of truth for the tier row's button label and explanatory hint — was two
// separate ternary chains, each restating the same three-way branch.
const FILTER_TIER_INFO: Record<ContentFilter, { label: string; hint: string }> = {
  members:    { label: 'Members',    hint: 'Members Area posts only' },
  actionable: { label: 'Actionable', hint: "Members Area, plus Sean's actionable trade calls elsewhere" },
  length:     { label: 'Length',     hint: 'Members Area, plus anything long enough elsewhere' },
};

export default function SettingsScreen() {
  const scheme = useColorScheme();
  const c = scheme === 'dark' ? Palette.dark : Palette.light;
  const [hideSnippet, setHideSnippet] = useState(false);
  const [refreshInterval, setRefreshIntervalState] = useState(30);
  const [loading, setLoading] = useState(true);
  const [pushFilter, setPushFilterState] = useState<ContentFilter>('actionable');
  const [pushAuthors, setPushAuthorsState] = useState<string[]>(['Sean']);
  const [pushMinLength, setPushMinLengthState] = useState(200);
  const [newAuthor, setNewAuthor] = useState('');
  const [expandedNotifications, setExpandedNotifications] = useState(true);
  const [silencedTopics, setSilencedTopics] = useState<Topic[]>([]);
  const [expandedForum, setExpandedForum] = useState<string | null>(null);
  const { visibility: forumVisibility, updateVisibility } = useForumVisibility();
  const { setAuthed } = useAuth();

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

    const [filter, authors, minLength] = await Promise.all([getPushFilter(), getPushAuthors(), getPushMinLength()]);
    setPushFilterState(filter);
    setPushAuthorsState(authors);
    setPushMinLengthState(minLength);

    const interval = await getRefreshInterval();
    setRefreshIntervalState(interval);

    const allTopics = await getTopics();
    const subscriptions = await getAllTopicSubscriptions();
    const silenced = allTopics.filter((topic) => subscriptions[topic.id] === false);
    setSilencedTopics(silenced);

    setLoading(false);
  }

  async function handlePushFilterChange(filter: ContentFilter) {
    setPushFilterState(filter);
    await updatePushSettings({ filter, authors: pushAuthors, minLength: pushMinLength });
  }

  async function handlePushAuthorsChange(authors: string[]) {
    setPushAuthorsState(authors);
    await updatePushSettings({ filter: pushFilter, authors, minLength: pushMinLength });
  }

  async function handlePushMinLengthChange(minLength: number) {
    setPushMinLengthState(minLength);
    await updatePushSettings({ filter: pushFilter, authors: pushAuthors, minLength });
  }

  async function handleToggleHideSnippet(value: boolean) {
    setHideSnippet(value);
    await setHideSnippetOnRead(value);
  }

  async function handleChangeRefreshInterval(minutes: number) {
    setRefreshIntervalState(minutes);
    await setRefreshInterval(minutes);
  }

  async function handleToggleForumVisibility(forum: 'stockInsights' | 'optionsInsights', value: boolean) {
    await updateVisibility(forum, value);
  }

  async function handleLogout() {
    await unregisterPushToken();
    await logout();
    setAuthed(false);
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
      <View style={[styles.silencedTopicsContainer, { backgroundColor: c.surfaceAlt }]}>
        <Text style={[styles.silencedTopicsLabel, { color: c.textMuted }]}>Silenced Topics</Text>
        {topics.length === 0 ? (
          <Text style={[styles.emptyState, { color: c.textFaint }]}>None</Text>
        ) : (
          <View style={styles.silencedTopicsList}>
            {topics.map((topic) => (
              <View key={topic.id} style={[styles.silencedTopic, { backgroundColor: c.bg, borderColor: c.border }]}>
                <Text style={[styles.silencedTopicName, { color: c.text }]}>{topic.name}</Text>
                <TouchableOpacity
                  style={[styles.resubscribeButton, { backgroundColor: c.resubscribeBg }]}
                  onPress={() => resubscribeTopic(topic)}
                >
                  <Text style={[styles.resubscribeButtonText, { color: c.resubscribeText }]}>Re-subscribe</Text>
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
          style={[styles.forumHeaderButton, { backgroundColor: c.surface }]}
          onPress={() => setExpandedForum(isExpanded ? null : forumKey)}
        >
          <View style={styles.forumHeaderLeft}>
            <Text style={[styles.forumHeaderArrow, { color: c.textMuted }]}>{isExpanded ? '▼' : '▶'}</Text>
            <Text style={[styles.forumTitle, { color: c.text }]}>{title}</Text>
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
    <SafeAreaView style={[styles.container, { backgroundColor: c.bg }]}>
      <ScrollView style={styles.scrollContent} showsVerticalScrollIndicator={false}>
        <Text style={[styles.title, { color: c.text }]}>Settings</Text>

        <View style={styles.section}>
          <Text style={[styles.sectionTitle, { color: c.textMuted }]}>Preferences</Text>
          <View style={[styles.preference, { borderBottomColor: c.border }]}>
            <Text style={[styles.preferenceLabel, { color: c.text }]}>Hide snippets on read items</Text>
            <Switch
              value={hideSnippet}
              onValueChange={handleToggleHideSnippet}
              disabled={loading}
            />
          </View>
          <View style={[styles.preferenceColumn, { borderTopColor: c.border }]}>
            <View style={styles.intervalLabelRow}>
              <Text style={[styles.preferenceLabel, { color: c.text }]}>Feed Refresh Interval</Text>
              <Text style={[styles.intervalValue, { color: c.tint }]}>{refreshInterval}m</Text>
            </View>
            <Slider
              style={styles.slider}
              minimumValue={1}
              maximumValue={120}
              step={1}
              value={refreshInterval}
              onValueChange={handleChangeRefreshInterval}
              disabled={loading}
              minimumTrackTintColor={c.tint}
              maximumTrackTintColor={c.border}
            />
          </View>
        </View>

        <View style={styles.section}>
          <TouchableOpacity
            style={styles.sectionHeader}
            onPress={() => setExpandedNotifications((v) => !v)}
          >
            <Text style={[styles.sectionTitle, { color: c.textMuted }]}>Notifications</Text>
            <Text style={[styles.sectionArrow, { color: c.textMuted }]}>{expandedNotifications ? '▼' : '▶'}</Text>
          </TouchableOpacity>
          {expandedNotifications && (
            <>
              <View style={[styles.preferenceColumn, { borderTopColor: c.border }]}>
                <Text style={[styles.preferenceLabelInline, { color: c.text, marginBottom: 8 }]}>Push notification tier</Text>
                <View style={styles.levelRow}>
                  {FILTER_TIERS.map((filter) => (
                    <TouchableOpacity
                      key={filter}
                      style={[styles.levelButton, { borderColor: c.tint }, pushFilter === filter && { backgroundColor: c.tint }]}
                      onPress={() => handlePushFilterChange(filter)}
                      disabled={loading}
                    >
                      <Text style={[styles.levelButtonText, { color: pushFilter === filter ? '#fff' : c.tint }]}>
                        {FILTER_TIER_INFO[filter].label}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </View>
                <Text style={[styles.levelHint, { color: c.textFaint }]}>
                  {FILTER_TIER_INFO[pushFilter].hint}
                </Text>
              </View>
              {pushFilter === 'length' && (
                <>
                  <View style={[styles.preferenceColumn, { borderTopColor: c.border }]}>
                    <View style={styles.intervalLabelRow}>
                      <Text style={[styles.preferenceLabelInline, { color: c.text }]}>Min content length</Text>
                      <Text style={[styles.intervalValue, { color: c.tint }]}>
                        {pushMinLength === 0 ? 'any' : `${pushMinLength} chars`}
                      </Text>
                    </View>
                    <Slider
                      style={styles.slider}
                      minimumValue={0}
                      maximumValue={500}
                      step={25}
                      value={pushMinLength}
                      onValueChange={(v) => handlePushMinLengthChange(Math.round(v))}
                      disabled={loading}
                      minimumTrackTintColor={c.tint}
                      maximumTrackTintColor={c.border}
                    />
                  </View>
                  <View style={[styles.authorFiltersContainer, { backgroundColor: c.surfaceAlt }]}>
                    <Text style={[styles.silencedTopicsLabel, { color: c.textMuted }]}>
                      Notify for authors{pushAuthors.length === 0 ? ' (all)' : ''}
                    </Text>
                    {pushAuthors.length === 0 && (
                      <Text style={[styles.emptyState, { color: c.textFaint }]}>All authors — add one to filter</Text>
                    )}
                    {pushAuthors.map((author) => (
                      <View key={author} style={[styles.silencedTopic, { backgroundColor: c.bg, borderColor: c.border }]}>
                        <Text style={[styles.silencedTopicName, { color: c.text }]}>{author}</Text>
                        <TouchableOpacity
                          style={[styles.resubscribeButton, { backgroundColor: c.resubscribeBg }]}
                          onPress={() => handlePushAuthorsChange(pushAuthors.filter((a) => a !== author))}
                        >
                          <Text style={[styles.resubscribeButtonText, { color: c.resubscribeText }]}>Remove</Text>
                        </TouchableOpacity>
                      </View>
                    ))}
                    <View style={styles.addAuthorRow}>
                      <TextInput
                        style={[styles.addAuthorInput, { color: c.text, borderColor: c.border, backgroundColor: c.bg }]}
                        value={newAuthor}
                        onChangeText={setNewAuthor}
                        placeholder="Add author name…"
                        placeholderTextColor={c.textFaint}
                        autoCapitalize="words"
                        autoCorrect={false}
                      />
                      <TouchableOpacity
                        style={[styles.addAuthorButton, { backgroundColor: c.tint }]}
                        onPress={() => {
                          const trimmed = newAuthor.trim();
                          if (trimmed && !pushAuthors.includes(trimmed)) {
                            handlePushAuthorsChange([...pushAuthors, trimmed]);
                          }
                          setNewAuthor('');
                        }}
                      >
                        <Text style={styles.addAuthorButtonText}>Add</Text>
                      </TouchableOpacity>
                    </View>
                  </View>
                </>
              )}
            </>
          )}
        </View>

        <Text style={[styles.sectionTitle, { color: c.textMuted }]}>Forums</Text>

        {renderForumSection('Members Forum', 'membersForum', membersForumSilenced)}
        {renderForumSection('Stock Insights', 'stockInsights', stockInsightsSilenced)}
        {renderForumSection('Options Insights', 'optionsInsights', optionsInsightsSilenced)}

        <TouchableOpacity style={styles.button} onPress={handleLogout}>
          <Text style={styles.buttonText}>Log Out</Text>
        </TouchableOpacity>

        <Text style={[styles.buildInfo, { color: c.textMuted }]}>
          v{Application.nativeApplicationVersion} ({Application.nativeBuildVersion})
        </Text>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  scrollContent: { flex: 1, paddingHorizontal: 24, paddingTop: 24, paddingBottom: 24 },
  title: { fontSize: 24, fontWeight: 'bold', marginBottom: 20 },
  section: { marginBottom: 20 },
  sectionTitle: { fontSize: 14, fontWeight: '600', color: '#888', marginBottom: 6, textTransform: 'uppercase' },
  preference: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: '#e0e0e0' },
  preferenceColumn: { paddingVertical: 8, borderTopWidth: 1, borderTopColor: '#e0e0e0' },
  preferenceLabel: { fontSize: 16, color: '#1a1a1a', marginBottom: 8 },
  preferenceLabelInline: { fontSize: 16, color: '#1a1a1a' },
  sectionHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 },
  sectionArrow: { fontSize: 12 },
  authorFiltersContainer: { borderRadius: 8, padding: 12, marginBottom: 4 },
  addAuthorRow: { flexDirection: 'row', gap: 8, marginTop: 8 },
  addAuthorInput: { flex: 1, borderWidth: 1, borderRadius: 6, paddingHorizontal: 10, paddingVertical: 6, fontSize: 14 },
  addAuthorButton: { borderRadius: 6, paddingHorizontal: 14, paddingVertical: 6, justifyContent: 'center' },
  addAuthorButtonText: { color: '#fff', fontSize: 14, fontWeight: '600' },
  forumSection: { marginBottom: 8, paddingBottom: 8, borderBottomWidth: 1, borderBottomColor: '#f0f0f0' },
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
  button: { backgroundColor: '#cc0000', borderRadius: 8, padding: 16, alignItems: 'center', marginTop: 24 },
  buttonText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  resubscribeButton: { paddingHorizontal: 10, paddingVertical: 6, backgroundColor: '#f0f0f0', borderRadius: 4 },
  resubscribeButtonText: { fontSize: 11, fontWeight: '600', color: '#0066cc' },
  intervalLabelRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 },
  intervalValue: { fontSize: 16, fontWeight: '600', color: '#0a7ea4' },
  slider: { width: '100%', height: 30 },
  levelRow: { flexDirection: 'row', gap: 8, marginBottom: 6 },
  levelButton: { flex: 1, borderWidth: 1, borderRadius: 6, paddingVertical: 6, alignItems: 'center' },
  levelButtonText: { fontSize: 13, fontWeight: '600' },
  levelHint: { fontSize: 12, fontStyle: 'italic' },
  buildInfo: { fontSize: 12, textAlign: 'center', marginTop: 16, marginBottom: 8 },
});
