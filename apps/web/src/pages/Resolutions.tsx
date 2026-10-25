import { RESOLUTION_STATUS_LABELS, RESOLUTION_STATUSES } from '@kx/shared';
import { NetworkShareCard } from './Networks';
import { useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { PriorityBadge, ResolutionBadge } from '../components/status';
import { Badge, Button, Card, dateFa, dateTimeFa, Empty, ErrorBox, Field, fa, JalaliDateInput, Loading, Modal, PageHeader, Pager, Progress } from '../components/ui';
import { download, patch, post, upload } from '../lib/api';
import { useApi } from '../lib/hooks';
import { useAuth } from '../lib/auth';
import { DocActions } from '../components/docs';
import { cleanExecutors, ExecutorsCard, ExecutorsEditor, type ExecutorDraft } from '../components/Executors';

export function ResolutionsPage() {
  const nav = useNavigate();
  const [params] = useSearchParams();
  const [page, setPage] = useState(1);
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [mine, setMine] = useState(params.get('mine') === 'true');
  const [overdue, setOverdue] = useState(false);
  const { data, loading } = useApi(`/resolutions?page=${page}&q=${encodeURIComponent(q)}&status=${status}&mine=${mine}&overdue=${overdue}`);
  return (
    <>
      <PageHeader title="مصوبات و پیگیری" subtitle="مصوبات معوق در ابتدای فهرست نمایش داده می‌شوند" />
      <Card>
        <div className="row gap-sm wrap mb">
          <input className="input" style={{ maxWidth: 320 }} placeholder="جستجو در متن، شماره یا مخاطب" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} />
          <select className="input" style={{ maxWidth: 200 }} value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}>
            <option value="">همه وضعیت‌ها</option>
            {RESOLUTION_STATUSES.map((s) => (
              <option key={s} value={s}>
                {RESOLUTION_STATUS_LABELS[s]}
              </option>
            ))}
          </select>
          <label className="check" style={{ margin: 0 }}>
            <input type="checkbox" checked={mine} onChange={(e) => setMine(e.target.checked)} /> فقط مسئولیت‌های من
          </label>
          <label className="check" style={{ margin: 0 }}>
            <input type="checkbox" checked={overdue} onChange={(e) => setOverdue(e.target.checked)} /> فقط معوق
          </label>
        </div>
        {loading && !data ? (
          <Loading />
        ) : data.items.length === 0 ? (
          <Empty>مصوبه‌ای یافت نشد.</Empty>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>شماره</th>
                  <th>متن</th>
                  <th>کمیسیون</th>
                  <th>مسئول</th>
                  <th>مهلت</th>
                  <th>اولویت</th>
                  <th>پیشرفت</th>
                  <th>وضعیت</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((r: any) => (
                  <tr key={r.id} className={`clickable ${r.is_overdue ? 'highlight' : ''}`} onClick={() => nav(`/resolutions/${r.id}`)}>
                    <td className="ltr">{r.number}</td>
                    <td style={{ maxWidth: 380 }}>{r.text}</td>
                    <td>{r.commission_name}</td>
                    <td>{r.owner_name ?? '—'}</td>
                    <td>{dateFa(r.due_date)}</td>
                    <td>
                      <PriorityBadge priority={r.priority} />
                    </td>
                    <td style={{ minWidth: 110 }}>
                      <Progress value={r.progress} />
                    </td>
                    <td>
                      <ResolutionBadge status={r.status} overdue={r.is_overdue} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {data && <Pager page={page} pageSize={data.pageSize} total={data.total} onPage={setPage} />}
      </Card>
    </>
  );
}

export const KPI_LABEL = 'معیار انجام (شاخص نتیجه)';
export const KPI_HINT = 'چه چیزی نشان می‌دهد مصوبه انجام شده است؟ مثلاً «ارائه گزارش با آمار ۵ کالای اصلی صادراتی در جلسه بعد» یا «دریافت پاسخ کتبی بانک مرکزی»';

/** The resolution's measurable completion criterion, editable by the secretary while the resolution is open. */
function KpiLine({ r, canEdit, onSaved }: { r: any; canEdit: boolean; onSaved: () => Promise<void> | void }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState('');
  const [err, setErr] = useState<Error | null>(null);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    setErr(null);
    try {
      await patch(`/resolutions/${r.id}`, { kpi: value.trim() });
      setEditing(false);
      await onSaved();
    } catch (e) {
      setErr(e as Error);
    } finally {
      setBusy(false);
    }
  };
  if (editing)
    return (
      <li>
        <ErrorBox error={err} />
        <Field label={KPI_LABEL} hint={KPI_HINT}>
          <textarea className="input" rows={2} value={value} onChange={(e) => setValue(e.target.value)} autoFocus />
        </Field>
        <div className="row gap-sm">
          <Button size="sm" busy={busy} onClick={save}>
            ذخیره
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
            انصراف
          </Button>
        </div>
      </li>
    );
  return (
    <li title={KPI_HINT}>
      {KPI_LABEL}: {r.kpi || '—'}{' '}
      {canEdit && (
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            setValue(r.kpi ?? '');
            setEditing(true);
          }}
        >
          {r.kpi ? 'ویرایش' : 'تعیین'}
        </Button>
      )}
    </li>
  );
}

export function ResolutionDetailPage() {
  const { id } = useParams();
  const { me } = useAuth();
  const { data: r, error, reload } = useApi(`/resolutions/${id}`);
  const [progress, setProgress] = useState<number | null>(null);
  const [note, setNote] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [err, setErr] = useState<Error | null>(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  if (error) return <ErrorBox error={error} />;
  if (!r) return <Loading />;
  const closed = ['done', 'cancelled'].includes(r.status);
  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setErr(null);
    try {
      await fn();
      setNote('');
      setFile(null);
      setProgress(null);
      await reload();
    } catch (e) {
      setErr(e as Error);
    } finally {
      setBusy(false);
    }
  };
  const report = (submit: boolean) =>
    act(async () => {
      let documentId: string | undefined;
      if (file) documentId = (await upload({ resolutionId: r.id, kind: 'evidence' }, file)).id;
      await patch(`/resolutions/${r.id}/progress`, { progress: progress ?? r.progress, note: note || null, documentId, submit });
    });
  return (
    <>
      <PageHeader
        title={<span className="ltr">مصوبه {r.number}</span>}
        subtitle={
          <>
            {r.commission_name}
            {r.meeting_id && (
              <>
                {' '}
                — <Link to={`/meetings/${r.meeting_id}`}>جلسه {fa(r.meeting_number)}</Link>
              </>
            )}
            {r.agenda_title ? ` — ${r.agenda_title}` : ''}
          </>
        }
        actions={
          <>
            <ResolutionBadge status={r.status} overdue={!closed && r.due_date && new Date(r.due_date) < new Date()} />
            {r.canManage && !closed && (
              <>
                <Button size="sm" variant="secondary" onClick={() => setEditing(true)}>
                  ویرایش مصوبه
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setCancelling(true)}>
                  <span style={{ color: 'var(--danger)' }}>لغو مصوبه</span>
                </Button>
              </>
            )}
          </>
        }
      />
      {editing && (
        <ResolutionEditModal
          r={r}
          onClose={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            void reload();
          }}
        />
      )}
      {cancelling && (
        <CancelModal
          r={r}
          onClose={() => setCancelling(false)}
          onSaved={() => {
            setCancelling(false);
            void reload();
          }}
        />
      )}
      <ErrorBox error={err} />
      <ExecutorsCard r={r} onChanged={() => void reload()} />
      <div className="grid grid-2">
        <Card title="متن مصوبه">
          <p className="pre">{r.text}</p>
          <ul className="list small">
            <li>مسئول پیگیری: {r.owner_name ?? '—'}</li>
            <li>دستگاه‌های اجرایی: {r.addressee ?? '—'}</li>
            <li>مهلت: {dateFa(r.due_date)}</li>
            <li>
              اولویت: <PriorityBadge priority={r.priority} />
            </li>
            <KpiLine r={r} canEdit={r.canManage && r.status !== 'done' && r.status !== 'cancelled'} onSaved={reload} />
            <li>
              پیشرفت: <Progress value={r.progress} />
            </li>
          </ul>
        </Card>
        <Card title="گزارش اجرا و بررسی">
          {r.executors?.length > 0 && !closed && r.status !== 'submitted' && (
            <p className="muted small" style={{ marginTop: 0 }}>
              گزارش پیشرفت هر دستگاه را از جدول «دستگاه‌های اجرایی» ثبت کنید.
            </p>
          )}
          {(r.isOwner || r.canManage) && !closed && r.status !== 'submitted' && !r.executors?.length && (
            <>
              <Field label={`درصد پیشرفت: ${fa(progress ?? r.progress)}٪`}>
                <input type="range" min={0} max={100} step={5} value={progress ?? r.progress} onChange={(e) => setProgress(Number(e.target.value))} />
              </Field>
              <Field label="توضیح اقدام انجام‌شده">
                <textarea className="input" value={note} onChange={(e) => setNote(e.target.value)} />
              </Field>
              <Field label="مستند (اختیاری)">
                <input type="file" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
              </Field>
              <div className="row gap-sm">
                <Button busy={busy} variant="secondary" onClick={() => report(false)}>
                  ثبت پیشرفت
                </Button>
                <Button busy={busy} onClick={() => report(true)}>
                  ارسال برای بررسی دبیر
                </Button>
              </div>
            </>
          )}
          {r.canManage && r.status === 'submitted' && (
            <>
              <div className="alert alert-warning">مسئول اجرا نتیجه را برای بررسی ارسال کرده است.</div>
              <Field label="توضیح بررسی">
                <textarea className="input" value={note} onChange={(e) => setNote(e.target.value)} />
              </Field>
              <div className="row gap-sm">
                <Button busy={busy} variant="success" onClick={() => act(() => post(`/resolutions/${r.id}/review`, { approve: true, note: note || null }))}>
                  تأیید انجام
                </Button>
                <Button busy={busy} variant="danger" disabled={note.length < 3} onClick={() => act(() => post(`/resolutions/${r.id}/review`, { approve: false, note }))}>
                  برگشت
                </Button>
              </div>
            </>
          )}
          {closed && <div className="alert alert-success">این مصوبه بسته شده است.</div>}
        </Card>
      </div>
      <div className="grid grid-2 mt">
        <Card title="تاریخچه پیگیری">
          {r.updates.length === 0 && <Empty>گزارشی ثبت نشده است.</Empty>}
          <ul className="list small">
            {r.updates.map((u: any) => (
              <li key={u.id}>
                <strong>{u.full_name}</strong> {u.source === 'integration' && <Badge tone="info">سامانه خارجی</Badge>} <span className="muted">{dateTimeFa(u.created_at)}</span> —{' '}
                {u.kind === 'progress' ? `پیشرفت ${u.executor_name ? `${u.executor_name}: ` : ''}${fa(u.progress)}٪` : u.kind === 'approve' ? 'تأیید انجام' : u.kind === 'return' ? 'برگشت' : 'یادداشت'}
                {u.note && <div className="pre">{u.note}</div>}
              </li>
            ))}
          </ul>
        </Card>
        <Card title="مستندات">
          {r.documents.length === 0 && <Empty>مستندی ثبت نشده است.</Empty>}
          <ul className="list">
            {r.documents.map((d: any) => (
              <li key={d.id}>
                <a href="#" onClick={(e) => { e.preventDefault(); void download(`/documents/${d.id}/download`, d.file_name); }}>
                  {d.title || d.file_name}
                </a>{' '}
                <span className="muted small">{dateFa(d.created_at)}</span>
                {(r.canManage || d.owner_id === me!.id) && <DocActions d={d} onDone={() => void reload()} />}
              </li>
            ))}
          </ul>
        </Card>
      </div>
      <NetworkShareCard resolutionId={r.id} />
    </>
  );
}

/** Correcting a resolution: text (until the minutes are approved), follow-up person, deadline, priority and bodies. */
function ResolutionEditModal({ r, onClose, onSaved }: { r: any; onClose: () => void; onSaved: () => void }) {
  const members = useApi<any[]>(`/commissions/${r.commission_id}/members`);
  const [form, setForm] = useState({ text: r.text, ownerId: r.owner_id ?? '', dueDate: r.due_date?.slice(0, 10) ?? '', priority: r.priority });
  const [executors, setExecutors] = useState<ExecutorDraft[]>((r.executors ?? []).map((e: any) => ({ name: e.name, role: e.role })));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<Error | null>(null);
  const save = async () => {
    setBusy(true);
    setErr(null);
    try {
      await patch(`/resolutions/${r.id}`, {
        ...(r.textLocked ? {} : { text: form.text.trim() }),
        ownerId: form.ownerId || undefined,
        dueDate: form.dueDate || undefined,
        priority: form.priority,
        executors: cleanExecutors(executors),
      });
      onSaved();
    } catch (e) {
      setErr(e as Error);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title={`ویرایش مصوبه ${r.number}`}
      wide
      onClose={onClose}
      footer={
        <Button busy={busy} disabled={form.text.trim().length < 5} onClick={() => void save()}>
          ذخیره تغییرات
        </Button>
      }
    >
      <ErrorBox error={err} />
      <Field label="متن مصوبه" hint={r.textLocked ? 'صورتجلسه این جلسه تأیید شده است؛ متن مصوبه قابل تغییر نیست.' : undefined}>
        <textarea className="input" rows={4} value={form.text} disabled={r.textLocked} onChange={(e) => setForm({ ...form, text: e.target.value })} />
      </Field>
      <div className="grid grid-3">
        <Field label="مسئول پیگیری">
          <select className="input" value={form.ownerId} onChange={(e) => setForm({ ...form, ownerId: e.target.value })}>
            <option value="">—</option>
            {r.owner_id && !(members.data ?? []).some((x) => x.user_id === r.owner_id) && <option value={r.owner_id}>{r.owner_name}</option>}
            {(members.data ?? []).map((x) => (
              <option key={x.user_id} value={x.user_id}>
                {x.full_name}
                {x.organization ? ` — ${x.organization}` : ''}
              </option>
            ))}
          </select>
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
      <Field group label="دستگاه‌های اجرایی" hint="دستگاه‌هایی که می‌مانند، پیشرفت ثبت‌شده‌شان را حفظ می‌کنند">
        <ExecutorsEditor chamberId={r.chamber_id} value={executors} onChange={setExecutors} />
      </Field>
    </Modal>
  );
}

function CancelModal({ r, onClose, onSaved }: { r: any; onClose: () => void; onSaved: () => void }) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<Error | null>(null);
  const save = async () => {
    setBusy(true);
    setErr(null);
    try {
      await patch(`/resolutions/${r.id}`, { status: 'cancelled', reason: reason.trim() });
      onSaved();
    } catch (e) {
      setErr(e as Error);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title={`لغو مصوبه ${r.number}`}
      onClose={onClose}
      footer={
        <Button variant="danger" busy={busy} disabled={reason.trim().length < 3} onClick={() => void save()}>
          لغو مصوبه
        </Button>
      }
    >
      <ErrorBox error={err} />
      <p style={{ marginTop: 0 }}>مصوبهٔ لغوشده دیگر پیگیری نمی‌شود و این کار با نام شما در سابقهٔ مصوبه ثبت می‌شود.</p>
      <Field label="دلیل لغو">
        <textarea className="input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="مثلاً تکراری ثبت شده بود" />
      </Field>
    </Modal>
  );
}
