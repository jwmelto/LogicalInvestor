import React, { createContext, useContext, useState, useCallback, useEffect, useRef } from 'react';
import { AppState, AppStateStatus } from 'react-native';
import * as Notifications from 'expo-notifications';
import { FeedKey } from '../services/feedService';
import { getCachedUnreadCounts, getRefreshInterval } from '../services/storageService';

type UnreadCounts = Partial<Record<FeedKey, number>>;

interface UnreadCountContextType {
  counts: UnreadCounts;
  setFeedUnreadCount: (feedKey: FeedKey, count: number) => void;
  refreshSignal: number;
  notifyManualRefresh: () => void;
}

const UnreadCountContext = createContext<UnreadCountContextType | undefined>(undefined);

// Short delay on foreground return before refreshing, to let any in-flight
// markRead storage writes complete before we re-fetch and recompute counts.
const FOREGROUND_REFRESH_DELAY_MS = 1500;

export function UnreadCountProvider({ children }: { children: React.ReactNode }) {
  const [counts, setCounts] = useState<UnreadCounts>({});
  const [refreshSignal, setRefreshSignal] = useState(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const foregroundDelayRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const appStateRef = useRef<AppStateStatus>(AppState.currentState);
  const lastRefreshAtRef = useRef<number>(Date.now());

  // Seed badges from storage immediately so all tabs show counts before they load
  useEffect(() => {
    getCachedUnreadCounts().then((stored) => {
      setCounts((prev) => ({ ...(stored as UnreadCounts), ...prev }));
    });
  }, []);

  function fireRefresh() {
    lastRefreshAtRef.current = Date.now();
    setRefreshSignal((n) => n + 1);
  }

  function startTimer(intervalMs: number) {
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = setInterval(() => {
      fireRefresh();
    }, intervalMs);
  }

  useEffect(() => {
    getRefreshInterval().then((minutes) => startTimer(minutes * 60 * 1000));

    const sub = AppState.addEventListener('change', (next: AppStateStatus) => {
      const prev = appStateRef.current;
      appStateRef.current = next;

      if (next === 'active' && prev !== 'active') {
        // Cancel any pending foreground delay from a previous transition
        if (foregroundDelayRef.current) clearTimeout(foregroundDelayRef.current);

        getRefreshInterval().then((minutes) => {
          const intervalMs = minutes * 60 * 1000;
          const elapsed = Date.now() - lastRefreshAtRef.current;
          const remaining = intervalMs - elapsed;

          if (remaining <= 0) {
            // Overdue — fire after a short delay to let markRead writes settle
            foregroundDelayRef.current = setTimeout(fireRefresh, FOREGROUND_REFRESH_DELAY_MS);
            startTimer(intervalMs);
          } else {
            // Not yet due — resume the timer with the time left, then switch to
            // full interval so subsequent ticks are evenly spaced
            if (timerRef.current) clearInterval(timerRef.current);
            timerRef.current = setTimeout(() => {
              fireRefresh();
              startTimer(intervalMs);
            }, remaining);
          }
        });
      } else if (next !== 'active') {
        // Going to background — pause both timers
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
  }, []);

  const setFeedUnreadCount = useCallback((feedKey: FeedKey, count: number) => {
    setCounts((prev) => {
      const updated = { ...prev, [feedKey]: count };
      const hasAnyUnread = Object.values(updated).some((n) => (n ?? 0) > 0);
      Notifications.setBadgeCountAsync(hasAnyUnread ? 1 : 0).catch(() => {});
      return updated;
    });
  }, []);

  // Call this on manual pull-to-refresh so the timer resets from now,
  // avoiding a redundant auto-refresh shortly after the user just refreshed.
  const notifyManualRefresh = useCallback(() => {
    lastRefreshAtRef.current = Date.now();
    getRefreshInterval().then((minutes) => startTimer(minutes * 60 * 1000));
  }, []);

  return (
    <UnreadCountContext.Provider value={{ counts, setFeedUnreadCount, refreshSignal, notifyManualRefresh }}>
      {children}
    </UnreadCountContext.Provider>
  );
}

export function useUnreadCounts() {
  const context = useContext(UnreadCountContext);
  if (!context) throw new Error('useUnreadCounts must be used within UnreadCountProvider');
  return context;
}
