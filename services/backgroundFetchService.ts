import * as BackgroundTask from 'expo-background-task';
import * as TaskManager from 'expo-task-manager';
import { fetchAllFeeds, FEEDS } from './feedService';
import { isAuthenticated } from './authService';
import { getUnreadCount } from './readStateService';
import { getCachedUnreadCounts, setCachedUnreadCounts } from './storageService';
import { processNewItemsForNotifications } from './notificationService';
import { getTopicsForForum, extractTopicFromTitle } from './topicService';
import { isTopicSubscribed } from './subscriptionService';

export const BACKGROUND_FETCH_TASK = 'background-feed-refresh';

// Must be defined at module load time (before any component mounts)
TaskManager.defineTask(BACKGROUND_FETCH_TASK, async () => {
  try {
    const authed = await isAuthenticated();
    if (!authed) return BackgroundTask.BackgroundTaskResult.Success;

    const results = await fetchAllFeeds();

    const allItems = results.flatMap((r) => (r.accessible ? r.items : []));
    await processNewItemsForNotifications(allItems);

    // Compute unread counts and persist so all tabs have correct badges on next foreground
    const existing = await getCachedUnreadCounts();
    const updated = { ...existing };
    for (const result of results) {
      if (!result.accessible) continue;
      if (FEEDS[result.feedKey].hasSubFeeds) {
        // Match ForumFeed's topic-based counting so the badge agrees with what the user sees
        const topics = await getTopicsForForum(result.feedKey);
        let total = 0;
        for (const topic of topics) {
          if (!await isTopicSubscribed(topic.id, result.feedKey)) continue;
          const topicItems = result.items.filter(
            (item) => extractTopicFromTitle(item.title) === topic.name
          );
          total += await getUnreadCount(topicItems.map((i) => i.id));
        }
        updated[result.feedKey] = total;
      } else {
        updated[result.feedKey] = await getUnreadCount(result.items.map((i) => i.id));
      }
    }
    await setCachedUnreadCounts(updated);

    return BackgroundTask.BackgroundTaskResult.Success;
  } catch {
    return BackgroundTask.BackgroundTaskResult.Failed;
  }
});

export async function registerBackgroundFetch(): Promise<void> {
  try {
    const status = await BackgroundTask.getStatusAsync();
    if (status === BackgroundTask.BackgroundTaskStatus.Restricted) {
      return;
    }

    const isRegistered = await TaskManager.isTaskRegisteredAsync(BACKGROUND_FETCH_TASK);
    if (!isRegistered) {
      await BackgroundTask.registerTaskAsync(BACKGROUND_FETCH_TASK, {
        minimumInterval: 15, // minutes
      });
    }
  } catch {
    // Background tasks not available on this platform/simulator — silently ignore
  }
}
