import {
  AGENDA_STATUS_LABELS,
  ATTENDANCE_STATUS_LABELS,
  ATTENDANCE_STATUSES,
  formatJalaliLong,
  formatTime,
  MEETING_STATUS_LABELS,
  MEETING_TYPE_LABELS,
  roleLabel, VOTE_OPTION_LABELS,
  type AgendaStatus,
  type AttendanceStatus,
  
  type MeetingStatus,
  type MeetingType,
} from '@kx/shared';
import { Stack, useLocalSearchParams } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Alert, Linking, Modal, Pressable, ScrollView, View } from 'react-native';
import { Badge, Button, Card, Empty, ErrorText, fa, Input, Loading, Row, Screen, T, type Tone } from '../../components/ui';
import * as DocumentPicker from 'expo-document-picker';
import * as ImagePicker from 'expo-image-picker';
import { api, ApiError, post, uploadFile } from '../../lib/api';
import { getApiUrl } from '../../lib/config';
import { addMeetingToCalendar } from '../../lib/calendar';
import { useRealtime } from '../../lib/socket';
import { useTheme } from '../../lib/theme';
import { useApi } from '../../lib/useApi';

const ATT_TONE: Record<AttendanceStatus, Tone> = {
  pending: 'neutral',
  present: 'success',
  online: 'info',
  proxy: 'accent',
  manual_present: 'success',
  absent: 'danger',
  excused: 'warning',
};
const ATTENDING: AttendanceStatus[] = ['present', 'online', 'proxy', 'manual_present'];

function useCountdown(target: string | undefined) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  if (!target) return null;
  const diff = new Date(target).getTime() - now;
  if (diff <= 0) return null;
  const d = Math.floor(diff / 86400000);
  const h = Math.floor((diff % 86400000) / 3600000);
  const m = Math.floor((diff % 3600000) / 60000);
  const s = Math.floor((diff % 60000) / 1000);
  return fa(d > 0 ? `${d} روز و ${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`);
}

export default function MeetingRoomScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const t = useTheme();
  const { data: m, error, loading, reload, setData } = useApi(`/meetings/${id}`);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<Error | null>(null);
  const [pendingCheckIn, setPendingCheckIn] = useState(false);
  const [editing, setEditing] = useState<any | null>(null);
  const [commentsFor, setCommentsFor] = useState<any | null>(null);
  const [minutesOpen, setMinutesOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const reloadSoon = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void reload(), 150);
  };

  const run = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    setActionError(null);
    try {
      await fn();
      await reload();
    } catch (e) {
      setActionError(e as Error);
    } finally {
      setBusy(null);
    }
  };

  const checkIn = async (method: 'app' | 'online' = 'app') => {
    setBusy('checkin');
    setActionError(null);
    try {
      await post(`/meetings/${id}/check-in`, { method });
      setPendingCheckIn(false);
      await reload();
    } catch (e) {
      // Offline: keep the request queued and resend when the connection returns.
      if ((e as ApiError).status === 0) setPendingCheckIn(true);
      else setActionError(e as Error);
    } finally {
      setBusy(null);
    }
  };

  const connected = useRealtime(
    {
      'meeting.updated': reloadSoon,
      'agenda.updated': reloadSoon,
      'vote.opened': reloadSoon,
      'vote.closed': reloadSoon,
      'vote.progress': (p) => setData((d: any) => d && { ...d, votes: d.votes.map((v: any) => (v.id === p.voteSessionId ? { ...v, cast_count: p.castCount, eligible: p.eligible } : v)) }),
      'attendance.updated': (p) => setData((d: any) => d && { ...d, invitees: p.attendance, quorum: p.quorum }),
      'quorum.updated': (p) => setData((d: any) => (d && !d.capabilities.includes('attendance.view_all') ? { ...d, quorum: p.quorum } : d)),
    },
    {
      meetingId: id,
      onReconnect: () => {
        void reload();
        if (pendingCheckIn) void checkIn();
      },
    },
  );

  const countdown = useCountdown(m?.scheduled_at);

  if (error) return <Screen><ErrorText error={error} /></Screen>;
  if (!m) return <Screen><Loading /></Screen>;

  const can = (c: string) => m.capabilities.includes(c);
  const act = (a: string) => m.availableActions.includes(a);
  const live = m.status === 'in_progress' || m.status === 'agenda_processing';
  const myAtt: AttendanceStatus | undefined = m.my.attendance?.status;
  const attending = !!myAtt && ATTENDING.includes(myAtt);
  const active = m.agenda.find((a: any) => a.status === 'active');
  const openVotes = m.votes.filter((v: any) => v.status === 'open');

  return (
    <Screen refreshing={loading} onRefresh={reload}>
      <Stack.Screen options={{ title: `جلسه ${fa(m.number)}` }} />

      {/* Pre-meeting / header */}
      <Card>
        <Row>
          <Badge tone={live ? 'success' : m.status === 'cancelled' ? 'danger' : 'info'} label={MEETING_STATUS_LABELS[m.status as MeetingStatus]} />
          <Row>
            <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: connected ? t.success : t.danger }} />
            <T muted size={12}>{connected ? 'زنده' : 'آفلاین'}</T>
          </Row>
        </Row>
        <T bold size={18}>{m.title}</T>
        <T muted>{m.commission.name}</T>
        <T>
          {formatJalaliLong(m.scheduled_at)} — ساعت {formatTime(m.scheduled_at)}
        </T>
        <T muted>
          {MEETING_TYPE_LABELS[m.type as MeetingType]}
          {m.location ? ` — ${m.location}` : ''}
        </T>
        {countdown && !live && (
          <View style={{ backgroundColor: t.primarySoft, borderRadius: 10, padding: 10, alignItems: 'center' }}>
            <T muted size={12}>زمان باقی‌مانده تا شروع</T>
            <T bold size={22} color={t.primary}>{countdown}</T>
          </View>
        )}
        {m.status === 'cancelled' && <T color={t.danger}>لغو شد: {m.cancel_reason}</T>}
        <Row style={{ justifyContent: 'flex-end' }}>
          {m.online_link && <Button title="ورود به جلسه آنلاین" variant="secondary" onPress={() => Linking.openURL(m.online_link)} />}
          <Button
            title="افزودن به تقویم"
            variant="secondary"
            onPress={async () => {
              const ok = await addMeetingToCalendar({
                title: `${m.commission.name} — ${m.title}`,
                start: new Date(m.scheduled_at),
                durationMinutes: m.duration_minutes,
                location: m.location,
              }).catch(() => false);
              Alert.alert(ok ? 'جلسه به تقویم اضافه شد' : 'افزودن به تقویم ممکن نشد');
            }}
          />
        </Row>
      </Card>

      <ErrorText error={actionError} />

      {m.my.delegateFor && (
        <Card style={{ backgroundColor: t.infoSoft, borderColor: 'transparent' }}>
          <T>
            شما به نمایندگی از <T bold>{m.my.delegateFor.fullName}</T>
            {m.my.delegateFor.organization ? ` (${m.my.delegateFor.organization})` : ''} در این جلسه حضور دارید؛ اعلام حضور و رأی شما به نام ایشان ثبت می‌شود.
          </T>
        </Card>
      )}
      {m.my.role && !m.my.delegateFor && m.settings.allowProxy && !live && !['minutes_draft', 'pending_approval', 'approved', 'archived', 'cancelled'].includes(m.status) && (
        <DelegateCard m={m} onChanged={reload} />
      )}

      {/* My check-in */}
      {m.my.role && (
        <Card>
          {attending ? (
            <Row>
              <T bold>حضور شما ثبت شد</T>
              <Badge tone={ATT_TONE[myAtt!]} label={ATTENDANCE_STATUS_LABELS[myAtt!]} />
            </Row>
          ) : m.checkinOpen ? (
            <>
              <Button title={pendingCheckIn ? 'در صف ارسال (منتظر اتصال)…' : 'اعلام حضور من'} variant="success" big busy={busy === 'checkin'} onPress={() => checkIn('app')} />
              {m.type !== 'in_person' && <Button title="اعلام حضور آنلاین" variant="secondary" onPress={() => checkIn('online')} />}
            </>
          ) : (
            <T muted>{myAtt ? `وضعیت حضور: ${ATTENDANCE_STATUS_LABELS[myAtt]}` : 'اعلام حضور هنوز باز نشده است.'}</T>
          )}
          <T muted size={12}>
            نقش شما: {roleLabel(m.my.role, m.invitees.find((x: any) => x.user_id === m.my.attendance?.user_id)?.role_title)} — {m.my.hasVote ? 'دارای حق رأی' : 'بدون حق رأی'}
          </T>
        </Card>
      )}

      {/* Quorum */}
      <Card style={{ backgroundColor: m.quorum.reached ? t.successSoft : t.warningSoft, borderColor: 'transparent' }}>
        <Row>
          <T bold color={m.quorum.reached ? t.success : t.warning}>{m.quorum.reached ? 'حد نصاب حاصل شد' : 'حد نصاب حاصل نشده'}</T>
          <T bold size={22} color={m.quorum.reached ? t.success : t.warning}>
            {fa(m.quorum.present)}/{fa(m.quorum.eligible)}
          </T>
        </Row>
        <T size={13}>
          حد نصاب لازم: {fa(m.quorum.required)} — کل حاضرین: {fa(m.quorum.attendingTotal)}
        </T>
        {can('attendance.view_all') && m.quorum.explanation && <T size={12} muted>{fa(m.quorum.explanation)}</T>}
      </Card>

      {/* Officer controls */}
      {(can('meeting.control') || can('meeting.manage')) && (
        <Card title="کنترل جلسه">
          <View style={{ gap: 8 }}>
            {can('meeting.manage') && act('open_checkin') && <Button title="باز کردن اعلام حضور" busy={busy === 'open'} onPress={() => run('open', () => post(`/meetings/${id}/checkin/open`))} />}
            {can('meeting.control') && act('start') && <Button title="شروع رسمی جلسه" variant="success" busy={busy === 'start'} onPress={() => run('start', () => post(`/meetings/${id}/start`))} />}
            {can('meeting.manage') && m.checkinOpen && live && <Button title="بستن اعلام حضور" variant="secondary" onPress={() => run('close', () => post(`/meetings/${id}/checkin/close`))} />}
            {can('meeting.control') && act('end') && (
              <Button
                title="پایان جلسه"
                variant="danger"
                busy={busy === 'end'}
                onPress={() =>
                  Alert.alert('پایان جلسه', 'جلسه خاتمه یابد و پیش‌نویس صورتجلسه تولید شود؟', [
                    { text: 'انصراف', style: 'cancel' },
                    { text: 'پایان', style: 'destructive', onPress: () => void run('end', () => post(`/meetings/${id}/end`)) },
                  ])
                }
              />
            )}
          </View>
        </Card>
      )}

      {/* Live agenda: active item first */}
      {active && (
        <Card title="آیتم در حال بررسی" highlight>
          <AgendaBody item={active} m={m} run={run} busy={busy} onComments={() => setCommentsFor(active)} />
        </Card>
      )}
      {openVotes
        .filter((v: any) => v.agenda_item_id !== active?.id)
        .map((v: any) => (
          <VoteCard key={v.id} v={v} m={m} run={run} busy={busy} />
        ))}

      <Card title="دستور جلسه">
        {m.agenda.length === 0 && <Empty text="دستور جلسه‌ای ثبت نشده" />}
        {m.agenda
          .filter((a: any) => a.id !== active?.id)
          .map((a: any) => (
            <View key={a.id} style={{ borderTopWidth: 1, borderTopColor: t.border, paddingTop: 8, gap: 6, opacity: a.status === 'removed' ? 0.5 : 1 }}>
              <AgendaBody item={a} m={m} run={run} busy={busy} onComments={() => setCommentsFor(a)} compact />
            </View>
          ))}
      </Card>

      {/* Attendance list for chair/secretary */}
      {can('attendance.view_all') && (
        <Card title="لیست حاضرین">
          {m.invitees.map((p: any) => (
            <Pressable
              key={p.user_id}
              onPress={() => can('meeting.manage') && setEditing(p)}
              style={{ flexDirection: 'row-reverse', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 6, borderBottomWidth: 1, borderBottomColor: t.border }}
            >
              <View>
                <T>{p.full_name}</T>
                <T muted size={12}>
                  {roleLabel(p.role, p.role_title)}
                  {p.has_vote ? ' — حق رأی' : ''}
                  {p.checked_in_at ? ` — ${formatTime(p.checked_in_at)}` : ''}
                </T>
              </View>
              <Badge tone={ATT_TONE[p.status as AttendanceStatus]} label={ATTENDANCE_STATUS_LABELS[p.status as AttendanceStatus]} />
            </Pressable>
          ))}
        </Card>
      )}
      {!can('attendance.view_all') && (
        <Card title="مدعوین">
          {m.invitees.map((p: any) => (
            <Row key={p.user_id}>
              <T>{p.full_name}</T>
              <T muted size={12}>{roleLabel(p.role, p.role_title)}</T>
            </Row>
          ))}
        </Card>
      )}

      {(m.documents.length > 0 || can('meeting.manage')) && <MeetingDocuments m={m} canUpload={can('meeting.manage')} onChanged={reload} />}

      {m.minutes && (
        <Card title="صورتجلسه">
          <T muted>
            وضعیت: {m.minutes.status === 'approved' ? `تأیید شده (شماره ${fa(m.minutes.minutes_number)})` : m.minutes.status === 'pending_approval' ? 'در انتظار تأیید رئیس' : 'پیش‌نویس'}
          </T>
          {(m.minutes.status === 'approved' || can('meeting.manage') || can('minutes.approve')) && <Button title="مشاهده صورتجلسه" variant="secondary" onPress={() => setMinutesOpen(true)} />}
        </Card>
      )}

      {editing && <AttendanceEditor person={editing} allowProxy={m.settings.allowProxy} onClose={() => setEditing(null)} onSave={(body) => run('att', () => post(`/meetings/${id}/attendance/${editing.user_id}/confirm`, body)).then(() => setEditing(null))} />}
      {commentsFor && <CommentsModal item={commentsFor} canPost={can('comment.create') && m.settings.allowComments} onClose={() => setCommentsFor(null)} />}
      {minutesOpen && <MinutesModal meetingId={id!} onClose={() => { setMinutesOpen(false); void reload(); }} />}
    </Screen>
  );
}

function AgendaBody({ item, m, run, busy, onComments, compact }: { item: any; m: any; run: (k: string, fn: () => Promise<unknown>) => Promise<void>; busy: string | null; onComments: () => void; compact?: boolean }) {
  const can = (c: string) => m.capabilities.includes(c);
  const live = m.status === 'in_progress' || m.status === 'agenda_processing';
  const votes = m.votes.filter((v: any) => v.agenda_item_id === item.id);
  const openVote = votes.find((v: any) => v.status === 'open');
  const idx = m.agenda.findIndex((a: any) => a.id === item.id);
  return (
    <View style={{ gap: 6 }}>
      <Row>
        <T bold>
          {fa(idx + 1)}. {item.title}
        </T>
        <Badge tone={item.status === 'active' ? 'success' : item.status === 'done' ? 'info' : 'neutral'} label={AGENDA_STATUS_LABELS[item.status as AgendaStatus]} />
      </Row>
      {!compact && item.description && <T size={13}>{item.description}</T>}
      {item.decision && <T size={13}>تصمیم: {item.decision}</T>}
      {votes.map((v: any) => (
        <VoteCard key={v.id} v={v} m={m} run={run} busy={busy} inline />
      ))}
      <Row style={{ justifyContent: 'flex-end' }}>
        <Button title={`نظرات (${fa(item.comment_count)})`} variant="ghost" onPress={onComments} />
        {can('meeting.control') && live && item.status !== 'active' && item.status !== 'removed' && (
          <Button title="فعال‌سازی" variant="secondary" busy={busy === `act-${item.id}`} onPress={() => run(`act-${item.id}`, () => post(`/meetings/${m.id}/agenda/${item.id}/activate`))} />
        )}
        {can('meeting.control') && live && item.status === 'active' && !openVote && (
          <>
            <Button
              title="شروع رأی‌گیری"
              variant="success"
              busy={busy === `vote-${item.id}`}
              onPress={() =>
                Alert.alert('نوع رأی‌گیری', undefined, [
                  { text: 'آشکار', onPress: () => void run(`vote-${item.id}`, () => post(`/agenda-items/${item.id}/vote/start`, { secret: false })) },
                  { text: 'مخفی', onPress: () => void run(`vote-${item.id}`, () => post(`/agenda-items/${item.id}/vote/start`, { secret: true })) },
                  { text: 'انصراف', style: 'cancel' },
                ])
              }
            />
            <Button title="خاتمه آیتم" variant="secondary" onPress={() => run(`done-${item.id}`, () => post(`/agenda-items/${item.id}/complete`, { status: 'done' }))} />
          </>
        )}
      </Row>
    </View>
  );
}

function VoteCard({ v, m, run, busy, inline }: { v: any; m: any; run: (k: string, fn: () => Promise<unknown>) => Promise<void>; busy: string | null; inline?: boolean }) {
  const t = useTheme();
  const can = (c: string) => m.capabilities.includes(c);
  const eligible = v.eligible ?? m.quorum.present;
  const r = v.result;
  const body = (
    <View style={{ gap: 8, backgroundColor: t.surface2, borderRadius: 10, padding: 10 }}>
      <Row>
        <T bold>{v.title}</T>
        <Row>
          {v.secret && <Badge tone="accent" label="مخفی" />}
          <Badge tone={v.status === 'open' ? 'success' : 'neutral'} label={v.status === 'open' ? 'در حال رأی‌گیری' : 'بسته شد'} />
        </Row>
      </Row>
      {v.status === 'open' && (
        <>
          <T muted size={13}>
            آرای ثبت‌شده: {fa(v.cast_count)} از {fa(eligible)}
          </T>
          {can('vote.cast') && !v.my_choice && (
            <View style={{ flexDirection: 'row-reverse', gap: 8 }}>
              {(v.options as string[]).map((o) => (
                <View key={o} style={{ flex: 1 }}>
                  <Button
                    title={VOTE_OPTION_LABELS[o] ?? o}
                    big
                    variant={o === 'yes' ? 'success' : o === 'no' ? 'danger' : 'secondary'}
                    busy={busy === `cast-${v.id}-${o}`}
                    onPress={() =>
                      Alert.alert('ثبت رأی', `رأی «${VOTE_OPTION_LABELS[o] ?? o}» ثبت شود؟ پس از ثبت قابل تغییر نیست.`, [
                        { text: 'انصراف', style: 'cancel' },
                        { text: 'ثبت', onPress: () => void run(`cast-${v.id}-${o}`, () => post(`/agenda-items/${v.agenda_item_id}/vote`, { choice: o, voteSessionId: v.id })) },
                      ])
                    }
                  />
                </View>
              ))}
            </View>
          )}
          {v.my_choice && <T color={t.success} bold>رأی شما ثبت شد: {VOTE_OPTION_LABELS[v.my_choice] ?? v.my_choice}</T>}
          {can('meeting.control') && <Button title="پایان رأی‌گیری و اعلام نتیجه" variant="danger" busy={busy === `close-${v.id}`} onPress={() => run(`close-${v.id}`, () => post(`/vote-sessions/${v.id}/close`))} />}
        </>
      )}
      {v.status === 'closed' &&
        (r ? (
          <>
            <T bold color={r.passed ? t.success : t.danger}>{r.passed ? 'تصویب شد' : 'تصویب نشد'}</T>
            <T size={13}>
              موافق {fa(r.counts.yes ?? 0)} — مخالف {fa(r.counts.no ?? 0)} — ممتنع {fa(r.counts.abstain ?? 0)} — مشارکت {fa(r.participationPercent)}٪
            </T>
          </>
        ) : (
          <T muted size={13}>نتیجه فقط برای رئیس و دبیر نمایش داده می‌شود.</T>
        ))}
    </View>
  );
  return inline ? body : <Card>{body}</Card>;
}

function AttendanceEditor({ person, allowProxy, onClose, onSave }: { person: any; allowProxy: boolean; onClose: () => void; onSave: (b: any) => void }) {
  const t = useTheme();
  const [status, setStatus] = useState<AttendanceStatus>(person.status === 'pending' ? 'manual_present' : person.status);
  const [reason, setReason] = useState('');
  const [proxyName, setProxyName] = useState('');
  return (
    <Modal transparent animationType="slide" onRequestClose={onClose}>
      <View style={{ flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.4)' }}>
        <View style={{ backgroundColor: t.surface, padding: 16, gap: 10, borderTopLeftRadius: 16, borderTopRightRadius: 16 }}>
          <T bold size={16}>ثبت/اصلاح حضور — {person.full_name}</T>
          <View style={{ flexDirection: 'row-reverse', flexWrap: 'wrap', gap: 6 }}>
            {ATTENDANCE_STATUSES.filter((s) => s !== 'pending' && (allowProxy || s !== 'proxy')).map((s) => (
              <Pressable key={s} onPress={() => setStatus(s)} style={{ borderWidth: 1, borderColor: status === s ? t.primary : t.border, backgroundColor: status === s ? t.primarySoft : t.surface, borderRadius: 99, paddingHorizontal: 12, paddingVertical: 6 }}>
                <T size={13}>{ATTENDANCE_STATUS_LABELS[s]}</T>
              </Pressable>
            ))}
          </View>
          {status === 'proxy' && <Input label="نام نماینده" value={proxyName} onChangeText={setProxyName} />}
          <Input label="دلیل (الزامی؛ در رویدادنگاری ثبت می‌شود)" value={reason} onChangeText={setReason} />
          <Button title="ثبت" disabled={reason.trim().length < 2} onPress={() => onSave({ status, reason, proxyName: status === 'proxy' ? proxyName : undefined })} />
          <Button title="انصراف" variant="ghost" onPress={onClose} />
        </View>
      </View>
    </Modal>
  );
}

function CommentsModal({ item, canPost, onClose }: { item: any; canPost: boolean; onClose: () => void }) {
  const t = useTheme();
  const { data, reload, setData } = useApi<any[]>(`/agenda-items/${item.id}/comments`);
  const [text, setText] = useState('');
  const [err, setErr] = useState<Error | null>(null);
  useRealtime({ 'comment.created': (c) => c.agenda_item_id === item.id && setData((d) => (d && !d.some((x) => x.id === c.id) ? [...d, c] : d)) });
  return (
    <Modal animationType="slide" onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: t.bg, paddingTop: 48 }}>
        <View style={{ padding: 16, gap: 8 }}>
          <Row>
            <T bold size={16}>نظرات: {item.title}</T>
            <Button title="بستن" variant="ghost" onPress={onClose} />
          </Row>
          <ErrorText error={err} />
        </View>
        <ScrollView contentContainerStyle={{ padding: 16, gap: 8 }}>
          {data?.length === 0 && <Empty text="نظری ثبت نشده است" />}
          {data?.map((c) => (
            <Card key={c.id}>
              <T bold size={13}>{c.full_name}</T>
              <T>{c.body}</T>
            </Card>
          ))}
        </ScrollView>
        {canPost && (
          <View style={{ padding: 16, gap: 8 }}>
            <Input placeholder="نظر شما…" value={text} onChangeText={setText} multiline />
            <Button
              title="ثبت نظر"
              disabled={!text.trim()}
              onPress={async () => {
                try {
                  await post(`/agenda-items/${item.id}/comments`, { body: text });
                  setText('');
                  void reload();
                } catch (e) {
                  setErr(e as Error);
                }
              }}
            />
          </View>
        )}
      </View>
    </Modal>
  );
}

function MinutesModal({ meetingId, onClose }: { meetingId: string; onClose: () => void }) {
  const t = useTheme();
  const { data, error, reload } = useApi(`/meetings/${meetingId}/minutes`);
  const [err, setErr] = useState<Error | null>(null);
  const [reason, setReason] = useState('');
  const act = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
      await reload();
    } catch (e) {
      setErr(e as Error);
    }
  };
  return (
    <Modal animationType="slide" onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: t.bg, paddingTop: 48 }}>
        <View style={{ paddingHorizontal: 16 }}>
          <Row>
            <T bold size={16}>صورتجلسه</T>
            <Button title="بستن" variant="ghost" onPress={onClose} />
          </Row>
          <ErrorText error={error ?? err} />
        </View>
        <ScrollView contentContainerStyle={{ padding: 16, gap: 8 }}>
          {!data ? (
            <Loading />
          ) : (
            <>
              <Card>
                <T size={14}>{data.body.replace(/^#+ /gm, '').replace(/\*\*/g, '')}</T>
              </Card>
              {data.status === 'pending_approval' && data.capabilities.includes('minutes.approve') && (
                <Card title="تأیید رئیس">
                  <Button title="تأیید و قفل صورتجلسه" variant="success" onPress={() => act(() => post(`/minutes/${data.id}/approve`))} />
                  <Input label="دلیل برگشت" value={reason} onChangeText={setReason} />
                  <Button title="برگشت برای اصلاح" variant="danger" disabled={reason.length < 3} onPress={() => act(() => post(`/minutes/${data.id}/return`, { reason }))} />
                </Card>
              )}
            </>
          )}
        </ScrollView>
      </View>
    </Modal>
  );
}


/** The invitee's representative for this meeting (introduce / revoke). */
function DelegateCard({ m, onChanged }: { m: any; onChanged: () => Promise<void> }) {
  const t = useTheme();
  const mine = (m.delegates ?? [])[0];
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ nationalId: '', birthDate: '', mobile: '', fullName: '' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<Error | null>(null);
  const [login, setLogin] = useState<any | null>(null);
  if (mine) {
    return (
      <Card>
        <Row>
          <T>
            نماینده شما: <T bold>{mine.delegate_name}</T>
          </T>
          <Button
            title="لغو"
            variant="ghost"
            onPress={() =>
              Alert.alert('لغو نماینده', `نماینده «${mine.delegate_name}» لغو شود؟`, [
                { text: 'خیر', style: 'cancel' },
                { text: 'لغو', style: 'destructive', onPress: () => void api(`/meetings/${m.id}/delegates/${mine.id}`, { method: 'DELETE', json: {} }).then(onChanged) },
              ])
            }
          />
        </Row>
      </Card>
    );
  }
  if (login) {
    return (
      <Card title="نماینده ثبت شد">
        <T>اطلاعات ورود نماینده (فقط همین یک‌بار نمایش داده می‌شود):</T>
        <T bold>نام کاربری: {login.username}</T>
        <T bold>رمز موقت: {login.temporaryPassword}</T>
        <Button title="بستن" variant="secondary" onPress={() => setLogin(null)} />
      </Card>
    );
  }
  if (!open) return <Button title="معرفی نماینده (اگر خودتان حاضر نمی‌شوید)" variant="secondary" onPress={() => setOpen(true)} />;
  return (
    <Card title="معرفی نماینده">
      <T muted size={12}>نماینده فقط در همین جلسه به‌جای شما حاضر می‌شود{m.settings.proxyCanVote ? ' و رأی می‌دهد' : ''}. مسئولیت مصوبات با خود شماست.</T>
      <ErrorText error={err} />
      <Input label="کد ملی نماینده" keyboardType="number-pad" maxLength={10} value={form.nationalId} onChangeText={(v) => setForm({ ...form, nationalId: v })} />
      <Input label="تاریخ تولد (شمسی)" placeholder="1365/01/01" value={form.birthDate} onChangeText={(v) => setForm({ ...form, birthDate: v })} />
      <Input label="موبایل نماینده" keyboardType="phone-pad" value={form.mobile} onChangeText={(v) => setForm({ ...form, mobile: v })} />
      <Input label="نام و نام خانوادگی" value={form.fullName} onChangeText={(v) => setForm({ ...form, fullName: v })} />
      {m.settings.requireDelegateLetter && <T color={t.warning} size={12}>این کمیسیون معرفی‌نامه رسمی می‌خواهد؛ آن را از نسخه وب بارگذاری کنید یا به دبیرخانه بفرستید.</T>}
      <Button
        title="ثبت نماینده"
        busy={busy}
        disabled={form.mobile.length < 11}
        onPress={async () => {
          setBusy(true);
          setErr(null);
          try {
            const r = await post(`/meetings/${m.id}/delegates`, {
              person: { nationalId: form.nationalId || null, birthDate: form.birthDate || null, mobile: form.mobile, fullName: form.fullName || null },
            });
            setOpen(false);
            if (r.login) setLogin(r.login);
            await onChanged();
          } catch (e) {
            setErr(e as Error);
          } finally {
            setBusy(false);
          }
        }}
      />
      <Button title="انصراف" variant="ghost" onPress={() => setOpen(false)} />
    </Card>
  );
}

// ─────────────────────────────── Documents, slides and photos ───────────────────────────────

const KIND_ICON: Record<string, string> = { presentation: '📊', photo: '🖼️', letter: '✉️', report: '📑' };
const VIEWABLE = ['application/pdf', 'image/png', 'image/jpeg', 'image/webp'];
const DOC_TYPES = [
  'application/pdf',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.openxmlformats-officedocument.presentationml.slideshow',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'image/*',
];

function MeetingDocuments({ m, canUpload, onChanged }: { m: any; canUpload: boolean; onChanged: () => Promise<void> | void }) {
  const t = useTheme();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<Error | null>(null);

  const send = async (files: { uri: string; name: string; type: string }[]) => {
    setError(null);
    const failed: string[] = [];
    for (const [i, f] of files.entries()) {
      setBusy(files.length > 1 ? `${fa(i + 1)} از ${fa(files.length)}` : '');
      try {
        await uploadFile({ meetingId: m.id }, f);
      } catch (e) {
        failed.push(`${f.name}: ${(e as Error).message}`);
      }
    }
    setBusy(null);
    if (failed.length) setError(new Error(failed.join('\n')));
    await onChanged();
  };

  const fromImages = (assets: ImagePicker.ImagePickerAsset[]) =>
    assets.map((a, i) => {
      const type = a.mimeType ?? 'image/jpeg';
      const ext = type === 'image/png' ? 'png' : type.includes('hei') ? 'heic' : 'jpg';
      const name = a.fileName ?? `جلسه-${m.number}-${Date.now()}-${i + 1}`;
      return { uri: a.uri, type, name: /\.\w{3,4}$/.test(name) ? name : `${name}.${ext}` };
    });

  const camera = async () => {
    const perm = await ImagePicker.requestCameraPermissionsAsync();
    if (!perm.granted) return setError(new Error('اجازه دسترسی به دوربین داده نشد'));
    const r = await ImagePicker.launchCameraAsync({ mediaTypes: ['images'], quality: 0.7 });
    if (!r.canceled) await send(fromImages(r.assets));
  };
  const gallery = async () => {
    const r = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 0.7, allowsMultipleSelection: true, selectionLimit: 10 });
    if (!r.canceled) await send(fromImages(r.assets));
  };
  const file = async () => {
    const r = await DocumentPicker.getDocumentAsync({ type: DOC_TYPES, multiple: true, copyToCacheDirectory: true });
    if (!r.canceled) await send(r.assets.map((a) => ({ uri: a.uri, name: a.name, type: a.mimeType ?? 'application/octet-stream' })));
  };

  const open = async (d: any) => {
    try {
      const { url } = await post(`/documents/${d.id}/link${VIEWABLE.includes(d.mime_type) ? '?inline=1' : ''}`);
      // Use the server address configured in the app; a reverse proxy may report a different host/port.
      await Linking.openURL(`${getApiUrl()}${String(url).replace(/^https?:\/\/[^/]+/, '')}`);
    } catch (e) {
      setError(e as Error);
    }
  };

  return (
    <Card title="مستندات، ارائه‌ها و عکس‌ها" right={m.documents.length ? <T muted size={12}>{fa(m.documents.length)} فایل</T> : undefined}>
      {m.documents.map((d: any) => (
        <Pressable key={d.id} onPress={() => void open(d)} style={{ paddingVertical: 6 }}>
          <T color={t.primary}>
            {KIND_ICON[d.kind] ?? '📄'} {d.title ?? d.file_name}
          </T>
        </Pressable>
      ))}
      {m.documents.length === 0 && <T muted>هنوز فایلی پیوست نشده است.</T>}
      {canUpload && (
        <View style={{ gap: 8, marginTop: 8 }}>
          {busy !== null ? (
            <T muted>در حال ارسال {busy}…</T>
          ) : (
            <>
              <Row style={{ gap: 8 }}>
                <View style={{ flex: 1 }}>
                  <Button title="📷 عکس" variant="secondary" onPress={() => void camera()} />
                </View>
                <View style={{ flex: 1 }}>
                  <Button title="🖼️ از گالری" variant="secondary" onPress={() => void gallery()} />
                </View>
              </Row>
              <Button title="📎 فایل PDF / پاورپوینت" variant="secondary" onPress={() => void file()} />
            </>
          )}
          <ErrorText error={error} />
          <T muted size={12}>فایل‌ها در آرشیو اسناد کمیسیون هم ذخیره می‌شوند.</T>
        </View>
      )}
    </Card>
  );
}
