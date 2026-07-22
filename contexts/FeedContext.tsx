import React, { createContext, useContext, useState, useCallback, useEffect, useRef } from 'react';
import { AppState, AppStateStatus } from 'react-native';
import * as Notifications from 'expo-notifications';
import { FeedKeys, FEEDKEY_TO_CHANNEL, type Channel } from '@li/core';
import { FeedKey, FeedResult, FEEDS, fetchSingleFeed } from '../services/feedService';
import { cleanupObsoleteStorage, getForumVisibility, getRefreshInterval } from '../services/storageService';
import { registerPushChannel } from '../services/pushService';
import { getToken } from '../services/authService';
import { getAllScopes, viewScope, markFlatFeedSeen, hasUnread, detectForumUnread, topicUnreadForForum } from '../services/readStateService';
import { getAllTopicSubscriptions } from '../services/subscriptionService';
import { useAuth } from './AuthContext';

type UnreadFlags = Partial<Record<FeedKey, boolean>>;
type TopicUnreadFlags = Partial<Record<FeedKey, Record<string, boolean>>>;
export type FeedResults = Partial<Record<FeedKey, FeedResult>>;

interface FeedContextType {
  feedResults: FeedResults;
  unread: UnreadFlags;
  topicUnread: TopicUnreadFlags;
  refreshScopeUnread: (feedKey: FeedKey, scopeId: string) => Promise<void>;
  triggerRefresh: () => void;
}

const FeedContext = createContext<FeedContextType | undefined>(undefined);

// Short delay on foreground return before refreshing, to let any in-flight
// markRead storage writes complete before we re-fetch and recompute badges.
const FOREGROUND_REFRESH_DELAY_MS = 1500;

// Only checks item count — feedService's fetchFeed() only ever returns accessible:false
// alongside items:[], so accessible can't independently change this result.
function isSubscribed(result: FeedResult | undefined): boolean {
  return (result?.items.length ?? 0) > 0;
}

export function FeedProvider({ children }: { children: React.ReactNode }) {
  const { authed } = useAuth();
  const [feedResults, setFeedResults] = useState<FeedResults>({});
  const [unread, setUnread] = useState<UnreadFlags>({});
  const [topicUnread, setTopicUnread] = useState<TopicUnreadFlags>({});
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const foregroundDelayRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const appStateRef = useRef<AppStateStatus>(AppState.currentState);
  const lastRefreshAtRef = useRef<number>(Date.now());
  // membersArea and membersForum both map to the 'members' channel (FEEDKEY_TO_CHANNEL) — dedupe
  // by Channel so a shared channel isn't registered twice.
  const pushRegisteredRef = useRef<Set<Channel>>(new Set());

  const setFeedUnread = useCallback((feedKey: FeedKey, hasUnreadFlag: boolean) => {
    setUnread((prev) => {
      const updated = { ...prev, [feedKey]: hasUnreadFlag };
      const hasAnyUnread = Object.values(updated).some(Boolean);
      Notifications.setBadgeCountAsync(hasAnyUnread ? 1 : 0).catch(() => {});
      return updated;
    });
  }, []);

  // Cold-start seed: entirely local, no network, so badges are correct before the first fetch
  // even lands. One cleanup sweep, one getAllScopes() read, one getAllTopicSubscriptions() read
  // for the whole app — never per-topic storage reads.
  useEffect(() => {
    (async () => {
      await cleanupObsoleteStorage();
      const scopes = await getAllScopes();
      setFeedUnread(FeedKeys.membersArea, viewScope(scopes[FeedKeys.membersArea] ?? {}).hasUnread);

      const subs = await getAllTopicSubscriptions();

      for (const k of Object.keys(FEEDS) as FeedKey[]) {
        if (!FEEDS[k].hasSubFeeds) continue;
        const forumMap = topicUnreadForForum(k, scopes, subs);
        setTopicUnread((prev) => ({ ...prev, [k]: forumMap }));
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep each topic-based forum's own badge in sync with its topics' aggregate state, whenever
  // that state changes for any reason (cold-start seed above, a fetch's detection pass below, or
  // a single topic's post-read-marking refresh via refreshScopeUnread).
  useEffect(() => {
    (Object.keys(FEEDS) as FeedKey[]).forEach((k) => {
      if (!FEEDS[k].hasSubFeeds) return;
      const forumMap = topicUnread[k];
      if (!forumMap) return;
      setFeedUnread(k, Object.values(forumMap).some(Boolean));
    });
  }, [topicUnread, setFeedUnread]);

  async function fetchAllFeeds() {
    const keys = Object.keys(FEEDS) as FeedKey[];
    const results = await Promise.all(keys.map((k) => fetchSingleFeed(k)));
    const next: FeedResults = {};
    keys.forEach((k, i) => { next[k] = results[i]; });
    setFeedResults(next);

    // The fetch above always runs for every feed, so a re-enabled forum's data is already fresh
    // the moment the user flips it back on — only the detection work below (which, for topic
    // forums, can mean a real bounded deep-dive fetch) is worth skipping for a hidden tab, since
    // nothing renders its badge while it's hidden.
    const visibility = await getForumVisibility();

    // Each feed's detection runs independently and concurrently — a slow forum's bounded
    // deep-dive fallback shouldn't delay another forum's (or the flat feed's) badge update.
    await Promise.all(keys.map(async (k) => {
      if (!FEEDS[k].isVisible(visibility)) return;
      const result = next[k]!;
      if (!isSubscribed(result)) { setFeedUnread(k, false); return; }

      if (!FEEDS[k].hasSubFeeds) {
        await markFlatFeedSeen(k, result.items);
        setFeedUnread(k, await hasUnread(k));
        return;
      }

      const updates = await detectForumUnread(k, result.items);
      if (Object.keys(updates).length === 0) return;
      setTopicUnread((prev) => ({ ...prev, [k]: { ...(prev[k] ?? {}), ...updates } }));
    }));

    const feedToken = await getToken();
    if (feedToken) {
      for (const k of keys) {
        if (!FEEDS[k].isVisible(visibility)) continue;
        const channel = FEEDKEY_TO_CHANNEL[k];
        if (isSubscribed(next[k]) && !pushRegisteredRef.current.has(channel)) {
          // Only mark registered once the server confirms — an unconfirmed
          // channel is retried on the next refresh instead of silently stuck.
          if (await registerPushChannel(k, feedToken)) {
            pushRegisteredRef.current.add(channel);
          }
        }
      }
    }
  }

  function fireRefresh() {
    lastRefreshAtRef.current = Date.now();
    fetchAllFeeds();
  }

  function startTimer(intervalMs: number) {
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = setInterval(fireRefresh, intervalMs);
  }

  useEffect(() => {
    if (!authed) {
      // Logged out — old channels were registered under the prior feed token,
      // so re-login must re-register rather than skip via stale ref state.
      pushRegisteredRef.current.clear();
      return;
    }
    fetchAllFeeds();
    getRefreshInterval().then((minutes) => startTimer(minutes * 60 * 1000));

    const sub = AppState.addEventListener('change', (next: AppStateStatus) => {
      const prev = appStateRef.current;
      appStateRef.current = next;

      if (next === 'active' && prev !== 'active') {
        if (foregroundDelayRef.current) clearTimeout(foregroundDelayRef.current);

        getRefreshInterval().then((minutes) => {
          const intervalMs = minutes * 60 * 1000;
          const elapsed = Date.now() - lastRefreshAtRef.current;
          const remaining = intervalMs - elapsed;

          if (remaining <= 0) {
            foregroundDelayRef.current = setTimeout(fireRefresh, FOREGROUND_REFRESH_DELAY_MS);
            startTimer(intervalMs);
          } else {
            if (timerRef.current) clearInterval(timerRef.current);
            timerRef.current = setTimeout(() => {
              fireRefresh();
              startTimer(intervalMs);
            }, remaining);
          }
        });
      } else if (next !== 'active') {
        if (timerRef.current) {
          clearInterval(timerRef.current);
          timerRef.current = null;
        }
        if (foregroundDelayRef.current) {
          clearTimeout(foregroundDelayRef.current);
          foregroundDelayRef.current = null;
        }
      }
    });

    return () => {
      sub.remove();
      if (timerRef.current) clearInterval(timerRef.current);
      if (foregroundDelayRef.current) clearTimeout(foregroundDelayRef.current);
    };
  }, [authed]);

  // Called after ForumFeed marks something read: re-derives hasUnread for that one scope via a
  // cheap local storage lookup, and updates the relevant slice of state. The topicUnread effect
  // above then re-derives the forum's own aggregate flag.
  const refreshScopeUnread = useCallback(async (feedKey: FeedKey, scopeId: string) => {
    const result = await hasUnread(scopeId);
    if (scopeId === feedKey) {
      setFeedUnread(feedKey, result);
      return;
    }
    setTopicUnread((prev) => ({
      ...prev,
      [feedKey]: { ...(prev[feedKey] ?? {}), [scopeId]: result },
    }));
  }, [setFeedUnread]);

  // Called by pull-to-refresh: re-fetches all feeds and resets the timer
  const triggerRefresh = useCallback(() => {
    lastRefreshAtRef.current = Date.now();
    getRefreshInterval().then((minutes) => startTimer(minutes * 60 * 1000));
    fetchAllFeeds();
  }, []);

  return (
    <FeedContext.Provider value={{ feedResults, unread, topicUnread, refreshScopeUnread, triggerRefresh }}>
      {children}
    </FeedContext.Provider>
  );
}

export function useFeed() {
  const context = useContext(FeedContext);
  if (!context) throw new Error('useFeed must be used within FeedProvider');
  return context;
}
