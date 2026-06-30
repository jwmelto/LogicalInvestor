import { useEffect } from 'react';
import { useRouter } from 'expo-router';
import { getCachedUnreadCounts, getLastOpenedTab, getForumVisibility } from '../../services/storageService';
import { FeedKey, FEEDS } from '../../services/feedService';

// Preference order — Members Area last since users rarely want it first
const PREFERRED: FeedKey[] = ['membersForum', 'stockInsights', 'optionsInsights', 'membersArea'];

const TAB_PATH = Object.fromEntries(
  (Object.keys(FEEDS) as FeedKey[]).map((k) => [k, `/(tabs)/${FEEDS[k].route}`])
) as Record<FeedKey, string>;

export default function TabsIndex() {
  const router = useRouter();

  useEffect(() => {
    Promise.all([getCachedUnreadCounts(), getLastOpenedTab(), getForumVisibility()]).then(
      ([counts, lastTab, visibility]) => {
        const visible = PREFERRED.filter((k) => {
          if (k === 'stockInsights') return visibility.stockInsights;
          if (k === 'optionsInsights') return visibility.optionsInsights;
          return true;
        });

        const unread = visible.filter((k) => (counts[k] ?? 0) > 0);

        let target: FeedKey;
        if (lastTab && unread.includes(lastTab as FeedKey)) {
          target = lastTab as FeedKey;                              // last visited has unread
        } else if (unread.length > 0) {
          target = unread[0];                                       // any unread tab
        } else if (lastTab && visible.includes(lastTab as FeedKey)) {
          target = lastTab as FeedKey;                              // last visited, nothing unread
        } else {
          target = 'membersArea';                                   // fallback: flat feed, no topic discovery
        }

        router.replace(TAB_PATH[target] as any);
      }
    );
  }, []);

  return null;
}
