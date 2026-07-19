import { useEffect } from 'react';
import { useRouter } from 'expo-router';
import { FeedKeys } from '@li/core';
import { getLastOpenedTab, getForumVisibility } from '../../services/storageService';
import { FeedKey, FEEDS } from '../../services/feedService';
import { getAllScopes, viewScope } from '../../services/readStateService';
import { getTopicsForForum } from '../../services/topicService';
import { getAllTopicSubscriptions } from '../../services/subscriptionService';

// Preference order — Members Area last since users rarely want it first
const PREFERRED: FeedKey[] = [FeedKeys.membersForum, FeedKeys.stockInsights, FeedKeys.optionsInsights, FeedKeys.membersArea];

const TAB_PATH = Object.fromEntries(
  (Object.keys(FEEDS) as FeedKey[]).map((k) => [k, `/(tabs)/${FEEDS[k].route}`])
) as Record<FeedKey, string>;

export default function TabsIndex() {
  const router = useRouter();

  useEffect(() => {
    (async () => {
      // Reads directly from storage: the landing-tab decision must be knowable immediately from
      // what's already persisted, independent of FeedProvider's own async fetch cycle.
      const [lastTab, visibility, scopes, subs] = await Promise.all([
        getLastOpenedTab(),
        getForumVisibility(),
        getAllScopes(),
        getAllTopicSubscriptions(),
      ]);

      const visible = PREFERRED.filter((k) => {
        if (k === FeedKeys.stockInsights) return visibility.stockInsights;
        if (k === FeedKeys.optionsInsights) return visibility.optionsInsights;
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
        target = FeedKeys.membersForum;                           // nothing unread, no valid last tab
      }

      router.replace(TAB_PATH[target] as any);
    })();
  }, [router]);

  return null;
}
