import { formatJalaliDate, formatJalaliDateTime, PRIORITY_LABELS, RESOLUTION_STATUS_LABELS, type Priority, type ResolutionStatus } from '@kx/shared';
import { Stack, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Pressable, View } from 'react-native';
import { Badge, Button, Card, Empty, ErrorText, fa, Input, Loading, ProgressBar, Row, Screen, T } from '../../components/ui';
import { patch, post } from '../../lib/api';
import { useTheme } from '../../lib/theme';
import { useApi } from '../../lib/useApi';

const STEPS = [0, 10, 25, 50, 75, 90, 100];

export default function ResolutionScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const t = useTheme();
  const { data: r, error, loading, reload } = useApi(`/resolutions/${id}`);
  const [progress, setProgress] = useState<number | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<Error | null>(null);
  if (error) return <Screen><ErrorText error={error} /></Screen>;
  if (!r) return <Screen><Loading /></Screen>;
  const closed = r.status === 'done' || r.status === 'cancelled';
  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setErr(null);
    try {
      await fn();
      setNote('');
      setProgress(null);
      await reload();
    } catch (e) {
      setErr(e as Error);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Screen refreshing={loading} onRefresh={reload}>
      <Stack.Screen options={{ title: `مصوبه ${fa(r.number)}` }} />
      <Card>
        <Row>
          <Badge tone={r.status === 'done' ? 'success' : r.status === 'returned' ? 'danger' : 'info'} label={RESOLUTION_STATUS_LABELS[r.status as ResolutionStatus]} />
          <Badge tone="neutral" label={`اولویت: ${PRIORITY_LABELS[r.priority as Priority]}`} />
        </Row>
        <T>{r.text}</T>
        <T muted size={13}>{r.commission_name}{r.meeting_number ? ` — جلسه ${fa(r.meeting_number)}` : ''}</T>
        <T muted size={13}>مخاطب: {r.addressee ?? '—'} — مهلت: {r.due_date ? formatJalaliDate(`${r.due_date}T12:00:00`) : '—'}</T>
        {r.kpi && <T muted size={13}>شاخص نتیجه: {r.kpi}</T>}
        <ProgressBar value={r.progress} />
        <T muted size={12}>پیشرفت: {fa(r.progress)}٪</T>
      </Card>
      <ErrorText error={err} />
      {(r.isOwner || r.canManage) && !closed && r.status !== 'submitted' && (
        <Card title="ثبت پیشرفت">
          <View style={{ flexDirection: 'row-reverse', flexWrap: 'wrap', gap: 6 }}>
            {STEPS.map((s) => (
              <Pressable key={s} onPress={() => setProgress(s)} style={{ borderWidth: 1, borderColor: (progress ?? r.progress) === s ? t.primary : t.border, backgroundColor: (progress ?? r.progress) === s ? t.primarySoft : t.surface, borderRadius: 99, paddingHorizontal: 12, paddingVertical: 6 }}>
                <T size={13}>{fa(s)}٪</T>
              </Pressable>
            ))}
          </View>
          <Input label="توضیح اقدام" value={note} onChangeText={setNote} multiline />
          <Button title="ثبت پیشرفت" variant="secondary" busy={busy} onPress={() => act(() => patch(`/resolutions/${id}/progress`, { progress: progress ?? r.progress, note: note || null }))} />
          <Button title="ارسال نتیجه برای بررسی دبیر" busy={busy} onPress={() => act(() => patch(`/resolutions/${id}/progress`, { progress: progress ?? r.progress, note: note || null, submit: true }))} />
        </Card>
      )}
      {r.canManage && r.status === 'submitted' && (
        <Card title="بررسی نتیجه">
          <Input label="توضیح" value={note} onChangeText={setNote} />
          <Button title="تأیید انجام" variant="success" busy={busy} onPress={() => act(() => post(`/resolutions/${id}/review`, { approve: true, note: note || null }))} />
          <Button title="برگشت" variant="danger" disabled={note.length < 3} busy={busy} onPress={() => act(() => post(`/resolutions/${id}/review`, { approve: false, note }))} />
        </Card>
      )}
      <Card title="تاریخچه پیگیری">
        {r.updates.length === 0 && <Empty text="گزارشی ثبت نشده است" />}
        {r.updates.map((u: any) => (
          <View key={u.id} style={{ borderBottomWidth: 1, borderBottomColor: t.border, paddingVertical: 6 }}>
            <T bold size={13}>{u.full_name} — {u.kind === 'progress' ? `پیشرفت ${fa(u.progress)}٪` : u.kind === 'approve' ? 'تأیید' : 'برگشت'}</T>
            {u.note && <T size={13}>{u.note}</T>}
            <T muted size={12}>{formatJalaliDateTime(u.created_at)}</T>
          </View>
        ))}
      </Card>
    </Screen>
  );
}
