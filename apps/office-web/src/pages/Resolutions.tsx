import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Pill, RESOLUTION_STATUS } from '../components/labels';
import { Badge, Button, Card, Empty, ErrorBox, Field, Loading, PageHeader, Pager, Progress, Tabs, dateFa, dateTimeFa, fa } from '../components/ui';
import { post } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useAction, useApi } from '../lib/hooks';

const FEEDBACK_STATUS: Record<string, [string, 'success' | 'warning' | 'danger']> = {
  pending: ['در صف ارسال', 'warning'],
  sent: ['ارسال‌شده', 'success'],
  failed: ['ناموفق', 'danger'],
};

export function ResolutionsPage() {
  const { can } = useAuth();
  const nav = useNavigate();
  const [tab, setTab] = useState<'mine' | 'open' | 'all'>('mine');
  const [page, setPage] = useState(1);
  const [q, setQ] = useState('');
  const qs = new URLSearchParams({
    page: String(page),
    ...(tab === 'mine' ? { mine: 'true' } : {}),
    ...(tab !== 'all' ? { status: 'open,in_progress,returned,submitted' } : {}),
    ...(q ? { q } : {}),
  }).toString();
  const r = useApi<{ items: any[]; total: number; page: number; pageSize: number }>(`/resolutions?${qs}`, [qs]);
  return (
    <>
      <PageHeader title="پیگیری مصوبات کمیسیون‌ها" subtitle="مصوبات ثبت‌شده در سامانه جلسات، به‌صورت خودکار به مسئول اجرا ابلاغ و گزارش پیشرفت به سامانه جلسات برگردانده می‌شود" />
      <Card>
        <div className="row between wrap mb">
          <Tabs
            value={tab}
            onChange={(t) => (setTab(t), setPage(1))}
            tabs={[
              { id: 'mine', label: 'محول‌شده به من' },
              ...(can('meetings.view') ? [{ id: 'open' as const, label: 'همه مصوبات باز' }, { id: 'all' as const, label: 'همه' }] : []),
            ]}
          />
          <input className="input" style={{ maxWidth: 300 }} placeholder="جستجوی متن یا شماره مصوبه…" onKeyDown={(e) => e.key === 'Enter' && setQ((e.target as HTMLInputElement).value.trim())} />
        </div>
        {r.loading && !r.data ? (
          <Loading />
        ) : !r.data?.items.length ? (
          <Empty>مصوبه‌ای یافت نشد.</Empty>
        ) : (
          <>
            <table className="table">
              <thead>
                <tr>
                  <th>شماره</th>
                  <th>مصوبه</th>
                  <th>کمیسیون</th>
                  <th>مسئول اجرا</th>
                  <th>مهلت</th>
                  <th>پیشرفت</th>
                  <th>وضعیت</th>
                </tr>
              </thead>
              <tbody>
                {r.data.items.map((x) => (
                  <tr key={x.id} className={`clickable ${x.overdue ? 'highlight' : ''}`} onClick={() => nav(`/resolutions/${x.id}`)}>
                    <td>{x.number}</td>
                    <td>{x.text.length > 120 ? `${x.text.slice(0, 120)}…` : x.text}</td>
                    <td className="small">{x.commission_name}</td>
                    <td className="small">{x.owner_name ?? '—'}</td>
                    <td className="small">
                      {dateFa(x.due_date)} {x.overdue && <Badge tone="danger">معوق</Badge>}
                    </td>
                    <td style={{ minWidth: 120 }}>
                      <Progress value={x.progress} />
                    </td>
                    <td>
                      <Pill map={RESOLUTION_STATUS} value={x.status} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <Pager page={r.data.page} pageSize={r.data.pageSize} total={Number(r.data.total)} onPage={setPage} />
          </>
        )}
      </Card>
    </>
  );
}

export function ResolutionDetailPage() {
  const { id } = useParams();
  const r = useApi<any>(`/resolutions/${id}`, [id]);
  const [progress, setProgress] = useState<number | null>(null);
  const [note, setNote] = useState('');
  const [submit, setSubmit] = useState(false);
  const act = useAction();
  if (r.error) return <ErrorBox error={r.error} />;
  if (!r.data) return <Loading />;
  const x = r.data;
  const p = progress ?? x.progress;
  const updates = x.data?.updates ?? [];
  const closed = ['done', 'cancelled'].includes(x.status);
  return (
    <>
      <PageHeader title={`مصوبه ${x.number} — ${x.commission_name}`} subtitle={x.meeting_title ? `${x.meeting_title} (${dateFa(x.meeting_date)})` : undefined} />
      <div className="grid grid-2">
        <Card title="متن مصوبه">
          <div className="letter-body">{x.text}</div>
          <dl className="kv mt">
            <dt>مسئول اجرا</dt>
            <dd>{x.owner_name ?? '—'}</dd>
            {x.data?.addressee && (
              <>
                <dt>مخاطب</dt>
                <dd>{x.data.addressee}</dd>
              </>
            )}
            <dt>مهلت</dt>
            <dd>{dateFa(x.due_date)}</dd>
            <dt>وضعیت</dt>
            <dd>
              <Pill map={RESOLUTION_STATUS} value={x.status} />
            </dd>
            <dt>پیشرفت</dt>
            <dd>
              <Progress value={x.progress} />
            </dd>
            {x.letter_id && (
              <>
                <dt>نامه ابلاغ</dt>
                <dd>
                  <Link to={`/letters/${x.letter_id}`}>{x.letter_number}</Link>
                </dd>
              </>
            )}
            <dt>آخرین همگام‌سازی</dt>
            <dd className="small">{dateTimeFa(x.synced_at)}</dd>
          </dl>
        </Card>
        <Card title="ثبت گزارش اجرا">
          {closed ? (
            <Empty>این مصوبه بسته شده است.</Empty>
          ) : !x.canFollow ? (
            <Empty>ثبت پیگیری فقط برای مسئول اجرا یا کارشناس پیگیری مصوبات امکان‌پذیر است.</Empty>
          ) : (
            <>
              <ErrorBox error={act.error} />
              <Field label={`درصد پیشرفت: ${fa(p)}٪`}>
                <input type="range" min={0} max={100} step={5} value={p} onChange={(e) => setProgress(Number(e.target.value))} />
              </Field>
              <Field label="شرح اقدامات">
                <textarea className="input" rows={4} value={note} onChange={(e) => setNote(e.target.value)} />
              </Field>
              <label className="check mb">
                <input type="checkbox" checked={submit} onChange={(e) => setSubmit(e.target.checked)} />
                اجرا کامل شده؛ برای تأیید دبیر کمیسیون ارسال شود
              </label>
              <Button
                busy={act.busy}
                disabled={note.trim().length < 3}
                onClick={() =>
                  act.run(async () => {
                    await post(`/resolutions/${x.id}/feedback`, { progress: submit ? 100 : p, note: note.trim(), submit });
                    setNote('');
                    setSubmit(false);
                    setProgress(null);
                    await r.reload();
                  })
                }
              >
                ارسال به سامانه جلسات
              </Button>
              <p className="small muted mt">گزارش‌ها در صف ارسال قرار می‌گیرند و در صورت قطعی ارتباط، خودکار دوباره ارسال می‌شوند.</p>
            </>
          )}
        </Card>
      </div>
      <div className="grid grid-2 mt">
        <Card title="گزارش‌های ارسالی از اتوماسیون">
          {!x.feedback.length ? (
            <Empty>گزارشی ارسال نشده است.</Empty>
          ) : (
            <ul className="list">
              {x.feedback.map((f: any) => (
                <li key={f.id}>
                  <div className="row gap-sm">
                    <strong>{fa(f.progress)}٪</strong>
                    <Badge tone={FEEDBACK_STATUS[f.status]?.[1] ?? 'neutral'}>{FEEDBACK_STATUS[f.status]?.[0] ?? f.status}</Badge>
                    {f.submit && <Badge tone="accent">درخواست تأیید</Badge>}
                    <span className="small muted">{dateTimeFa(f.created_at)}</span>
                  </div>
                  <div>{f.note}</div>
                  {f.error && <div className="small field-error">{f.error}</div>}
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card title="سابقه پیگیری در سامانه جلسات">
          {!updates.length ? (
            <Empty>سابقه‌ای ثبت نشده است.</Empty>
          ) : (
            <ul className="timeline">
              {updates.map((u: any) => (
                <li key={u.id} className={u.kind === 'approve' ? 'ok' : u.kind === 'return' ? 'bad' : ''}>
                  <div className="row gap-sm">
                    <strong>{u.author}</strong>
                    {u.progress !== null && <span>{fa(u.progress)}٪</span>}
                    <span className="small muted">{dateTimeFa(u.created_at)}</span>
                  </div>
                  {u.note && <div>{u.note}</div>}
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </>
  );
}
