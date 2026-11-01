import { CASE_LEVEL_LABELS, CASE_STATUS_LABELS, formatJalaliDate, type CaseLevel, type CaseStatus } from '@kx/shared';
import { router } from 'expo-router';
import { useState } from 'react';
import { Pressable, View } from 'react-native';
import { Badge, Card, Empty, fa, Loading, Row, Screen, T } from '../../components/ui';
import { CASE_TONE } from '../../lib/council';
import { useTheme } from '../../lib/theme';
import { useApi } from '../../lib/useApi';


const FILTERS: { key: string; label: string }[] = [
  { key: 'expert_review,on_agenda,pending_approval,returned', label: 'در جریان' },
  { key: 'pending_approval', label: 'منتظر تأیید' },
  { key: '', label: 'همه' },
];

/** پرونده‌های شورای گفت‌وگو that the user may see. */
export default function CouncilCasesScreen() {
  const t = useTheme();
  const [status, setStatus] = useState(FILTERS[0].key);
  const { data, loading, reload } = useApi(`/council-cases?pageSize=50${status ? `&status=${status}` : ''}`);
  return (
    <Screen refreshing={loading} onRefresh={reload}>
      <View style={{ flexDirection: 'row-reverse', gap: 6 }}>
        {FILTERS.map((f) => (
          <Pressable
            key={f.key}
            onPress={() => setStatus(f.key)}
            style={{ borderWidth: 1, borderColor: status === f.key ? t.primary : t.border, backgroundColor: status === f.key ? t.primarySoft : t.surface, borderRadius: 99, paddingHorizontal: 12, paddingVertical: 6 }}
          >
            <T size={13}>{f.label}</T>
          </Pressable>
        ))}
      </View>
      {!data && loading && <Loading />}
      {data?.items.length === 0 && <Empty text="پرونده‌ای نیست" />}
      {data?.items.map((c: any) => (
        <Pressable key={c.id} onPress={() => router.push(`/council/${c.id}`)}>
          <Card highlight={c.is_overdue || c.status === 'pending_approval'}>
            <Row>
              <T bold>{`\u2066${fa(c.code)}\u2069`}</T>
              <Row>
                {c.is_overdue && <Badge tone="danger" label="معوق" />}
                <Badge tone={CASE_TONE[c.status as CaseStatus]} label={CASE_STATUS_LABELS[c.status as CaseStatus]} />
              </Row>
            </Row>
            <T>{c.title}</T>
            <T muted size={13}>
              {c.origin_province} — سطح {CASE_LEVEL_LABELS[c.level as CaseLevel]}
              {c.due_date ? ` — مهلت: ${formatJalaliDate(`${c.due_date}T12:00:00`)}` : ''}
              {c.confidential ? ' — محرمانه' : ''}
            </T>
          </Card>
        </Pressable>
      ))}
    </Screen>
  );
}
