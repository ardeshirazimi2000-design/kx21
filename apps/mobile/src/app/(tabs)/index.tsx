import { formatJalaliDateTime, MEETING_STATUS_LABELS, ROLE_LABELS, type InviteeRole, type MeetingStatus } from '@kx/shared';
import { router } from 'expo-router';
import { Pressable } from 'react-native';
import { Badge, Card, Empty, fa, Loading, ProgressBar, Row, Screen, T } from '../../components/ui';
import { useAuth } from '../../lib/auth';
import { useRealtime } from '../../lib/socket';
import { useTheme } from '../../lib/theme';
import { useApi } from '../../lib/useApi';

export default function HomeScreen() {
  const { me } = useAuth();
  const t = useTheme();
  const { data, loading, reload } = useApi('/me/home');
  useRealtime({ notification: () => void reload() }, { onReconnect: () => void reload() });
  if (!data) return <Screen>{loading ? <Loading /> : <Empty text="اطلاعاتی در دسترس نیست" />}</Screen>;
  return (
    <Screen refreshing={loading} onRefresh={reload}>
      <T bold size={20}>سلام، {me?.full_name}</T>
      {data.live.map((m: any) => (
        <Pressable key={m.id} onPress={() => router.push(`/meeting/${m.id}`)}>
          <Card highlight>
            <Row>
              <T bold>{m.title}</T>
              <Badge tone="success" label={MEETING_STATUS_LABELS[m.status as MeetingStatus]} />
            </Row>
            <T muted>{m.commission_name}</T>
            <T color={t.primary} bold>
              ورود به اتاق جلسه ←
            </T>
          </Card>
        </Pressable>
      ))}
      <Card title="جلسات پیش رو">
        {data.upcoming.length === 0 && <Empty text="جلسه‌ای برای شما برنامه‌ریزی نشده است" />}
        {data.upcoming.map((m: any) => (
          <Pressable key={m.id} onPress={() => router.push(`/meeting/${m.id}`)} style={{ paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: t.border }}>
            <Row>
              <T bold>{m.title}</T>
              <Badge tone="info" label={ROLE_LABELS[m.my_role as InviteeRole]} />
            </Row>
            <T muted size={13}>
              {m.commission_name} — {formatJalaliDateTime(m.scheduled_at)}
            </T>
          </Pressable>
        ))}
      </Card>
      <Card title="مصوبات من">
        {data.resolutions.length === 0 && <Empty text="مصوبه بازی به شما سپرده نشده است" />}
        {data.resolutions.map((r: any) => (
          <Pressable key={r.id} onPress={() => router.push(`/resolution/${r.id}`)} style={{ paddingVertical: 8, gap: 4 }}>
            <Row>
              <T bold>{fa(r.number)}</T>
              {r.is_overdue && <Badge tone="danger" label="معوق" />}
            </Row>
            <T size={13} style={{}}>
              {r.text}
            </T>
            <ProgressBar value={r.progress} />
          </Pressable>
        ))}
      </Card>
      {data.referrals.length > 0 && (
        <Card title="ارجاعات کارشناسی">
          {data.referrals.map((r: any) => (
            <T key={r.id}>• {r.request}</T>
          ))}
        </Card>
      )}
    </Screen>
  );
}
