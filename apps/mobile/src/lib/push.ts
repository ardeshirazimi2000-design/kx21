import Constants from 'expo-constants';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import { post } from './api';

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: true,
  }),
});

/** Asks for permission and registers this device's Expo push token with the API. */
export async function registerForPush(): Promise<void> {
  if (!Device.isDevice || Platform.OS === 'web') return;
  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync('default', {
      name: 'اعلان‌های جلسات',
      importance: Notifications.AndroidImportance.HIGH,
      sound: 'default',
      enableVibrate: true,
      vibrationPattern: [0, 250, 150, 250],
      lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
    });
  }
  const current = await Notifications.getPermissionsAsync();
  const status = current.granted ? current : await Notifications.requestPermissionsAsync();
  if (!status.granted) return;
  const projectId = Constants.expoConfig?.extra?.eas?.projectId ?? Constants.easConfig?.projectId;
  try {
    const token = await Notifications.getExpoPushTokenAsync(projectId ? { projectId } : undefined);
    await post('/auth/devices', { pushToken: token.data, platform: Platform.OS === 'ios' ? 'ios' : 'android' });
  } catch {
    // Push is optional: without an EAS projectId (e.g. local development) the app keeps working with in-app/socket notifications.
  }
}

/**
 * Shows every new notification of the logged-in user in the phone's notification bar while the app
 * is running (foreground or background), using the live connection. This works without any push
 * service; notifications to a closed app additionally need Expo/Firebase push (see docs/10-mobile-build.md).
 */
export function showLiveNotification(n: { id: string; title: string; body: string; data?: Record<string, unknown> }) {
  if (Platform.OS === 'web') return;
  void Notifications.scheduleNotificationAsync({
    identifier: n.id,
    content: { title: n.title, body: n.body, data: n.data ?? {}, sound: 'default' },
    trigger: Platform.OS === 'android' ? { channelId: 'default' } : null,
  }).catch(() => {});
}

/** Screen to open when a notification is tapped. */
export function routeForNotification(data: Record<string, unknown> | undefined): string | null {
  if (!data) return null;
  if (typeof data.meetingId === 'string') return `/meeting/${data.meetingId}`;
  // Network news concerns other chambers' resolutions; the network pages are on the web.
  if (typeof data.networkId === 'string') return '/notifications';
  if (typeof data.resolutionId === 'string') return `/resolution/${data.resolutionId}`;
  return '/notifications';
}

/** Unread count of the notifications tab: refreshed when a notification arrives or is read. */
const unreadListeners = new Set<() => void>();
export function onUnreadChanged(l: () => void) {
  unreadListeners.add(l);
  return () => {
    unreadListeners.delete(l);
  };
}
export function notifyUnreadChanged() {
  unreadListeners.forEach((l) => l());
}
