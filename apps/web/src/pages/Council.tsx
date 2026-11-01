import { CASE_LEVEL_LABELS, CASE_PRIORITY_LABELS, CASE_STATUS_LABELS, type CaseLevel, type CasePriority, type CaseStatus } from '@kx/shared';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  Badge,
  Button,
  Card,
  dateFa,
  dateTimeFa,
  Empty,
  ErrorBox,
  fa,
  Field,
  JalaliDateInput,
  Loading,
  Modal,
  PageHeader,
  Pager,
  type Tone,
} from '../components/ui';
import { post } from '../lib/api';
import { useApi } from '../lib/hooks';

const STATUS_TONE: Record<CaseStatus, Tone> = {
  expert_review: 'info',
  on_agenda: 'accent',
  pending_approval: 'warning',
  resolved: 'success',
  returned: 'warning',
  closed: 'neutral',
};

export function CaseStatusBadge({ status, overdue }: { status: CaseStatus; overdue?: boolean }) {
  return (
    <span className="row gap-sm" style={{ display: 'inline-flex' }}>
      <Badge tone={STATUS_TONE[status]}>{CASE_STATUS_LABELS[status]}</Badge>
      {overdue && <Badge tone="danger">معوق</Badge>}
    </span>
  );
}

const LevelBadge = ({ level }: { level: CaseLevel }) => <Badge tone={level === 'national' ? 'accent' : 'neutral'}>{CASE_LEVEL_LABELS[level]}</Badge>;

/** «پرونده‌های شورا»: the council cases the user may see, with filters; the provincial secretariat opens new ones. */
export function CouncilPage() {
  const me = useApi<any>('/council/me');
  const [page, setPage] = useState(1);
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [level, setLevel] = useState('');
  const [overdue, setOverdue] = useState(false);
  const [opening, setOpening] = useState(false);
  const qs = `page=${page}&q=${encodeURIComponent(q)}${status ? `&status=${status}` : ''}${level ? `&level=${level}` : ''}${overdue ? '&overdue=true' : ''}`;
  const { data, error } = useApi<any>(`/council-cases?${qs}`, [qs]);
  const nav = useNavigate();
  const roles = me.data;
  const roleText = roles
    ? [
        roles.president?.length && 'دبیر شورا',
        roles.secretariat?.length && 'دبیرخانهٔ شورا',
        !roles.secretariat?.length && roles.member?.length && 'عضو شورا یا کارگروه کارشناسی',
      ]
        .filter(Boolean)
        .join('، ')
    : '';
  return (
    <>
      <PageHeader
        title="پرونده‌های شورای گفت‌وگو"
        subtitle={roleText ? `نقش شما: ${roleText}` : 'پرونده‌هایی که از کمیسیون‌های شما یا به شورای اتاق شما رسیده است'}
        actions={roles?.canOpen?.length > 0 && <Button onClick={() => setOpening(true)}>ثبت پروندهٔ تازه</Button>}
      />
      <ErrorBox error={error} />
      <Card>
        <div className="row gap-sm wrap mb" style={{ alignItems: 'flex-end' }}>
          <Field label="جست‌وجو">
            <input
              className="input"
              value={q}
              onChange={(e) => {
                setQ(e.target.value);
                setPage(1);
              }}
              placeholder="عنوان یا کد رهگیری"
            />
          </Field>
          <Field label="وضعیت">
            <select
              className="input"
              value={status}
              onChange={(e) => {
                setStatus(e.target.value);
                setPage(1);
              }}
            >
              <option value="">همه</option>
              <option value="expert_review,on_agenda,pending_approval,returned">در جریان</option>
              {Object.entries(CASE_STATUS_LABELS).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
          </Field>
          <Field label="سطح">
            <select
              className="input"
              value={level}
              onChange={(e) => {
                setLevel(e.target.value);
                setPage(1);
              }}
            >
              <option value="">همه</option>
              <option value="provincial">استانی</option>
              <option value="national">ملی</option>
            </select>
          </Field>
          <label className="check">
            <input
              type="checkbox"
              checked={overdue}
              onChange={(e) => {
                setOverdue(e.target.checked);
                setPage(1);
              }}
            />{' '}
            فقط معوق
          </label>
        </div>
        {!data ? (
          <Loading />
        ) : data.items.length === 0 ? (
          <Empty>پرونده‌ای نیست.</Empty>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>کد</th>
                  <th>عنوان</th>
                  <th>مبدأ</th>
                  <th>سطح</th>
                  <th>وضعیت</th>
                  <th>مهلت</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((c: any) => (
                  <tr key={c.id} className="clickable" onClick={() => nav(`/council/cases/${c.id}`)}>
                    <td className="ltr">
                      <Link to={`/council/cases/${c.id}`}>{fa(c.code)}</Link>
                    </td>
                    <td>
                      {c.title}
                      {c.confidential && (
                        <>
                          {' '}
                          <Badge tone="danger">محرمانه</Badge>
                        </>
                      )}
                      {c.priority !== 'normal' && (
                        <>
                          {' '}
                          <Badge tone="warning">{CASE_PRIORITY_LABELS[c.priority as CasePriority]}</Badge>
                        </>
                      )}
                    </td>
                    <td className="small">
                      {c.origin_province}
                      {c.origin_commission_name && <div className="muted">{c.origin_commission_name}</div>}
                    </td>
                    <td>
                      <LevelBadge level={c.level} />
                    </td>
                    <td>
                      <CaseStatusBadge status={c.status} overdue={c.is_overdue} />
                    </td>
                    <td>{dateFa(c.due_date)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {data && <Pager page={page} pageSize={data.pageSize} total={data.total} onPage={setPage} />}
      </Card>
      {opening && (
        <OpenCaseModal
          chambers={roles.bodies.filter((b: any) => b.body_type === 'council' && roles.canOpen.includes(b.chamber_id))}
          onClose={() => setOpening(false)}
          onOpened={(id) => nav(`/council/cases/${id}`)}
        />
      )}
    </>
  );
}

function OpenCaseModal({ chambers, onClose, onOpened }: { chambers: any[]; onClose: () => void; onOpened: (id: string) => void }) {
  const [form, setForm] = useState({
    chamberId: chambers[0]?.chamber_id ?? '',
    title: '',
    description: '',
    dueDate: '',
    priority: 'normal',
    confidential: false,
  });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<Error | null>(null);
  const save = async () => {
    setBusy(true);
    setErr(null);
    try {
      const r = await post<any>('/council-cases', { ...form, dueDate: form.dueDate || null, description: form.description || null });
      onOpened(r.id);
    } catch (e) {
      setErr(e as Error);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title="ثبت پروندهٔ تازه در شورا"
      onClose={onClose}
      footer={
        <Button busy={busy} disabled={form.title.trim().length < 5} onClick={save}>
          ثبت پرونده
        </Button>
      }
    >
      <ErrorBox error={err} />
      {chambers.length > 1 && (
        <Field label="اتاق">
          <select className="input" value={form.chamberId} onChange={(e) => setForm({ ...form, chamberId: e.target.value })}>
            {chambers.map((c) => (
              <option key={c.chamber_id} value={c.chamber_id}>
                {c.chamber_name}
              </option>
            ))}
          </select>
        </Field>
      )}
      <Field label="عنوان پرونده">
        <input className="input" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
      </Field>
      <Field label="شرح">
        <textarea className="input" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
      </Field>
      <div className="grid grid-2">
        <Field label="مهلت بررسی کارشناسی">
          <JalaliDateInput value={form.dueDate} onChange={(v) => setForm({ ...form, dueDate: v })} />
        </Field>
        <Field label="اولویت">
          <select className="input" value={form.priority} onChange={(e) => setForm({ ...form, priority: e.target.value })}>
            {Object.entries(CASE_PRIORITY_LABELS).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <label className="check">
        <input type="checkbox" checked={form.confidential} onChange={(e) => setForm({ ...form, confidential: e.target.checked })} /> محرمانه (اعضای شورا فقط پس
        از قرار گرفتن در دستور جلسه می‌بینند)
      </label>
    </Modal>
  );
}

/** One case: where it is, what was decided, and the next steps for whoever may take them. */
export function CouncilCasePage() {
  const { id } = useParams();
  const { data: c, error, reload } = useApi<any>(`/council-cases/${id}`, [id]);
  const [acting, setActing] = useState<any | null>(null);
  const [expert, setExpert] = useState(false);
  if (error) return <ErrorBox error={error} />;
  if (!c) return <Loading />;
  return (
    <>
      <PageHeader
        title={
          <span>
            پرونده <bdi dir="ltr">{fa(c.code)}</bdi>: {c.title}
          </span>
        }
        subtitle={
          <span className="row gap-sm wrap">
            <LevelBadge level={c.level} />
            <CaseStatusBadge status={c.status} overdue={c.is_overdue} />
            {c.confidential && <Badge tone="danger">محرمانه</Badge>}
            {c.priority !== 'normal' && <Badge tone="warning">اولویت {CASE_PRIORITY_LABELS[c.priority as CasePriority]}</Badge>}
            {c.due_date && <span className="muted small">مهلت مرحلهٔ فعلی: {dateFa(c.due_date)}</span>}
          </span>
        }
      />
      {(c.actions.length > 0 || c.canAddExpertMeeting) && (
        <Card title="اقدام بعدی">
          <div className="row gap-sm wrap">
            {c.canAddExpertMeeting && (
              <Button variant="secondary" onClick={() => setExpert(true)}>
                طرح در جلسهٔ کارشناسی
              </Button>
            )}
            {c.actions.map((a: any) => (
              <Button
                key={a.action}
                variant={['reject_escalation', 'return', 'send_back'].includes(a.action) ? 'secondary' : 'primary'}
                onClick={() => setActing(a)}
              >
                {a.label}
              </Button>
            ))}
          </div>
          {c.status === 'pending_approval' && c.roles.includes('president') && (
            <p className="muted small">به‌عنوان دبیر شورا، تأیید یا عدم تأیید ارجاع به شورای ملی را خودتان ثبت می‌کنید.</p>
          )}
        </Card>
      )}
      <div className="grid grid-2">
        <Card title="مبدأ پرونده">
          <dl className="dl">
            <dt>اتاق</dt>
            <dd>{c.origin?.chamber_name}</dd>
            {c.origin?.commission_name && (
              <>
                <dt>کمیسیون</dt>
                <dd>{c.origin.commission_name}</dd>
              </>
            )}
            {c.origin_resolution_id && (
              <>
                <dt>مصوبهٔ ارجاع</dt>
                <dd>
                  <Link to={`/resolutions/${c.origin_resolution_id}`}>مصوبه {fa(c.origin.resolution_number)}</Link>
                  <div className="small muted">{c.origin.resolution_text}</div>
                </dd>
              </>
            )}
            <dt>ثبت</dt>
            <dd>{dateTimeFa(c.created_at)}</dd>
          </dl>
          {c.description && <p style={{ whiteSpace: 'pre-wrap' }}>{c.description}</p>}
          {c.outcome && (
            <div className="alert alert-success">
              <strong>نتیجهٔ نهایی:</strong> {c.outcome}
            </div>
          )}
        </Card>
        <Card title="جلسه‌ها">
          {c.agenda.length === 0 && <Empty>هنوز در دستور جلسه‌ای نیست.</Empty>}
          <ul className="list">
            {c.agenda.map((a: any) => (
              <li key={a.agenda_item_id}>
                <Badge tone={a.body_type === 'council' ? 'accent' : 'info'}>{a.body_type === 'council' ? 'شورا' : 'کارشناسی'}</Badge>{' '}
                <Link to={`/meetings/${a.meeting_id}`}>{a.meeting_title}</Link>
                <span className="muted small">
                  {' '}
                  — {a.body_name} — {dateTimeFa(a.scheduled_at)}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      </div>
      <Card title="خط زمانی پرونده">
        <ol className="timeline">
          {c.events.map((e: any) => (
            <li key={e.id}>
              <div className="row between wrap gap-sm">
                <strong>{e.label}</strong>
                <span className="muted small">{dateTimeFa(e.created_at)}</span>
              </div>
              <div className="small">
                {e.actor_name && <span>{e.actor_name}</span>}
                {e.to_status && (
                  <span className="muted">
                    {' '}
                    — {CASE_LEVEL_LABELS[e.to_level as CaseLevel]}، {CASE_STATUS_LABELS[e.to_status as CaseStatus]}
                  </span>
                )}
              </div>
              {e.meeting_title && (
                <div className="small">
                  جلسه: <Link to={`/meetings/${e.meeting_id}`}>{e.meeting_title}</Link>
                </div>
              )}
              {e.resolution_id && (
                <div className="small">
                  مصوبه: <Link to={`/resolutions/${e.resolution_id}`}>{fa(e.resolution_number)}</Link> — {e.resolution_text}
                </div>
              )}
              {e.reason && (
                <div className="small muted">
                  {e.event === 'close' ? 'نتیجه' : 'دلیل'}: {e.reason}
                </div>
              )}
            </li>
          ))}
        </ol>
      </Card>
      {acting && (
        <ActionModal
          c={c}
          a={acting}
          onClose={() => setActing(null)}
          onDone={() => {
            setActing(null);
            void reload();
          }}
        />
      )}
      {expert && (
        <ExpertMeetingModal
          c={c}
          onClose={() => setExpert(false)}
          onDone={() => {
            setExpert(false);
            void reload();
          }}
        />
      )}
    </>
  );
}

function ActionModal({ c, a, onClose, onDone }: { c: any; a: any; onClose: () => void; onDone: () => void }) {
  const opts = useApi<any>(a.needsMeeting || a.needsResolution ? `/council-cases/${c.id}/options` : null);
  const [meetingId, setMeetingId] = useState('');
  const [resolutionId, setResolutionId] = useState('');
  const [reason, setReason] = useState('');
  const [outcome, setOutcome] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<Error | null>(null);
  const meetings = (opts.data?.meetings ?? []).filter((m: any) => m.body_type === 'council');
  const resolutions = (opts.data?.resolutions ?? []).filter((r: any) => a.needsResolution !== 'council' || r.body_type === 'council');
  const ready =
    (!a.needsMeeting || meetingId) &&
    (!a.needsResolution || resolutionId) &&
    (!a.needsReason || reason.trim().length >= 5) &&
    (!a.needsOutcome || outcome.trim().length >= 5);
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
    <Modal
      title={a.label}
      onClose={onClose}
      footer={
        <Button busy={busy} disabled={!ready} onClick={save}>
          ثبت
        </Button>
      }
    >
      <ErrorBox error={err} />
      {a.needsMeeting && (
        <Field label="جلسهٔ شورا" hint={meetings.length ? undefined : 'ابتدا جلسهٔ شورا را در تقویم جلسات تعریف کنید'}>
          <select className="input" value={meetingId} onChange={(e) => setMeetingId(e.target.value)}>
            <option value="">—</option>
            {meetings.map((m: any) => (
              <option key={m.id} value={m.id}>
                {m.title} — {dateFa(m.scheduled_at)}
              </option>
            ))}
          </select>
        </Field>
      )}
      {a.needsResolution && (
        <Field
          label="مصوبهٔ تصمیم"
          hint={resolutions.length ? 'مهلت مرحلهٔ بعد از مهلت همین مصوبه است' : 'مصوبهٔ جلسه‌ای که پرونده در دستور آن بوده را ابتدا در صورتجلسه ثبت کنید'}
        >
          <select className="input" value={resolutionId} onChange={(e) => setResolutionId(e.target.value)}>
            <option value="">—</option>
            {resolutions.map((r: any) => (
              <option key={r.id} value={r.id}>
                {r.number} — {r.text.slice(0, 80)} ({r.body_type === 'council' ? 'شورا' : 'کارشناسی'})
              </option>
            ))}
          </select>
        </Field>
      )}
      {a.needsReason && (
        <Field label="دلیل (الزامی)">
          <textarea className="input" value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
      )}
      {a.needsOutcome && (
        <Field label="نتیجهٔ نهایی برای ابلاغ به مبدأ">
          <textarea className="input" value={outcome} onChange={(e) => setOutcome(e.target.value)} />
        </Field>
      )}
      {!a.needsMeeting && !a.needsResolution && !a.needsReason && !a.needsOutcome && <p>این اقدام ثبت و به ذی‌نفعان اطلاع داده می‌شود.</p>}
    </Modal>
  );
}

function ExpertMeetingModal({ c, onClose, onDone }: { c: any; onClose: () => void; onDone: () => void }) {
  const opts = useApi<any>(`/council-cases/${c.id}/options`);
  const [meetingId, setMeetingId] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<Error | null>(null);
  const meetings = (opts.data?.meetings ?? []).filter((m: any) => m.body_type === 'expert_group');
  return (
    <Modal
      title="طرح پرونده در جلسهٔ کارشناسی"
      onClose={onClose}
      footer={
        <Button
          busy={busy}
          disabled={!meetingId}
          onClick={() => {
            setBusy(true);
            post(`/council-cases/${c.id}/expert-meeting`, { meetingId }).then(onDone, (e) => {
              setErr(e);
              setBusy(false);
            });
          }}
        >
          افزودن به دستور جلسه
        </Button>
      }
    >
      <ErrorBox error={err} />
      <Field label="جلسهٔ کارشناسی" hint={meetings.length ? undefined : 'ابتدا جلسهٔ کارگروه کارشناسی را در تقویم جلسات تعریف کنید'}>
        <select className="input" value={meetingId} onChange={(e) => setMeetingId(e.target.value)}>
          <option value="">—</option>
          {meetings.map((m: any) => (
            <option key={m.id} value={m.id}>
              {m.title} — {dateFa(m.scheduled_at)}
            </option>
          ))}
        </select>
      </Field>
      <p className="muted small">
        ترکیب جلسهٔ کارشناسی برای هر پرونده جداست: کارشناسان اتاق و نمایندگان دستگاه‌های دولتی را در زبانهٔ «مدعوین» همان جلسه دعوت کنید. مدعوین فقط همین پرونده
        را می‌بینند.
      </p>
    </Modal>
  );
}

/** «ارجاع به شورای گفت‌وگو» from a commission resolution. */
export function ReferToCouncilButton({ r, onDone }: { r: any; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ title: '', description: '', priority: 'normal', confidential: false });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<Error | null>(null);
  const nav = useNavigate();
  if (r.councilCase) {
    return (
      <Link to={`/council/cases/${r.councilCase.id}`} className="btn btn-ghost btn-sm">
        پروندهٔ شورا <bdi dir="ltr">{fa(r.councilCase.code)}</bdi> — {CASE_STATUS_LABELS[r.councilCase.status as CaseStatus]}
      </Link>
    );
  }
  if (!r.canReferToCouncil) return null;
  return (
    <>
      <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>
        ارجاع به شورای گفت‌وگو
      </Button>
      {open && (
        <Modal
          title="ارجاع مصوبه به شورای گفت‌وگوی استان"
          onClose={() => setOpen(false)}
          footer={
            <Button
              busy={busy}
              onClick={() => {
                setBusy(true);
                setErr(null);
                post<any>('/council-cases', { resolutionId: r.id, ...form, title: form.title.trim() || undefined, description: form.description || null }).then(
                  (c) => {
                    onDone();
                    nav(`/council/cases/${c.id}`);
                  },
                  (e) => {
                    setErr(e);
                    setBusy(false);
                  },
                );
              }}
            >
              ارجاع
            </Button>
          }
        >
          <ErrorBox error={err} />
          <p className="muted small" style={{ marginTop: 0 }}>
            مهلت بررسی کارشناسی از مهلت همین مصوبه ({r.due_date ? dateFa(r.due_date) : 'تعیین نشده؛ ابتدا مصوبه را ویرایش کنید'}) می‌آید. وضعیت پرونده تا پایان
            برای کمیسیون قابل پیگیری است.
          </p>
          <Field label="عنوان پرونده" hint="خالی: از متن مصوبه">
            <input className="input" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
          </Field>
          <Field label="شرح برای شورا">
            <textarea className="input" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
          </Field>
          <Field label="اولویت">
            <select className="input" value={form.priority} onChange={(e) => setForm({ ...form, priority: e.target.value })}>
              {Object.entries(CASE_PRIORITY_LABELS).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
          </Field>
          <label className="check">
            <input type="checkbox" checked={form.confidential} onChange={(e) => setForm({ ...form, confidential: e.target.checked })} /> محرمانه
          </label>
        </Modal>
      )}
    </>
  );
}
