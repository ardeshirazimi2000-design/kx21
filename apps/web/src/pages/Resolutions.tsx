import { RESOLUTION_STATUS_LABELS, RESOLUTION_STATUSES } from '@kx/shared';
import { useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { PriorityBadge, ResolutionBadge } from '../components/status';
import { Button, Card, dateFa, dateTimeFa, Empty, ErrorBox, Field, fa, Loading, PageHeader, Pager, Progress } from '../components/ui';
import { download, patch, post, upload } from '../lib/api';
import { useApi } from '../lib/hooks';

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

export function ResolutionDetailPage() {
  const { id } = useParams();
  const { data: r, error, reload } = useApi(`/resolutions/${id}`);
  const [progress, setProgress] = useState<number | null>(null);
  const [note, setNote] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [err, setErr] = useState<Error | null>(null);
  const [busy, setBusy] = useState(false);
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
        actions={<ResolutionBadge status={r.status} overdue={!closed && r.due_date && new Date(r.due_date) < new Date()} />}
      />
      <ErrorBox error={err} />
      <div className="grid grid-2">
        <Card title="متن مصوبه">
          <p className="pre">{r.text}</p>
          <ul className="list small">
            <li>مسئول اجرا: {r.owner_name ?? '—'}</li>
            <li>دستگاه/مخاطب: {r.addressee ?? '—'}</li>
            <li>مهلت: {dateFa(r.due_date)}</li>
            <li>
              اولویت: <PriorityBadge priority={r.priority} />
            </li>
            <li>شاخص نتیجه: {r.kpi ?? '—'}</li>
            <li>
              پیشرفت: <Progress value={r.progress} />
            </li>
          </ul>
        </Card>
        <Card title="گزارش اجرا و بررسی">
          {(r.isOwner || r.canManage) && !closed && r.status !== 'submitted' && (
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
                <strong>{u.full_name}</strong> <span className="muted">{dateTimeFa(u.created_at)}</span> —{' '}
                {u.kind === 'progress' ? `پیشرفت ${fa(u.progress)}٪` : u.kind === 'approve' ? 'تأیید انجام' : u.kind === 'return' ? 'برگشت' : 'یادداشت'}
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
                  {d.file_name}
                </a>{' '}
                <span className="muted small">{dateFa(d.created_at)}</span>
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </>
  );
}
