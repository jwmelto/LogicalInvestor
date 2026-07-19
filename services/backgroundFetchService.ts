import * as BackgroundTask from 'expo-background-task';
import * as TaskManager from 'expo-task-manager';
import { fetchAllFeeds, FEEDS } from './feedService';
import { isAuthenticated } from './authService';
import { getForumVisibility } from './storageService';
import { markFlatFeedSeen, detectForumUnread } from './readStateService';

export const BACKGROUND_FETCH_TASK = 'background-feed-refresh';

// Must be defined at module load time (before any component mounts)
TaskManager.defineTask(BACKGROUND_FETCH_TASK, async () => {
  try {
    const authed = await isAuthenticated();
    if (!authed) return BackgroundTask.BackgroundTaskResult.Success;

    const results = await fetchAllFeeds();
    const visibility = await getForumVisibility();

    // Best-effort supplement only — this task is not load-bearing (expo-background-task's
    // 15-minute minimum is non-deterministic on iOS). Writes straight to the scope_guids store
    // that detectForumUnread/markFlatFeedSeen already own; the next foreground open's cold-start
    // seed (FeedContext.tsx) reads it directly, so there's no separate badge snapshot to compute
    // or cache here. Hidden forums are skipped — no point spending a bounded deep-dive fetch on a
    // tab nobody can currently see.
    await Promise.all(results.map(async (result) => {
      if (!result.accessible) return;
      if (!FEEDS[result.feedKey].isVisible(visibility)) return;
      if (FEEDS[result.feedKey].hasSubFeeds) {
        await detectForumUnread(result.feedKey, result.items);
      } else {
        await markFlatFeedSeen(result.feedKey, result.items);
      }
    }));

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
