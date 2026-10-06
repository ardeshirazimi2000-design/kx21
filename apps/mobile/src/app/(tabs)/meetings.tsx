import { formatJalaliDateTime, MEETING_STATUS_LABELS, type MeetingStatus } from '@kx/shared';
import { router } from 'expo-router';
import { useState } from 'react';
import { Pressable, View } from 'react-native';
import { Badge, Button, Card, Empty, fa, Loading, Row, Screen, T, type Tone } from '../../components/ui';
import { useApi } from '../../lib/useApi';

const TONE: Partial<Record<MeetingStatus, Tone>> = {
  checkin_open: 'accent',
  in_progress: 'success',
  agenda_processing: 'success',
  cancelled: 'danger',
  scheduled: 'info',
  invitation_sent: 'info',
};

export default function MeetingsScreen() {
  const [past, setPast] = useState(false);
  const now = new Date(Date.now() - 12 * 3600 * 1000).toISOString();
  const { data, loading, reload } = useApi(past ? `/meetings?mine=true&to=${now}&order=desc&pageSize=50` : `/meetings?mine=true&from=${now}&pageSize=50`);
  return (
    <Screen refreshing={loading} onRefresh={reload}>
      <View style={{ flexDirection: 'row-reverse', gap: 8 }}>
        <Button title="جلسات آینده" variant={past ? 'secondary' : 'primary'} onPress={() => setPast(false)} />
        <Button title="جلسات گذشته" variant={past ? 'primary' : 'secondary'} onPress={() => setPast(true)} />
      </View>
      {!data && loading && <Loading />}
      {data?.items.length === 0 && <Empty text="جلسه‌ای یافت نشد" />}
      {data?.items.map((m: any) => (
        <Pressable key={m.id} onPress={() => router.push(`/meeting/${m.id}`)}>
          <Card>
            <Row>
              <T bold>{m.commission_name}</T>
              <Badge tone={TONE[m.status as MeetingStatus] ?? 'neutral'} label={MEETING_STATUS_LABELS[m.status as MeetingStatus]} />
            </Row>
            <T>
              جلسه {fa(m.number)}: {m.title}
            </T>
            <T muted size={13}>
              {formatJalaliDateTime(m.scheduled_at)}
              {m.location ? ` — ${m.location}` : ''}
            </T>
          </Card>
        </Pressable>
      ))}
    </Screen>
  );
}
