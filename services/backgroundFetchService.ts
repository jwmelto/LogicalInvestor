import * as BackgroundTask from 'expo-background-task';
import * as TaskManager from 'expo-task-manager';
import { fetchAllFeeds } from './feedService';
import { isAuthenticated } from './authService';
import { computeFeedUnreadCounts } from './readStateService';
import { getCachedUnreadCounts, setCachedUnreadCounts } from './storageService';

export const BACKGROUND_FETCH_TASK = 'background-feed-refresh';

// Must be defined at module load time (before any component mounts)
TaskManager.defineTask(BACKGROUND_FETCH_TASK, async () => {
  try {
    const authed = await isAuthenticated();
    if (!authed) return BackgroundTask.BackgroundTaskResult.Success;

    const results = await fetchAllFeeds();

    // Compute unread counts and persist so all tabs have correct badges on next foreground
    const existing = await getCachedUnreadCounts();
    const computed = await computeFeedUnreadCounts(results);
    await setCachedUnreadCounts({ ...existing, ...computed });

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
