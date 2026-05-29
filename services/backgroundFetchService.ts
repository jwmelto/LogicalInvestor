import * as BackgroundFetch from 'expo-background-fetch';
import * as TaskManager from 'expo-task-manager';
import { fetchAllFeeds } from './feedService';
import { isAuthenticated } from './authService';
import { getUnreadCount } from './readStateService';
import { getCachedUnreadCounts, setCachedUnreadCounts } from './storageService';

export const BACKGROUND_FETCH_TASK = 'background-feed-refresh';

// Must be defined at module load time (before any component mounts)
TaskManager.defineTask(BACKGROUND_FETCH_TASK, async () => {
  try {
    const authed = await isAuthenticated();
    if (!authed) return BackgroundFetch.BackgroundFetchResult.NoData;

    const results = await fetchAllFeeds();

    // Compute unread counts and persist so all tabs have correct badges on next foreground
    const existing = await getCachedUnreadCounts();
    const updated = { ...existing };
    for (const result of results) {
      if (result.accessible) {
        updated[result.feedKey] = await getUnreadCount(result.items.map((i) => i.id));
      }
    }
    await setCachedUnreadCounts(updated);

    return BackgroundFetch.BackgroundFetchResult.NewData;
  } catch {
    return BackgroundFetch.BackgroundFetchResult.Failed;
  }
});

export async function registerBackgroundFetch(): Promise<void> {
  try {
    const status = await BackgroundFetch.getStatusAsync();
    if (
      status === BackgroundFetch.BackgroundFetchStatus.Restricted ||
      status === BackgroundFetch.BackgroundFetchStatus.Denied
    ) {
      return;
    }

    const isRegistered = await TaskManager.isTaskRegisteredAsync(BACKGROUND_FETCH_TASK);
    if (!isRegistered) {
      await BackgroundFetch.registerTaskAsync(BACKGROUND_FETCH_TASK, {
        minimumInterval: 15 * 60, // 15 minutes (iOS may run it less frequently)
        stopOnTerminate: false,
        startOnBoot: true,
      });
    }
  } catch {
    // Background fetch not available on this platform/simulator — silently ignore
  }
}
