import * as BackgroundTask from 'expo-background-task';
import * as SecureStore from 'expo-secure-store';
import * as TaskManager from 'expo-task-manager';
import { Platform } from 'react-native';
import { get, loadSession } from './api';
import { loadApiUrl } from './config';
import { showLiveNotification } from './push';

/**
 * Notifications while the app is closed, without a push service: Android wakes the app about every 15 minutes
 * (the shortest interval it allows; the phone may stretch it to save battery) and new unread notifications are
 * shown in the notification bar with sound. Instant delivery to a closed app needs Firebase push.
 */

const TASK = 'kx-notifications-check';
const LAST = 'kx.notify.last';

async function lastShown() {
  try {
    return await SecureStore.getItemAsync(LAST);
  } catch {
    return null;
  }
}

/** Remembers the newest notification already shown, so none is shown twice. */
export async function markShown(createdAt: string) {
  try {
    const last = await lastShown();
    if (!last || createdAt > last) await SecureStore.setItemAsync(LAST, createdAt);
  } catch {
    /* best effort */
  }
}

export async function checkForNotifications() {
  await loadApiUrl();
  if (!(await loadSession())) return;
  const { items } = await get<{ items: { id: string; title: string; body: string; data?: Record<string, unknown>; created_at: string }[] }>(
    '/notifications?unread=true&pageSize=10',
  );
  const last = await lastShown();
  // On the first run only the newest is shown, not the whole backlog.
  const fresh = items.filter((n) => (last ? n.created_at > last : n === items[0])).reverse();
  for (const n of fresh) showLiveNotification(n);
  if (items[0]) await markShown(items[0].created_at);
}

if (Platform.OS !== 'web') {
  TaskManager.defineTask(TASK, async () => {
    try {
      await checkForNotifications();
      return BackgroundTask.BackgroundTaskResult.Success;
    } catch {
      return BackgroundTask.BackgroundTaskResult.Failed;
    }
  });
}

export async function startBackgroundCheck() {
  if (Platform.OS === 'web') return;
  try {
    if ((await BackgroundTask.getStatusAsync()) !== BackgroundTask.BackgroundTaskStatus.Available) return;
    if (!(await TaskManager.isTaskRegisteredAsync(TASK))) await BackgroundTask.registerTaskAsync(TASK, { minimumInterval: 15 });
  } catch {
    /* not available on this device */
  }
}

export async function stopBackgroundCheck() {
  if (Platform.OS === 'web') return;
  try {
    if (await TaskManager.isTaskRegisteredAsync(TASK)) await BackgroundTask.unregisterTaskAsync(TASK);
  } catch {
    /* already stopped */
  }
}
