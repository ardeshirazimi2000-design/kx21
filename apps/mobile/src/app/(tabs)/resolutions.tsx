import { formatJalaliDate, RESOLUTION_STATUS_LABELS, type ResolutionStatus } from '@kx/shared';
import { router } from 'expo-router';
import { Pressable } from 'react-native';
import { Badge, Card, Empty, fa, Loading, ProgressBar, Row, Screen, T } from '../../components/ui';
import { useApi } from '../../lib/useApi';

export default function ResolutionsScreen() {
  const { data, loading, reload } = useApi('/resolutions?mine=true&pageSize=50');
  return (
    <Screen refreshing={loading} onRefresh={reload}>
      {!data && loading && <Loading />}
      {data?.items.length === 0 && <Empty text="مصوبه‌ای به شما سپرده نشده است" />}
      {data?.items.map((r: any) => (
        <Pressable key={r.id} onPress={() => router.push(`/resolution/${r.id}`)}>
          <Card highlight={r.is_overdue}>
            <Row>
              <T bold>{fa(r.number)}</T>
              <Row>
                {r.is_overdue && <Badge tone="danger" label="معوق" />}
                <Badge tone={r.status === 'done' ? 'success' : 'info'} label={RESOLUTION_STATUS_LABELS[r.status as ResolutionStatus]} />
              </Row>
            </Row>
            <T>{r.text}</T>
            <T muted size={13}>
              {r.commission_name} — مهلت: {r.due_date ? formatJalaliDate(`${r.due_date}T12:00:00`) : '—'}
            </T>
            <ProgressBar value={r.progress} />
          </Card>
        </Pressable>
      ))}
    </Screen>
  );
}
