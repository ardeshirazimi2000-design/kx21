import { CASE_LEVEL_LABELS, CASE_PRIORITY_LABELS, CASE_STATUS_LABELS, formatJalaliDate, formatJalaliDateTime, type CaseLevel, type CasePriority, type CaseStatus } from '@kx/shared';
import { router, Stack, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Pressable, View } from 'react-native';
import { Badge, Button, Card, Empty, ErrorText, fa, Input, Loading, Row, Screen, T } from '../../components/ui';
import { post } from '../../lib/api';
import { useTheme } from '../../lib/theme';
import { useApi } from '../../lib/useApi';
import { CASE_TONE } from '../../lib/council';

/** One council case: its state, timeline and the next step open to the viewer (e.g. the president's approval). */
export default function CouncilCaseScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const t = useTheme();
  const { data: c, error, loading, reload } = useApi(`/council-cases/${id}`);
  const [acting, setActing] = useState<any | null>(null);
  if (error) return <Screen><ErrorText error={error} /></Screen>;
  if (!c) return <Screen><Loading /></Screen>;
  return (
    <Screen refreshing={loading} onRefresh={reload}>
      <Stack.Screen options={{ title: `پرونده \u2066${fa(c.code)}\u2069` }} />
      <Card>
        <Row>
          <Badge tone={CASE_TONE[c.status as CaseStatus]} label={CASE_STATUS_LABELS[c.status as CaseStatus]} />
          <Row>
            {c.is_overdue && <Badge tone="danger" label="معوق" />}
            <Badge tone={c.level === 'national' ? 'accent' : 'neutral'} label={`سطح ${CASE_LEVEL_LABELS[c.level as CaseLevel]}`} />
          </Row>
        </Row>
        <T bold>{c.title}</T>
        {c.description && <T size={14}>{c.description}</T>}
        <T muted size={13}>
          {c.origin?.chamber_name}
          {c.origin?.commission_name ? ` — ${c.origin.commission_name}` : ''}
        </T>
        <T muted size={13}>
          اولویت: {CASE_PRIORITY_LABELS[c.priority as CasePriority]}
          {c.due_date ? ` — مهلت مرحله: ${formatJalaliDate(`${c.due_date}T12:00:00`)}` : ''}
          {c.confidential ? ' — محرمانه' : ''}
        </T>
        {c.origin_resolution_id && (
          <Pressable onPress={() => router.push(`/resolution/${c.origin_resolution_id}`)}>
            <T color={t.primary} size={13}>مصوبهٔ ارجاع: {fa(c.origin.resolution_number)} ←</T>
          </Pressable>
        )}
        {c.outcome && <T size={14} color={t.success}>نتیجهٔ نهایی: {c.outcome}</T>}
      </Card>

      {c.actions.length > 0 && !acting && (
        <Card title="اقدام بعدی">
          {c.status === 'pending_approval' && c.roles.includes('president') && (
            <T muted size={13}>به‌عنوان دبیر شورا، تأیید یا عدم تأیید ارجاع به شورای ملی را خودتان ثبت می‌کنید.</T>
          )}
          {c.actions.map((a: any) => (
            <Button key={a.action} title={a.label} variant={['reject_escalation', 'return', 'send_back'].includes(a.action) ? 'secondary' : 'primary'} onPress={() => setActing(a)} />
          ))}
        </Card>
      )}
      {acting && <ActionCard c={c} a={acting} onCancel={() => setActing(null)} onDone={() => { setActing(null); void reload(); }} />}

      {c.agenda.length > 0 && (
        <Card title="جلسه‌ها">
          {c.agenda.map((a: any) => (
            <Pressable key={a.agenda_item_id} onPress={() => router.push(`/meeting/${a.meeting_id}`)} style={{ paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: t.border }}>
              <T size={14}>
                {a.body_type === 'council' ? 'شورا' : 'کارشناسی'}: {a.meeting_title}
              </T>
              <T muted size={12}>{formatJalaliDateTime(a.scheduled_at)}</T>
            </Pressable>
          ))}
        </Card>
      )}

      <Card title="خط زمانی">
        {c.events.length === 0 && <Empty text="رویدادی ثبت نشده است" />}
        {c.events.map((e: any) => (
          <View key={e.id} style={{ borderRightWidth: 2, borderRightColor: t.primary, paddingRight: 10, paddingVertical: 4, marginBottom: 6 }}>
            <T bold size={14}>{e.label}</T>
            <T muted size={12}>
              {e.actor_name ? `${e.actor_name} — ` : ''}
              {formatJalaliDateTime(e.created_at)}
            </T>
            {e.meeting_title && <T size={13}>جلسه: {e.meeting_title}</T>}
            {e.resolution_text && <T size={13}>مصوبه {fa(e.resolution_number)}: {e.resolution_text}</T>}
            {e.reason && <T size={13} muted>{e.event === 'close' ? 'نتیجه' : 'دلیل'}: {e.reason}</T>}
          </View>
        ))}
      </Card>
    </Screen>
  );
}

function Choice({ label, selected, onPress }: { label: string; selected: boolean; onPress: () => void }) {
  const t = useTheme();
  return (
    <Pressable onPress={onPress} style={{ borderWidth: 1, borderColor: selected ? t.primary : t.border, backgroundColor: selected ? t.primarySoft : t.surface, borderRadius: 10, padding: 10 }}>
      <T size={14}>{label}</T>
    </Pressable>
  );
}

function ActionCard({ c, a, onCancel, onDone }: { c: any; a: any; onCancel: () => void; onDone: () => void }) {
  const opts = useApi(a.needsMeeting || a.needsResolution ? `/council-cases/${c.id}/options` : null);
  const [meetingId, setMeetingId] = useState('');
  const [resolutionId, setResolutionId] = useState('');
  const [reason, setReason] = useState('');
  const [outcome, setOutcome] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<Error | null>(null);
  const meetings = (opts.data?.meetings ?? []).filter((m: any) => m.body_type === 'council');
  const resolutions = (opts.data?.resolutions ?? []).filter((r: any) => a.needsResolution !== 'council' || r.body_type === 'council');
  const ready =
    (!a.needsMeeting || meetingId) && (!a.needsResolution || resolutionId) && (!a.needsReason || reason.trim().length >= 5) && (!a.needsOutcome || outcome.trim().length >= 5);
  const save = async () => {
    setBusy(true);
    setErr(null);
    try {
      await post(`/council-cases/${c.id}/actions`, {
        action: a.action,
        ...(meetingId ? { meetingId } : {}),
        ...(resolutionId ? { resolutionId } : {}),
        ...(reason.trim() ? { reason: reason.trim() } : {}),
        ...(outcome.trim() ? { outcome: outcome.trim() } : {}),
      });
      onDone();
    } catch (e) {
      setErr(e as Error);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card title={a.label}>
      {a.needsMeeting && (
        <View style={{ gap: 6 }}>
          <T muted size={13}>جلسهٔ شورا</T>
          {opts.data && meetings.length === 0 && <T muted size={13}>جلسهٔ شورایی برای افزودن نیست؛ ابتدا جلسه را تعریف کنید.</T>}
          {meetings.map((m: any) => (
            <Choice key={m.id} label={`${m.title} — ${formatJalaliDate(m.scheduled_at)}`} selected={meetingId === m.id} onPress={() => setMeetingId(m.id)} />
          ))}
        </View>
      )}
      {a.needsResolution && (
        <View style={{ gap: 6 }}>
          <T muted size={13}>مصوبهٔ تصمیم (مهلت مرحلهٔ بعد از همین مصوبه است)</T>
          {opts.data && resolutions.length === 0 && <T muted size={13}>ابتدا مصوبهٔ جلسه‌ای را که پرونده در دستور آن بوده ثبت کنید.</T>}
          {resolutions.map((r: any) => (
            <Choice key={r.id} label={`${fa(r.number)} — ${r.text}`} selected={resolutionId === r.id} onPress={() => setResolutionId(r.id)} />
          ))}
        </View>
      )}
      {a.needsReason && <Input label="دلیل (الزامی)" value={reason} onChangeText={setReason} multiline />}
      {a.needsOutcome && <Input label="نتیجهٔ نهایی برای ابلاغ به مبدأ" value={outcome} onChangeText={setOutcome} multiline />}
      <ErrorText error={err} />
      <Button title="ثبت" busy={busy} disabled={!ready} onPress={() => void save()} />
      <Button title="انصراف" variant="secondary" onPress={onCancel} />
    </Card>
  );
}
