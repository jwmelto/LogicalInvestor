import { useEffect } from 'react';
import { useRouter } from 'expo-router';
import { getLastOpenedTab, getForumVisibility } from '../../services/storageService';
import { FeedKey, FEEDS } from '../../services/feedService';
import { getAllScopes, viewScope } from '../../services/readStateService';
import { getTopicsForForum } from '../../services/topicService';
import { getAllTopicSubscriptions } from '../../services/subscriptionService';

// Preference order — Members Area last since users rarely want it first
const PREFERRED: FeedKey[] = ['membersForum', 'stockInsights', 'optionsInsights', 'membersArea'];

const TAB_PATH = Object.fromEntries(
  (Object.keys(FEEDS) as FeedKey[]).map((k) => [k, `/(tabs)/${FEEDS[k].route}`])
) as Record<FeedKey, string>;

export default function TabsIndex() {
  const router = useRouter();

  useEffect(() => {
    (async () => {
      // Read directly from storage rather than via FeedContext — this decision needs to happen
      // before (and independent of) FeedProvider's own async fetch cycle, same as the previous
      // cached-snapshot approach this replaces.
      const [lastTab, visibility, scopes, subs] = await Promise.all([
        getLastOpenedTab(),
        getForumVisibility(),
        getAllScopes(),
        getAllTopicSubscriptions(),
      ]);

      const visible = PREFERRED.filter((k) => {
        if (k === 'stockInsights') return visibility.stockInsights;
        if (k === 'optionsInsights') return visibility.optionsInsights;
        return true;
      });

      const forumHasUnread = async (k: FeedKey): Promise<boolean> => {
        if (!FEEDS[k].hasSubFeeds) return viewScope(scopes[k] ?? {}).hasUnread;
        const topics = await getTopicsForForum(k);
        return topics.some((t) => (subs[t.id] ?? true) && viewScope(scopes[t.id] ?? {}).hasUnread);
      };

      const unreadFlags = await Promise.all(visible.map((k) => forumHasUnread(k)));
      const unreadTabs = visible.filter((_, i) => unreadFlags[i]);

      let target: FeedKey;
      if (lastTab && unreadTabs.includes(lastTab as FeedKey)) {
        target = lastTab as FeedKey;                              // last visited has unread
      } else if (unreadTabs.length > 0) {
        target = unreadTabs[0];                                   // any unread tab
      } else if (lastTab && visible.includes(lastTab as FeedKey)) {
        target = lastTab as FeedKey;                              // last visited, nothing unread
      } else {
        target = 'membersForum';                                  // nothing unread, no valid last tab
      }

      router.replace(TAB_PATH[target] as any);
    })();
  }, [router]);

  return null;
}
