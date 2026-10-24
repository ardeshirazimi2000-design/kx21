import * as Notifications from 'expo-notifications';
import { router } from 'expo-router';
import { useEffect } from 'react';
import { SOCKET_EVENTS } from '@kx/shared';
import { useAuth } from '../lib/auth';
import { markShown, startBackgroundCheck, stopBackgroundCheck } from '../lib/backgroundCheck';
import { notifyUnreadChanged, routeForNotification, showLiveNotification } from '../lib/push';
import { getSocket } from '../lib/socket';

/** Live notifications in the phone's notification bar, and opening the right screen when tapped. */
export function NotificationBridge() {
  const { me } = useAuth();
  // While logged in, the phone also checks for new notifications when the app is closed.
  useEffect(() => {
    if (me) void startBackgroundCheck();
    else void stopBackgroundCheck();
  }, [me?.id]);
  useEffect(() => {
    if (!me) return;
    const s = getSocket();
    if (!s) return;
    const onNotification = (n: any) => {
      showLiveNotification(n);
      if (n.createdAt) void markShown(n.createdAt);
      notifyUnreadChanged();
    };
    s.on(SOCKET_EVENTS.notification, onNotification);
    return () => {
      s.off(SOCKET_EVENTS.notification, onNotification);
    };
  }, [me?.id]);
  useEffect(() => {
    const sub = Notifications.addNotificationResponseReceivedListener((r) => {
      const to = routeForNotification(r.notification.request.content.data as Record<string, unknown>);
      if (to) router.push(to as any);
    });
    return () => sub.remove();
  }, []);
  return null;
}
