import { formatJalaliDateTime } from '@kx/shared';
import { router } from 'expo-router';
import { Pressable } from 'react-native';
import { Button, Card, Empty, Screen, T } from '../../components/ui';
import { post } from '../../lib/api';
import { useRealtime } from '../../lib/socket';
import { useTheme } from '../../lib/theme';
import { useApi } from '../../lib/useApi';

export default function NotificationsScreen() {
  const t = useTheme();
  const { data, loading, reload } = useApi('/notifications?pageSize=50');
  useRealtime({ notification: () => void reload() });
  const open = async (n: any) => {
    if (!n.read_at) await post(`/notifications/${n.id}/read`).catch(() => {});
    if (n.data?.meetingId) router.push(`/meeting/${n.data.meetingId}`);
    else if (n.data?.resolutionId) router.push(`/resolution/${n.data.resolutionId}`);
    else void reload();
  };
  return (
    <Screen refreshing={loading} onRefresh={reload}>
      <Button title="خواندن همه" variant="secondary" onPress={() => post('/notifications/read-all').then(reload)} />
      {data?.items.length === 0 && <Empty text="اعلانی ندارید" />}
      {data?.items.map((n: any) => (
        <Pressable key={n.id} onPress={() => open(n)}>
          <Card style={{ borderRightWidth: n.read_at ? 1 : 4, borderRightColor: n.read_at ? t.border : t.accent }}>
            <T bold={!n.read_at}>{n.title}</T>
            <T muted size={13}>{n.body}</T>
            <T muted size={12}>{formatJalaliDateTime(n.created_at)}</T>
          </Card>
        </Pressable>
      ))}
    </Screen>
  );
}
