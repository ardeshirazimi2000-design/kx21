import {
  ATTENDANCE_STATUS_LABELS,
  ATTENDANCE_STATUSES,
  INVITEE_ROLES,
  MEETING_TYPE_LABELS,
  ROLE_LABELS,
  VOTE_OPTION_LABELS,
  formatJalaliLong,
  formatTime,
  type AttendanceStatus,
  type InviteeRole,
  type MeetingType,
} from '@kx/shared';
import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { AgendaBadge, AttendanceBadge, MeetingStatusBadge, MinutesBadge, ResolutionBadge } from '../components/status';
import { Badge, Button, Card, dateFa, dateTimeFa, Empty, ErrorBox, Field, fa, JalaliDateInput, Loading, Modal, PageHeader, Tabs } from '../components/ui';
import { ApiError, del, download, get, post, upload } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useApi, useSocket } from '../lib/hooks';

type Tab = 'agenda' | 'attendance' | 'invitees' | 'documents' | 'minutes' | 'resolutions';

export function MeetingRoomPage() {
  const { id } = useParams();
  const { data: m, error, reload, setData } = useApi(`/meetings/${id}`);
  const [tab, setTab] = useState<Tab>('agenda');
  const [actionError, setActionError] = useState<ApiError | null>(null);
  const [flash, setFlash] = useState<Set<string>>(new Set());
  const timer = useRef<number | undefined>(undefined);
  const reloadSoon = () => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => void reload(), 150);
  };

  const connected = useSocket(
    {
      reconnect: reloadSoon,
      'meeting.updated': reloadSoon,
      'agenda.updated': reloadSoon,
      'vote.opened': reloadSoon,
      'vote.closed': reloadSoon,
      'vote.progress': (p) =>
        setData((d: any) => d && { ...d, votes: d.votes.map((v: any) => (v.id === p.voteSessionId ? { ...v, cast_count: p.castCount, eligible: p.eligible } : v)) }),
      'attendance.updated': (p) => {
        setData((d: any) => {
          if (!d) return d;
          const changed = p.attendance.filter((a: any) => {
            const prev = d.invitees.find((x: any) => x.user_id === a.user_id);
            return prev && prev.status !== a.status;
          });
          if (changed.length) {
            setFlash(new Set(changed.map((c: any) => c.user_id)));
            window.setTimeout(() => setFlash(new Set()), 1500);
          }
          return { ...d, invitees: p.attendance, quorum: p.quorum };
        });
      },
      'quorum.updated': (p) => setData((d: any) => (d && !d.capabilities.includes('attendance.view_all') ? { ...d, quorum: p.quorum } : d)),
    },
    id,
  );

  if (error) return <ErrorBox error={error} />;
  if (!m) return <Loading />;
  const caps: string[] = m.capabilities;
  const can = (c: string) => caps.includes(c);
  const run = async (fn: () => Promise<unknown>) => {
    setActionError(null);
    try {
      await fn();
      await reload();
    } catch (e) {
      setActionError(e as ApiError);
    }
  };
  const act = (action: string) => m.availableActions.includes(action);

  const tabs: { id: Tab; label: string }[] = [{ id: 'agenda', label: 'دستور جلسه' }];
  if (can('attendance.view_all')) tabs.push({ id: 'attendance', label: 'حاضرین و نصاب' });
  tabs.push({ id: 'invitees', label: `مدعوین (${fa(m.invitees.length)})` }, { id: 'documents', label: 'مستندات' });
  if (m.minutes) tabs.push({ id: 'minutes', label: 'صورتجلسه' });
  if (['minutes_draft', 'pending_approval', 'approved', 'archived', 'agenda_processing', 'in_progress'].includes(m.status)) tabs.push({ id: 'resolutions', label: 'مصوبات' });

  const myAtt: AttendanceStatus | undefined = m.my.attendance?.status;
  const attending = myAtt && ['present', 'online', 'proxy', 'manual_present'].includes(myAtt);

  return (
    <>
      <PageHeader
        title={
          <span className="row gap-sm wrap">
            {m.title} <MeetingStatusBadge status={m.status} />
          </span>
        }
        subtitle={
          <>
            <Link to={`/commissions/${m.commission.id}`}>{m.commission.name}</Link> — جلسه شماره {fa(m.number)} — {formatJalaliLong(m.scheduled_at)} ساعت{' '}
            {formatTime(m.scheduled_at)} — {MEETING_TYPE_LABELS[m.type as MeetingType]}
            {m.location ? ` — ${m.location}` : ''}
            {m.online_link && (
              <>
                {' '}
                — <a href={m.online_link} target="_blank" rel="noreferrer">ورود به جلسه آنلاین</a>
              </>
            )}
            <span className="row gap-sm small" style={{ display: 'inline-flex', marginInlineStart: 8 }}>
              <span className={`dot ${connected ? 'dot-live' : 'dot-off'}`} /> {connected ? 'به‌روزرسانی زنده' : 'قطع ارتباط زنده'}
            </span>
          </>
        }
        actions={
          <>
            {m.my.role && m.checkinOpen && !attending && (
              <Button variant="success" onClick={() => run(() => post(`/meetings/${id}/check-in`, { method: 'web' }))}>
                اعلام حضور من
              </Button>
            )}
            {attending && <AttendanceBadge status={myAtt!} />}
            <Button variant="secondary" onClick={() => download(`/meetings/${id}/ics`, 'meeting.ics')}>
              افزودن به تقویم
            </Button>
            {can('meeting.manage') && act('schedule') && <Button onClick={() => run(() => post(`/meetings/${id}/schedule`))}>نهایی‌سازی برنامه</Button>}
            {can('meeting.manage') && act('send_invitations') && <Button onClick={() => run(() => post(`/meetings/${id}/invite`))}>ارسال دعوت‌نامه</Button>}
            {can('meeting.manage') && act('open_checkin') && <Button variant="secondary" onClick={() => run(() => post(`/meetings/${id}/checkin/open`))}>باز کردن اعلام حضور</Button>}
            {can('meeting.manage') && m.checkinOpen && ['in_progress', 'agenda_processing'].includes(m.status) && (
              <Button variant="secondary" onClick={() => run(() => post(`/meetings/${id}/checkin/close`))}>بستن اعلام حضور</Button>
            )}
            {can('meeting.control') && act('start') && <Button variant="success" onClick={() => run(() => post(`/meetings/${id}/start`))}>شروع رسمی جلسه</Button>}
            {can('meeting.control') && act('end') && (
              <Button variant="danger" onClick={() => confirm('جلسه خاتمه یابد و پیش‌نویس صورتجلسه تولید شود؟') && run(() => post(`/meetings/${id}/end`))}>
                پایان جلسه
              </Button>
            )}
            {can('meeting.manage') && act('cancel') && (
              <Button
                variant="ghost"
                onClick={() => {
                  const reason = prompt('دلیل لغو جلسه:');
                  if (reason) void run(() => post(`/meetings/${id}/cancel`, { reason }));
                }}
              >
                لغو جلسه
              </Button>
            )}
            {can('meeting.manage') && act('archive') && <Button variant="secondary" onClick={() => run(() => post(`/meetings/${id}/archive`))}>بایگانی</Button>}
          </>
        }
      />
      <ErrorBox error={actionError} />
      {m.status === 'cancelled' && <div className="alert alert-danger">این جلسه لغو شده است. دلیل: {m.cancel_reason}</div>}
      <QuorumPanel quorum={m.quorum} detailed={can('attendance.view_all')} />
      <div className="mt" />
      <Tabs tabs={tabs} value={tab} onChange={setTab} />
      {tab === 'agenda' && <Agenda m={m} run={run} reload={reload} />}
      {tab === 'attendance' && <Attendance m={m} flash={flash} run={run} />}
      {tab === 'invitees' && <Invitees m={m} run={run} />}
      {tab === 'documents' && <Documents m={m} />}
      {tab === 'minutes' && <Minutes m={m} reloadMeeting={reload} />}
      {tab === 'resolutions' && <MeetingResolutions m={m} />}
    </>
  );
}

function QuorumPanel({ quorum, detailed }: { quorum: any; detailed: boolean }) {
  return (
    <div className={`quorum ${quorum.reached ? 'quorum-ok' : 'quorum-no'}`}>
      <div className="big">
        {fa(quorum.present)}/{fa(quorum.eligible)}
      </div>
      <div className="grow">
        <strong>{quorum.reached ? 'حد نصاب حاصل شد' : 'حد نصاب حاصل نشده است'}</strong>
        <div className="small">
          حاضرین دارای حق رأی: {fa(quorum.present)} — حد نصاب لازم: {fa(quorum.required)} — کل حاضرین: {fa(quorum.attendingTotal)}
        </div>
        {detailed && quorum.explanation && <div className="small">{fa(quorum.explanation)}</div>}
      </div>
    </div>
  );
}

// ─────────────────────────────── Agenda + votes ───────────────────────────────

function Agenda({ m, run, reload }: { m: any; run: (fn: () => Promise<unknown>) => Promise<void>; reload: () => Promise<void> }) {
  const can = (c: string) => m.capabilities.includes(c);
  const live = ['in_progress', 'agenda_processing'].includes(m.status);
  const editable = ['draft', 'scheduled', 'invitation_sent', 'checkin_open'].includes(m.status) || live;
  const [newItem, setNewItem] = useState('');
  const [completing, setCompleting] = useState<any | null>(null);
  const [commentsFor, setCommentsFor] = useState<string | null>(null);
  const active = m.agenda.find((a: any) => a.status === 'active');
  return (
    <div className="grid" style={{ gridTemplateColumns: 'minmax(0, 2fr) minmax(0, 1fr)' }}>
      <div>
        {active && live && (
          <div className="alert alert-info">
            آیتم در حال بررسی: <strong>{active.title}</strong>
          </div>
        )}
        {m.agenda.length === 0 && <Empty>دستور جلسه‌ای ثبت نشده است.</Empty>}
        {m.agenda.map((item: any, idx: number) => {
          const votes = m.votes.filter((v: any) => v.agenda_item_id === item.id);
          const openVote = votes.find((v: any) => v.status === 'open');
          return (
            <div key={item.id} className={`agenda-item ${item.status}`}>
              <div className="row between gap wrap">
                <div>
                  <strong>
                    {fa(idx + 1)}. {item.title}
                  </strong>
                  <div className="muted small">
                    {item.presenter_full_name ?? item.presenter_name ? `ارائه‌دهنده: ${item.presenter_full_name ?? item.presenter_name} — ` : ''}
                    {item.duration_minutes ? `${fa(item.duration_minutes)} دقیقه` : ''}
                  </div>
                </div>
                <div className="row gap-sm wrap">
                  <AgendaBadge status={item.status} />
                  {can('meeting.control') && live && item.status !== 'active' && item.status !== 'removed' && (
                    <Button size="sm" onClick={() => run(() => post(`/meetings/${m.id}/agenda/${item.id}/activate`))}>
                      فعال‌سازی
                    </Button>
                  )}
                  {can('meeting.control') && live && item.status === 'active' && !openVote && (
                    <>
                      <VoteStarter item={item} defaultSecret={m.settings.secretVoteDefault} run={run} />
                      <Button size="sm" variant="secondary" onClick={() => setCompleting(item)}>
                        ثبت نتیجه و خاتمه
                      </Button>
                    </>
                  )}
                  {can('meeting.manage') && editable && item.status === 'pending' && !live && (
                    <Button size="sm" variant="ghost" onClick={() => run(() => del(`/agenda-items/${item.id}`))}>
                      حذف
                    </Button>
                  )}
                </div>
              </div>
              {item.description && <p className="small pre">{item.description}</p>}
              {item.discussion_summary && (
                <p className="small">
                  <strong>خلاصه مذاکرات:</strong> {item.discussion_summary}
                </p>
              )}
              {item.decision && (
                <p className="small">
                  <strong>تصمیم:</strong> {item.decision}
                </p>
              )}
              {votes.map((v: any) => (
                <VotePanel key={v.id} v={v} m={m} run={run} />
              ))}
              <Button size="sm" variant="ghost" onClick={() => setCommentsFor(commentsFor === item.id ? null : item.id)}>
                نظرات ({fa(item.comment_count)})
              </Button>
              {commentsFor === item.id && <Comments itemId={item.id} canPost={can('comment.create') && m.settings.allowComments} onPosted={reload} />}
            </div>
          );
        })}
        {can('meeting.manage') && editable && (
          <div className="row gap-sm mt">
            <input className="input" placeholder="عنوان آیتم جدید دستور جلسه" value={newItem} onChange={(e) => setNewItem(e.target.value)} />
            <Button
              disabled={newItem.trim().length < 2}
              onClick={() =>
                run(async () => {
                  await post(`/meetings/${m.id}/agenda`, { title: newItem });
                  setNewItem('');
                })
              }
            >
              افزودن
            </Button>
          </div>
        )}
      </div>
      <Card title="اطلاعات جلسه">
        <ul className="list small">
          <li>نقش من: {m.my.role ? ROLE_LABELS[m.my.role as InviteeRole] : 'ناظر/مدیر'}</li>
          <li>حق رأی: {m.my.hasVote ? 'دارد' : 'ندارد'}</li>
          <li>وضعیت حضور من: {m.my.attendance ? ATTENDANCE_STATUS_LABELS[m.my.attendance.status as AttendanceStatus] : '—'}</li>
          <li>اعلام حضور: {m.checkinOpen ? 'باز' : 'بسته'}</li>
          {m.started_at && <li>شروع: {dateTimeFa(m.started_at)}</li>}
          {m.ended_at && <li>پایان: {dateTimeFa(m.ended_at)}</li>}
          <li>قاعده تصویب: {({ majority_of_present: 'اکثریت مطلق حاضرین', majority_of_cast: 'اکثریت آرای مأخوذه', simple_majority: 'موافق بیشتر از مخالف', two_thirds_of_present: 'دو سوم حاضرین' } as Record<string, string>)[m.settings.passRule]}</li>
        </ul>
      </Card>
      {completing && <CompleteModal item={completing} m={m} onClose={() => setCompleting(null)} onDone={() => { setCompleting(null); void reload(); }} />}
    </div>
  );
}

function VoteStarter({ item, defaultSecret, run }: { item: any; defaultSecret: boolean; run: (fn: () => Promise<unknown>) => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [secret, setSecret] = useState(defaultSecret);
  const [title, setTitle] = useState(`رأی‌گیری: ${item.title}`);
  return (
    <>
      <Button size="sm" variant="success" onClick={() => setOpen(true)}>
        شروع رأی‌گیری
      </Button>
      {open && (
        <Modal
          title="شروع رأی‌گیری"
          onClose={() => setOpen(false)}
          footer={<Button onClick={() => run(() => post(`/agenda-items/${item.id}/vote/start`, { title, secret })).then(() => setOpen(false))}>شروع</Button>}
        >
          <Field label="عنوان">
            <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} />
          </Field>
          <label className="check">
            <input type="checkbox" checked={secret} onChange={(e) => setSecret(e.target.checked)} /> رأی مخفی (هویت رأی‌دهندگان نمایش داده نمی‌شود)
          </label>
          <p className="muted small">گزینه‌ها: موافق، مخالف، ممتنع</p>
        </Modal>
      )}
    </>
  );
}

function VotePanel({ v, m, run }: { v: any; m: any; run: (fn: () => Promise<unknown>) => Promise<void> }) {
  const can = (c: string) => m.capabilities.includes(c);
  const eligible = v.eligible ?? m.quorum.present;
  const [voters, setVoters] = useState<any[] | null>(null);
  useEffect(() => {
    if (v.status === 'closed' && !v.secret && can('vote.results.view')) {
      void get(`/vote-sessions/${v.id}`).then((d) => setVoters(d.voters));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [v.status, v.id]);
  const r = v.result;
  return (
    <div className="card" style={{ marginTop: 8, padding: 12 }}>
      <div className="row between wrap gap-sm">
        <strong>
          {v.title} {v.secret && <Badge tone="accent">مخفی</Badge>}
        </strong>
        {v.status === 'open' ? <Badge tone="success">در حال رأی‌گیری</Badge> : <Badge>بسته شده</Badge>}
      </div>
      {v.status === 'open' && (
        <>
          <div className="small muted">
            آرای ثبت‌شده: {fa(v.cast_count)} از {fa(eligible)} ({fa(eligible ? Math.round((v.cast_count / eligible) * 100) : 0)}٪ مشارکت)
          </div>
          {can('vote.cast') && !v.my_choice && (
            <div className="row gap-sm mt">
              {(v.options as string[]).map((o) => (
                <Button key={o} variant={o === 'yes' ? 'success' : o === 'no' ? 'danger' : 'secondary'} onClick={() => run(() => post(`/agenda-items/${v.agenda_item_id}/vote`, { choice: o, voteSessionId: v.id }))}>
                  {VOTE_OPTION_LABELS[o] ?? o}
                </Button>
              ))}
            </div>
          )}
          {v.my_choice && <div className="alert alert-success small mt">رأی شما ثبت شد: {VOTE_OPTION_LABELS[v.my_choice] ?? v.my_choice}</div>}
          {can('meeting.control') && (
            <Button size="sm" variant="danger" className="mt" onClick={() => run(() => post(`/vote-sessions/${v.id}/close`))}>
              پایان رأی‌گیری و اعلام نتیجه
            </Button>
          )}
        </>
      )}
      {v.status === 'closed' && r && (
        <>
          <div className="vote-bar">
            {(['yes', 'no', 'abstain'] as const).map((o) =>
              r.counts[o] ? (
                <div key={o} className={`vote-${o}`} style={{ width: `${(r.counts[o] / Math.max(1, r.totalCast)) * 100}%` }}>
                  {VOTE_OPTION_LABELS[o]} {fa(r.counts[o])}
                </div>
              ) : null,
            )}
          </div>
          <div className="row gap-sm wrap small">
            <Badge tone={r.passed ? 'success' : 'danger'}>{r.passed ? 'تصویب شد' : 'تصویب نشد'}</Badge>
            <span className="muted">
              مشارکت {fa(r.participationPercent)}٪ — {fa(r.totalCast)} رأی از {fa(r.eligiblePresent)} حاضر
            </span>
            {v.my_choice && <span>رأی من: {VOTE_OPTION_LABELS[v.my_choice]}</span>}
          </div>
          {voters && (
            <div className="small muted mt">
              {voters.map((x) => `${x.full_name}: ${VOTE_OPTION_LABELS[x.choice] ?? x.choice}${x.is_valid ? '' : ' (ابطال)'}`).join(' — ')}
            </div>
          )}
        </>
      )}
      {v.status === 'closed' && !r && <div className="muted small">نتیجه این رأی‌گیری فقط برای رئیس و دبیر قابل مشاهده است.</div>}
    </div>
  );
}

function CompleteModal({ item, m, onClose, onDone }: { item: any; m: any; onClose: () => void; onDone: () => void }) {
  const [form, setForm] = useState({
    status: 'done',
    discussionSummary: item.discussion_summary ?? '',
    decision: item.decision ?? '',
    proposedResolution: item.proposed_resolution ?? '',
  });
  const members = useApi<any[]>(form.status === 'referred' ? `/commissions/${m.commission.id}/members` : null);
  const [ref, setRef] = useState({ expertId: '', request: '', dueDate: '' });
  const [err, setErr] = useState<Error | null>(null);
  const save = async () => {
    try {
      await post(`/agenda-items/${item.id}/complete`, {
        ...form,
        referral: form.status === 'referred' && ref.expertId ? { ...ref, dueDate: ref.dueDate || null } : undefined,
      });
      onDone();
    } catch (e) {
      setErr(e as Error);
    }
  };
  return (
    <Modal title={`ثبت نتیجه — ${item.title}`} wide onClose={onClose} footer={<Button onClick={save}>ثبت و خاتمه آیتم</Button>}>
      <ErrorBox error={err} />
      <Field label="نتیجه">
        <select className="input" value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })}>
          <option value="done">خاتمه‌یافته</option>
          <option value="referred">ارجاع به کارشناسی</option>
          <option value="removed">حذف از دستور</option>
        </select>
      </Field>
      <Field label="خلاصه مذاکرات">
        <textarea className="input" value={form.discussionSummary} onChange={(e) => setForm({ ...form, discussionSummary: e.target.value })} />
      </Field>
      <Field label="تصمیم جلسه">
        <textarea className="input" value={form.decision} onChange={(e) => setForm({ ...form, decision: e.target.value })} />
      </Field>
      <Field label="مصوبه پیشنهادی">
        <textarea className="input" value={form.proposedResolution} onChange={(e) => setForm({ ...form, proposedResolution: e.target.value })} />
      </Field>
      {form.status === 'referred' && (
        <div className="grid grid-3">
          <Field label="کارشناس">
            <select className="input" value={ref.expertId} onChange={(e) => setRef({ ...ref, expertId: e.target.value })}>
              <option value="">انتخاب</option>
              {members.data
                ?.filter((x) => x.position === 'expert')
                .map((x) => (
                  <option key={x.user_id} value={x.user_id}>
                    {x.full_name}
                  </option>
                ))}
            </select>
          </Field>
          <Field label="شرح ارجاع">
            <input className="input" value={ref.request} onChange={(e) => setRef({ ...ref, request: e.target.value })} />
          </Field>
          <Field label="مهلت">
            <JalaliDateInput value={ref.dueDate} onChange={(v) => setRef({ ...ref, dueDate: v })} />
          </Field>
        </div>
      )}
    </Modal>
  );
}

function Comments({ itemId, canPost, onPosted }: { itemId: string; canPost: boolean; onPosted: () => void }) {
  const { data, reload, setData } = useApi<any[]>(`/agenda-items/${itemId}/comments`);
  const [text, setText] = useState('');
  useSocket({ 'comment.created': (c) => c.agenda_item_id === itemId && setData((d) => (d && !d.some((x) => x.id === c.id) ? [...d, c] : d)) });
  return (
    <div className="mt">
      {data?.length === 0 && <div className="muted small">نظری ثبت نشده است.</div>}
      <ul className="list small">
        {data?.map((c) => (
          <li key={c.id}>
            <strong>{c.full_name}</strong> <span className="muted">{dateTimeFa(c.created_at)}</span>
            <div className="pre">{c.body}</div>
          </li>
        ))}
      </ul>
      {canPost && (
        <div className="row gap-sm">
          <input className="input" placeholder="نظر شما…" value={text} onChange={(e) => setText(e.target.value)} />
          <Button
            size="sm"
            disabled={!text.trim()}
            onClick={async () => {
              await post(`/agenda-items/${itemId}/comments`, { body: text });
              setText('');
              void reload();
              onPosted();
            }}
          >
            ثبت
          </Button>
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────── Attendance ───────────────────────────────

function Attendance({ m, flash, run }: { m: any; flash: Set<string>; run: (fn: () => Promise<unknown>) => Promise<void> }) {
  const [editing, setEditing] = useState<any | null>(null);
  const canEdit = m.capabilities.includes('meeting.manage') && !['draft', 'cancelled', 'approved', 'archived', 'pending_approval'].includes(m.status);
  const groups: [string, (a: any) => boolean][] = [
    ['دارای حق رأی', (a) => a.has_vote],
    ['سایر حاضرین (بدون حق رأی)', (a) => !a.has_vote],
  ];
  return (
    <>
      <div className="row gap-sm wrap mb">
        {Object.entries(m.quorum.breakdown ?? {}).map(([k, v]) =>
          (v as number) > 0 ? (
            <Badge key={k}>
              {ATTENDANCE_STATUS_LABELS[k as AttendanceStatus]}: {fa(v as number)}
            </Badge>
          ) : null,
        )}
      </div>
      {groups.map(([label, pred]) => (
        <Card key={label} title={label}>
          <div className="att-grid">
            {m.invitees.filter(pred).map((a: any) => (
              <div key={a.user_id} className={`att ${flash.has(a.user_id) ? 'flash' : ''}`}>
                <div>
                  <div>{a.full_name}</div>
                  <div className="muted small">
                    {ROLE_LABELS[a.role as InviteeRole]}
                    {a.checked_in_at ? ` — ${formatTime(a.checked_in_at)}` : ''}
                    {a.proxy_name ? ` — نماینده: ${a.proxy_name}` : ''}
                  </div>
                </div>
                <div className="col" style={{ alignItems: 'flex-end', gap: 4 }}>
                  <AttendanceBadge status={a.status} />
                  {canEdit && (
                    <button className="btn btn-ghost btn-sm" onClick={() => setEditing(a)}>
                      اصلاح
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </Card>
      ))}
      {editing && (
        <AttendanceModal
          a={editing}
          allowProxy={m.settings.allowProxy}
          onClose={() => setEditing(null)}
          onSave={(body) => run(() => post(`/meetings/${m.id}/attendance/${editing.user_id}/confirm`, body)).then(() => setEditing(null))}
        />
      )}
    </>
  );
}

function AttendanceModal({ a, allowProxy, onClose, onSave }: { a: any; allowProxy: boolean; onClose: () => void; onSave: (b: any) => void }) {
  const [status, setStatus] = useState<AttendanceStatus>(a.status === 'pending' ? 'manual_present' : a.status);
  const [reason, setReason] = useState('');
  const [proxyName, setProxyName] = useState(a.proxy_name ?? '');
  return (
    <Modal title={`ثبت/اصلاح حضور — ${a.full_name}`} onClose={onClose} footer={<Button disabled={reason.trim().length < 2} onClick={() => onSave({ status, reason, proxyName: status === 'proxy' ? proxyName : undefined })}>ثبت</Button>}>
      <Field label="وضعیت">
        <select className="input" value={status} onChange={(e) => setStatus(e.target.value as AttendanceStatus)}>
          {ATTENDANCE_STATUSES.filter((s) => allowProxy || s !== 'proxy').map((s) => (
            <option key={s} value={s}>
              {ATTENDANCE_STATUS_LABELS[s]}
            </option>
          ))}
        </select>
      </Field>
      {status === 'proxy' && (
        <Field label="نام نماینده">
          <input className="input" value={proxyName} onChange={(e) => setProxyName(e.target.value)} />
        </Field>
      )}
      <Field label="دلیل اصلاح (الزامی؛ در رویدادنگاری ثبت می‌شود)">
        <input className="input" value={reason} onChange={(e) => setReason(e.target.value)} />
      </Field>
    </Modal>
  );
}

// ─────────────────────────────── Invitees ───────────────────────────────

function Invitees({ m, run }: { m: any; run: (fn: () => Promise<unknown>) => Promise<void> }) {
  const { chamberId } = useAuth();
  const canManage = m.capabilities.includes('meeting.manage') && ['draft', 'scheduled', 'invitation_sent', 'checkin_open', 'in_progress', 'agenda_processing'].includes(m.status);
  const [q, setQ] = useState('');
  const [role, setRole] = useState<InviteeRole>('guest');
  const people = useApi(canManage && q.length >= 2 ? `/people?chamberId=${chamberId}&q=${encodeURIComponent(q)}&pageSize=6` : null);
  const preStart = ['draft', 'scheduled', 'invitation_sent', 'checkin_open'].includes(m.status);
  return (
    <Card title="مدعوین جلسه">
      <table className="table">
        <thead>
          <tr>
            <th>نام</th>
            <th>سازمان</th>
            <th>نقش</th>
            {m.invitees[0]?.status !== undefined && <th>حق رأی</th>}
            <th />
          </tr>
        </thead>
        <tbody>
          {m.invitees.map((a: any) => (
            <tr key={a.user_id}>
              <td>{a.full_name}</td>
              <td>{a.organization}</td>
              <td>{ROLE_LABELS[a.role as InviteeRole]}</td>
              {a.status !== undefined && <td>{a.has_vote ? '✓' : '—'}</td>}
              <td>
                {canManage && preStart && (
                  <Button size="sm" variant="ghost" onClick={() => run(() => del(`/meetings/${m.id}/invitees/${a.user_id}`))}>
                    حذف
                  </Button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {canManage && (
        <div className="mt">
          <h3 className="mb">افزودن مدعو</h3>
          <div className="row gap-sm">
            <input className="input" placeholder="جستجوی شخص" value={q} onChange={(e) => setQ(e.target.value)} />
            <select className="input" style={{ maxWidth: 150 }} value={role} onChange={(e) => setRole(e.target.value as InviteeRole)}>
              {INVITEE_ROLES.map((r) => (
                <option key={r} value={r}>
                  {ROLE_LABELS[r]}
                </option>
              ))}
            </select>
          </div>
          <ul className="list">
            {people.data?.items
              .filter((p: any) => !m.invitees.some((i: any) => i.user_id === p.id))
              .map((p: any) => (
                <li key={p.id} className="row between">
                  <span>
                    {p.full_name} <span className="muted small">{p.organization}</span>
                  </span>
                  <Button size="sm" onClick={() => run(() => post(`/meetings/${m.id}/invitees`, { userId: p.id, role }))}>
                    دعوت
                  </Button>
                </li>
              ))}
          </ul>
        </div>
      )}
    </Card>
  );
}

// ─────────────────────────────── Documents ───────────────────────────────

function Documents({ m }: { m: any }) {
  const { data, reload } = useApi<any[]>(`/documents?meetingId=${m.id}`);
  const canUpload = m.capabilities.includes('meeting.manage');
  const [target, setTarget] = useState('');
  const [err, setErr] = useState<Error | null>(null);
  const [busy, setBusy] = useState(false);
  const onFile = async (f: File | undefined) => {
    if (!f) return;
    setBusy(true);
    setErr(null);
    try {
      await upload(target ? { agendaItemId: target } : { meetingId: m.id }, f);
      void reload();
    } catch (e) {
      setErr(e as Error);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card title="مستندات جلسه">
      <ErrorBox error={err} />
      {canUpload && (
        <div className="row gap-sm mb wrap">
          <select className="input" style={{ maxWidth: 320 }} value={target} onChange={(e) => setTarget(e.target.value)}>
            <option value="">پیوست کل جلسه</option>
            {m.agenda.map((a: any) => (
              <option key={a.id} value={a.id}>
                آیتم: {a.title}
              </option>
            ))}
          </select>
          <label className="btn btn-secondary">
            {busy ? 'در حال بارگذاری…' : 'انتخاب فایل'}
            <input type="file" hidden accept=".pdf,.docx,.xlsx,.pptx,.doc,.xls,.png,.jpg,.jpeg,.txt" onChange={(e) => void onFile(e.target.files?.[0])} />
          </label>
          <span className="muted small">PDF، Word، Excel، PowerPoint، تصویر — حداکثر ۲۰ مگابایت</span>
        </div>
      )}
      {data?.length === 0 && <Empty>مستندی بارگذاری نشده است.</Empty>}
      <ul className="list">
        {data?.map((d) => (
          <li key={d.id} className="row between gap">
            <span>
              <a href="#" onClick={(e) => { e.preventDefault(); void download(`/documents/${d.id}/download`, d.file_name); }}>
                {d.title ?? d.file_name}
              </a>
              {d.agenda_item_id && <span className="muted small"> — {m.agenda.find((a: any) => a.id === d.agenda_item_id)?.title}</span>}
            </span>
            <span className="muted small">
              {fa(Math.ceil(d.size_bytes / 1024))} KB — {d.owner_name} — {dateFa(d.created_at)}
            </span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

// ─────────────────────────────── Minutes ───────────────────────────────

function renderMarkdown(md: string) {
  // Minimal, safe renderer (escapes HTML) for headings, bold and lists.
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const inline = (s: string) => esc(s).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  const out: string[] = [];
  let inList = false;
  for (const line of md.split('\n')) {
    const li = line.match(/^- (.*)/);
    if (li) {
      if (!inList) out.push('<ul>');
      inList = true;
      out.push(`<li>${inline(li[1])}</li>`);
      continue;
    }
    if (inList) {
      out.push('</ul>');
      inList = false;
    }
    const h = line.match(/^(#{1,3}) (.*)/);
    if (h) out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`);
    else if (line.trim() === '---') out.push('<hr/>');
    else if (line.trim()) out.push(`<p>${inline(line)}</p>`);
  }
  if (inList) out.push('</ul>');
  return out.join('');
}

function Minutes({ m, reloadMeeting }: { m: any; reloadMeeting: () => Promise<void> }) {
  const { data, error, reload } = useApi(`/meetings/${m.id}/minutes`);
  const [editing, setEditing] = useState(false);
  const [body, setBody] = useState('');
  const [err, setErr] = useState<Error | null>(null);
  if (error) return <ErrorBox error={error} />;
  if (!data) return <Loading />;
  const can = (c: string) => data.capabilities.includes(c);
  const act = async (fn: () => Promise<unknown>) => {
    setErr(null);
    try {
      await fn();
      setEditing(false);
      await reload();
      await reloadMeeting();
    } catch (e) {
      setErr(e as Error);
    }
  };
  const draft = m.status === 'minutes_draft';
  return (
    <Card
      title={
        <span className="row gap-sm">
          صورتجلسه <MinutesBadge status={data.status} /> <span className="muted small">نسخه {fa(data.version)}</span>
          {data.minutes_number && <Badge tone="success">شماره {fa(data.minutes_number)}</Badge>}
        </span>
      }
      actions={
        <>
          {can('meeting.manage') && draft && !editing && (
            <>
              <Button variant="secondary" onClick={() => { setBody(data.body); setEditing(true); }}>
                ویرایش
              </Button>
              <Button variant="secondary" onClick={() => act(() => post(`/meetings/${m.id}/minutes`, { regenerate: true }))}>
                تولید مجدد از داده‌های جلسه
              </Button>
              <Button onClick={() => act(() => post(`/minutes/${data.id}/submit`))}>ارسال برای تأیید رئیس</Button>
            </>
          )}
          {can('minutes.approve') && data.status === 'pending_approval' && (
            <>
              <Button variant="success" onClick={() => confirm('با تأیید، صورتجلسه قفل و شماره‌گذاری می‌شود. ادامه؟') && act(() => post(`/minutes/${data.id}/approve`))}>
                تأیید و قفل
              </Button>
              <Button
                variant="danger"
                onClick={() => {
                  const reason = prompt('دلیل برگشت برای اصلاح:');
                  if (reason) void act(() => post(`/minutes/${data.id}/return`, { reason }));
                }}
              >
                برگشت برای اصلاح
              </Button>
            </>
          )}
        </>
      }
    >
      <ErrorBox error={err} />
      {data.return_reason && data.status !== 'approved' && <div className="alert alert-warning">برگشت داده شد: {data.return_reason}</div>}
      {editing ? (
        <>
          <textarea className="input" style={{ minHeight: 420, fontFamily: 'inherit' }} value={body} onChange={(e) => setBody(e.target.value)} />
          <div className="row gap-sm mt">
            <Button onClick={() => act(() => post(`/meetings/${m.id}/minutes`, { body }))}>ذخیره نسخه جدید</Button>
            <Button variant="ghost" onClick={() => setEditing(false)}>
              انصراف
            </Button>
          </div>
        </>
      ) : (
        <div className="minutes-preview" dangerouslySetInnerHTML={{ __html: renderMarkdown(data.body) }} />
      )}
      {data.content_hash && <p className="muted small ltr mt">SHA-256: {data.content_hash}</p>}
      {data.versions?.length > 0 && (
        <p className="muted small">
          تاریخچه نسخه‌ها: {data.versions.map((v: any) => `نسخه ${fa(v.version)} (${v.edited_by ?? 'سامانه'} — ${dateTimeFa(v.created_at)})`).join('، ')}
        </p>
      )}
    </Card>
  );
}

// ─────────────────────────────── Resolutions of the meeting ───────────────────────────────

function MeetingResolutions({ m }: { m: any }) {
  const { data, reload } = useApi(`/resolutions?meetingId=${m.id}&pageSize=100`);
  const canManage = m.capabilities.includes('resolution.manage');
  const [creating, setCreating] = useState<any | null>(null);
  const passed = m.votes.filter((v: any) => v.status === 'closed' && v.result?.passed);
  return (
    <Card title="مصوبات این جلسه" actions={canManage && <Button onClick={() => setCreating({})}>ثبت مصوبه</Button>}>
      {canManage && passed.length > 0 && (
        <div className="alert alert-info">
          رأی‌گیری‌های تصویب‌شده:{' '}
          {passed.map((v: any) => (
            <Button key={v.id} size="sm" variant="ghost" onClick={() => setCreating({ vote: v })}>
              ایجاد مصوبه از «{v.title}»
            </Button>
          ))}
        </div>
      )}
      {data?.items.length === 0 && <Empty>مصوبه‌ای ثبت نشده است.</Empty>}
      <table className="table">
        <tbody>
          {data?.items.map((r: any) => (
            <tr key={r.id}>
              <td>
                <Link to={`/resolutions/${r.id}`}>{fa(r.number)}</Link>
              </td>
              <td>{r.text}</td>
              <td>{r.owner_name ?? '—'}</td>
              <td>{dateFa(r.due_date)}</td>
              <td>
                <ResolutionBadge status={r.status} overdue={r.is_overdue} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {creating && <NewResolutionModal m={m} vote={creating.vote} onClose={() => setCreating(null)} onSaved={() => { setCreating(null); void reload(); }} />}
    </Card>
  );
}

function NewResolutionModal({ m, vote, onClose, onSaved }: { m: any; vote?: any; onClose: () => void; onSaved: () => void }) {
  const item = vote ? m.agenda.find((a: any) => a.id === vote.agenda_item_id) : null;
  const [form, setForm] = useState({
    agendaItemId: item?.id ?? '',
    text: item?.proposed_resolution ?? item?.decision ?? '',
    ownerId: '',
    addressee: '',
    dueDate: '',
    priority: 'normal',
    kpi: '',
  });
  const members = useApi<any[]>(`/commissions/${m.commission.id}/members`);
  const [err, setErr] = useState<Error | null>(null);
  const save = async () => {
    try {
      await post('/resolutions', {
        commissionId: m.commission.id,
        meetingId: m.id,
        agendaItemId: form.agendaItemId || null,
        voteSessionId: vote?.id ?? null,
        text: form.text,
        ownerId: form.ownerId || null,
        addressee: form.addressee || null,
        dueDate: form.dueDate || null,
        priority: form.priority,
        kpi: form.kpi || null,
      });
      onSaved();
    } catch (e) {
      setErr(e as Error);
    }
  };
  return (
    <Modal title="ثبت مصوبه" wide onClose={onClose} footer={<Button onClick={save}>ثبت مصوبه و ایجاد وظیفه</Button>}>
      <ErrorBox error={err} />
      <Field label="دستور جلسه مرتبط">
        <select className="input" value={form.agendaItemId} onChange={(e) => setForm({ ...form, agendaItemId: e.target.value })}>
          <option value="">—</option>
          {m.agenda.map((a: any) => (
            <option key={a.id} value={a.id}>
              {a.title}
            </option>
          ))}
        </select>
      </Field>
      <Field label="متن مصوبه">
        <textarea className="input" value={form.text} onChange={(e) => setForm({ ...form, text: e.target.value })} />
      </Field>
      <div className="grid grid-2">
        <Field label="مسئول اجرا">
          <select className="input" value={form.ownerId} onChange={(e) => setForm({ ...form, ownerId: e.target.value })}>
            <option value="">—</option>
            {members.data?.map((x) => (
              <option key={x.user_id} value={x.user_id}>
                {x.full_name} ({ROLE_LABELS[x.position as InviteeRole]})
              </option>
            ))}
          </select>
        </Field>
        <Field label="دستگاه/مخاطب">
          <input className="input" value={form.addressee} onChange={(e) => setForm({ ...form, addressee: e.target.value })} />
        </Field>
        <Field label="مهلت اجرا">
          <JalaliDateInput value={form.dueDate} onChange={(v) => setForm({ ...form, dueDate: v })} />
        </Field>
        <Field label="اولویت">
          <select className="input" value={form.priority} onChange={(e) => setForm({ ...form, priority: e.target.value })}>
            <option value="low">کم</option>
            <option value="normal">عادی</option>
            <option value="high">زیاد</option>
            <option value="urgent">فوری</option>
          </select>
        </Field>
      </div>
      <Field label="شاخص نتیجه">
        <input className="input" value={form.kpi} onChange={(e) => setForm({ ...form, kpi: e.target.value })} />
      </Field>
    </Modal>
  );
}

