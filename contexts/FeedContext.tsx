import React, { createContext, useContext, useState, useCallback, useEffect, useRef } from 'react';
import { AppState, AppStateStatus } from 'react-native';
import * as Notifications from 'expo-notifications';
import { FeedKey, FeedResult, FEEDS, fetchSingleFeed } from '../services/feedService';
import { getCachedUnreadCounts, getRefreshInterval } from '../services/storageService';
import { registerPushChannel } from '../services/pushService';
import { getToken } from '../services/authService';
import { useAuth } from './AuthContext';

type UnreadCounts = Partial<Record<FeedKey, number>>;
export type FeedResults = Partial<Record<FeedKey, FeedResult>>;

interface FeedContextType {
  feedResults: FeedResults;
  counts: UnreadCounts;
  setFeedUnreadCount: (feedKey: FeedKey, count: number) => void;
  triggerRefresh: () => void;
}

const FeedContext = createContext<FeedContextType | undefined>(undefined);

// Short delay on foreground return before refreshing, to let any in-flight
// markRead storage writes complete before we re-fetch and recompute counts.
const FOREGROUND_REFRESH_DELAY_MS = 1500;

export function FeedProvider({ children }: { children: React.ReactNode }) {
  const { authed } = useAuth();
  const [feedResults, setFeedResults] = useState<FeedResults>({});
  const [counts, setCounts] = useState<UnreadCounts>({});
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const foregroundDelayRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const appStateRef = useRef<AppStateStatus>(AppState.currentState);
  const lastRefreshAtRef = useRef<number>(Date.now());
  const pushRegisteredRef = useRef<Set<FeedKey>>(new Set());

  // Seed badges from storage immediately so all tabs show counts before they load
  useEffect(() => {
    getCachedUnreadCounts().then((stored) => {
      setCounts((prev) => ({ ...(stored as UnreadCounts), ...prev }));
    });
  }, []);

  async function fetchAllFeeds() {
    const keys = Object.keys(FEEDS) as FeedKey[];
    const results = await Promise.all(keys.map((k) => fetchSingleFeed(k)));
    const next: FeedResults = {};
    keys.forEach((k, i) => { next[k] = results[i]; });
    setFeedResults(next);

    const feedToken = await getToken();
    if (feedToken) {
      for (const k of keys) {
        // Optional feeds (Stock/Options Insights) return accessible:true with 0 items
        // when the user isn't subscribed — require actual items too, so we don't
        // register push for a forum the user can't read.
        if (next[k]?.accessible && (next[k]?.items.length ?? 0) > 0 && !pushRegisteredRef.current.has(k)) {
          pushRegisteredRef.current.add(k);
          registerPushChannel(k, feedToken);
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
    if (!authed) return;
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

  const setFeedUnreadCount = useCallback((feedKey: FeedKey, count: number) => {
    setCounts((prev) => {
      const updated = { ...prev, [feedKey]: count };
      const hasAnyUnread = Object.values(updated).some((n) => (n ?? 0) > 0);
      Notifications.setBadgeCountAsync(hasAnyUnread ? 1 : 0).catch(() => {});
      return updated;
    });
  }, []);

  // Called by pull-to-refresh: re-fetches all feeds and resets the timer
  const triggerRefresh = useCallback(() => {
    lastRefreshAtRef.current = Date.now();
    getRefreshInterval().then((minutes) => startTimer(minutes * 60 * 1000));
    fetchAllFeeds();
  }, []);

  return (
    <FeedContext.Provider value={{ feedResults, counts, setFeedUnreadCount, triggerRefresh }}>
      {children}
    </FeedContext.Provider>
  );
}

export function useFeed() {
  const context = useContext(FeedContext);
  if (!context) throw new Error('useFeed must be used within FeedProvider');
  return context;
}
