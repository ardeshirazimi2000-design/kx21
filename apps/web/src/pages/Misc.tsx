import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Badge, Button, Card, dateFa, dateTimeFa, Empty, ErrorBox, Field, fa, Loading, PageHeader, Pager } from '../components/ui';
import { download, post } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useApi } from '../lib/hooks';

export function ReferralsPage() {
  const { data, reload } = useApi<any[]>('/referrals');
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [err, setErr] = useState<Error | null>(null);
  return (
    <>
      <PageHeader title="ارجاعات کارشناسی من" subtitle="درخواست‌هایی که برای اظهارنظر کارشناسی به شما ارجاع شده است" />
      <ErrorBox error={err} />
      {data?.length === 0 && <Empty>ارجاعی برای شما ثبت نشده است.</Empty>}
      {data?.map((r) => (
        <Card key={r.id} title={r.issue_title ?? 'ارجاع کارشناسی'} actions={<Badge tone={r.status === 'answered' ? 'success' : 'warning'}>{r.status === 'answered' ? 'پاسخ داده شد' : `مهلت: ${dateFa(r.due_date)}`}</Badge>}>
          <div className="muted small">{r.commission_name}</div>
          <p className="pre">{r.request}</p>
          {r.status === 'pending' ? (
            <>
              <textarea className="input" placeholder="پاسخ کارشناسی" value={answers[r.id] ?? ''} onChange={(e) => setAnswers({ ...answers, [r.id]: e.target.value })} />
              <Button
                className="mt"
                disabled={(answers[r.id] ?? '').length < 3}
                onClick={async () => {
                  try {
                    await post(`/referrals/${r.id}/answer`, { response: answers[r.id] });
                    void reload();
                  } catch (e) {
                    setErr(e as Error);
                  }
                }}
              >
                ارسال پاسخ
              </Button>
            </>
          ) : (
            <div className="alert alert-success pre">{r.response}</div>
          )}
        </Card>
      ))}
    </>
  );
}

const EVENT_LINK = (n: any) =>
  n.data?.meetingId ? `/meetings/${n.data.meetingId}` : n.data?.resolutionId ? `/resolutions/${n.data.resolutionId}` : n.data?.referralId ? '/referrals' : null;

export function NotificationsPage() {
  const nav = useNavigate();
  const [page, setPage] = useState(1);
  const { data, reload } = useApi(`/notifications?page=${page}`);
  return (
    <>
      <PageHeader title="اعلان‌ها" actions={<Button variant="secondary" onClick={() => post('/notifications/read-all').then(reload)}>علامت‌گذاری همه به‌عنوان خوانده‌شده</Button>} />
      <Card>
        {data?.items.length === 0 && <Empty>اعلانی ندارید.</Empty>}
        <ul className="list">
          {data?.items.map((n: any) => (
            <li
              key={n.id}
              style={{ cursor: 'pointer', fontWeight: n.read_at ? 400 : 600 }}
              onClick={async () => {
                if (!n.read_at) await post(`/notifications/${n.id}/read`);
                const to = EVENT_LINK(n);
                if (to) nav(to);
                else void reload();
              }}
            >
              <div className="row between">
                <span>{n.title}</span>
                <span className="muted small">{dateTimeFa(n.created_at)}</span>
              </div>
              <div className="muted small">{n.body}</div>
            </li>
          ))}
        </ul>
        {data && <Pager page={page} pageSize={data.pageSize} total={data.total} onPage={setPage} />}
      </Card>
    </>
  );
}

export function ReportsPage() {
  const { me, isAdmin, chamberId } = useAuth();
  const commissions = me!.memberships.filter((m) => ['chair', 'vice_chair', 'secretary', 'member'].includes(m.position));
  const [commissionId, setCommissionId] = useState(commissions[0]?.commission_id ?? '');
  const attendance = useApi<any[]>(commissionId ? `/reports/attendance?commissionId=${commissionId}` : null);
  const [err, setErr] = useState<Error | null>(null);
  return (
    <>
      <PageHeader title="گزارش‌ها" />
      <ErrorBox error={err} />
      <div className="grid grid-2">
        {isAdmin && chamberId && (
          <Card title="گزارش کل مصوبات اتاق">
            <p className="muted small">خروجی CSV (سازگار با Excel) از همه مصوبات کمیسیون‌های اتاق، با وضعیت، مسئول و تأخیر.</p>
            <Button onClick={() => download(`/reports/resolutions?chamberId=${chamberId}&format=csv`, 'resolutions.csv').catch(setErr)}>دریافت فایل</Button>
          </Card>
        )}
        {commissions.length > 0 && (
          <Card title="گزارش مصوبات کمیسیون">
            <Field label="کمیسیون">
              <select className="input" value={commissionId} onChange={(e) => setCommissionId(e.target.value)}>
                {commissions.map((c) => (
                  <option key={c.commission_id} value={c.commission_id}>
                    {c.commission_name}
                  </option>
                ))}
              </select>
            </Field>
            <Button onClick={() => download(`/reports/resolutions?commissionId=${commissionId}&format=csv`, 'resolutions.csv').catch(setErr)}>دریافت فایل CSV</Button>
          </Card>
        )}
      </div>
      {commissionId && (
        <Card title="گزارش حضور و غیاب اعضا" className="mt">
          {!attendance.data ? (
            <Loading />
          ) : attendance.data.length === 0 ? (
            <Empty>هنوز جلسه‌ای برگزار نشده است.</Empty>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>عضو</th>
                  <th>جلسات</th>
                  <th>حضور</th>
                  <th>غیبت موجه</th>
                  <th>غیبت</th>
                  <th>درصد حضور</th>
                </tr>
              </thead>
              <tbody>
                {attendance.data.map((r) => (
                  <tr key={r.user_id}>
                    <td>{r.full_name}</td>
                    <td>{fa(r.meetings)}</td>
                    <td>{fa(r.attended)}</td>
                    <td>{fa(r.excused)}</td>
                    <td>{fa(r.absent)}</td>
                    <td>{fa(Math.round((r.attended / Math.max(1, r.meetings)) * 100))}٪</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      )}
    </>
  );
}

export function AuditPage() {
  const { chamberId } = useAuth();
  const [page, setPage] = useState(1);
  const [action, setAction] = useState('');
  const { data } = useApi(`/audit?page=${page}&pageSize=50${action ? `&action=${encodeURIComponent(action)}` : ''}`);
  const verify = useApi(chamberId ? `/audit/verify?chamberId=${chamberId}` : null);
  return (
    <>
      <PageHeader
        title="رویدادنگاری (Audit Log)"
        subtitle="ثبت غیرقابل‌تغییر تمام تغییرات حساس، به‌صورت زنجیره هش"
        actions={verify.data && <Badge tone={verify.data.intact ? 'success' : 'danger'}>{verify.data.intact ? 'زنجیره سالم است' : `دستکاری در رکورد ${verify.data.brokenAt}`}</Badge>}
      />
      <Card>
        <input className="input mb" style={{ maxWidth: 320 }} placeholder="فیلتر عملیات (مثلاً attendance یا vote)" value={action} onChange={(e) => { setAction(e.target.value); setPage(1); }} />
        <div className="table-wrap">
          <table className="table small">
            <thead>
              <tr>
                <th>زمان</th>
                <th>کاربر</th>
                <th>عملیات</th>
                <th>موجودیت</th>
                <th>دلیل</th>
                <th>IP</th>
              </tr>
            </thead>
            <tbody>
              {data?.items.map((l: any) => (
                <tr key={l.id} title={JSON.stringify({ before: l.before, after: l.after }, null, 1)}>
                  <td>{dateTimeFa(l.created_at)}</td>
                  <td>{l.user_name ?? 'سامانه'}</td>
                  <td className="ltr">{l.action}</td>
                  <td className="ltr">
                    {l.entity}
                    {l.entity_id ? `:${String(l.entity_id).slice(0, 8)}` : ''}
                  </td>
                  <td>{l.reason ?? ''}</td>
                  <td className="ltr">{l.ip}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {data && <Pager page={page} pageSize={data.pageSize} total={data.total} onPage={setPage} />}
      </Card>
    </>
  );
}

export function ProfilePage() {
  const { me, refreshMe } = useAuth();
  const [pw, setPw] = useState({ currentPassword: '', newPassword: '' });
  const [mfa, setMfa] = useState<{ secret: string; otpauthUrl: string } | null>(null);
  const [code, setCode] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<Error | null>(null);
  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setErr(null);
    setMsg(null);
    try {
      await fn();
      setMsg(ok);
    } catch (e) {
      setErr(e as Error);
    }
  };
  return (
    <>
      <PageHeader title="پروفایل و امنیت" subtitle={`${me!.full_name} — ${me!.email ?? me!.mobile ?? ''}`} />
      {msg && <div className="alert alert-success">{msg}</div>}
      <ErrorBox error={err} />
      <div className="grid grid-2">
        <Card title="تغییر رمز عبور">
          <Field label="رمز فعلی">
            <input className="input ltr" type="password" value={pw.currentPassword} onChange={(e) => setPw({ ...pw, currentPassword: e.target.value })} />
          </Field>
          <Field label="رمز جدید" hint="حداقل ۸ کاراکتر؛ پس از تغییر، سایر نشست‌ها خارج می‌شوند">
            <input className="input ltr" type="password" value={pw.newPassword} onChange={(e) => setPw({ ...pw, newPassword: e.target.value })} />
          </Field>
          <Button onClick={() => run(() => post('/auth/password', pw), 'رمز عبور تغییر کرد')}>ثبت</Button>
        </Card>
        <Card title="ورود دومرحله‌ای (MFA)">
          {me!.mfa_enabled ? (
            <div className="alert alert-success">ورود دومرحله‌ای برای حساب شما فعال است.</div>
          ) : !mfa ? (
            <>
              <p className="muted small">با برنامه‌هایی مانند Google Authenticator یا Microsoft Authenticator امنیت حساب را افزایش دهید.</p>
              <Button onClick={() => run(async () => setMfa(await post('/auth/mfa/setup')), 'کلید ایجاد شد')}>فعال‌سازی</Button>
            </>
          ) : (
            <>
              <p className="small">کلید زیر را در برنامه Authenticator وارد کنید و سپس کد ۶ رقمی را ثبت نمایید:</p>
              <code className="ltr" style={{ display: 'block', padding: 8, background: 'var(--surface-2)', borderRadius: 6, wordBreak: 'break-all' }}>
                {mfa.secret}
              </code>
              <Field label="کد تأیید">
                <input className="input ltr" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} />
              </Field>
              <Button onClick={() => run(async () => { await post('/auth/mfa/enable', { code }); await refreshMe(); setMfa(null); }, 'ورود دومرحله‌ای فعال شد')}>تأیید</Button>
            </>
          )}
        </Card>
      </div>
      <Card title="عضویت‌های من" className="mt">
        {me!.memberships.length === 0 && <Empty>عضویت فعالی ندارید.</Empty>}
        <ul className="list">
          {me!.memberships.map((m) => (
            <li key={m.id}>
              <Link to={`/commissions/${m.commission_id}`}>{m.commission_name}</Link> <span className="muted small">— {m.chamber_name}</span>
            </li>
          ))}
        </ul>
      </Card>
    </>
  );
}

export function SearchPage() {
  const [params] = useSearchParams();
  const q = params.get('q') ?? '';
  const { data } = useApi(`/search?q=${encodeURIComponent(q)}`, [q]);
  return (
    <>
      <PageHeader title={`نتایج جستجو: ${q}`} />
      {!data ? (
        <Loading />
      ) : (
        <div className="grid grid-3">
          <Card title="کمیسیون‌ها">
            {data.commissions.length === 0 && <Empty>موردی یافت نشد.</Empty>}
            <ul className="list">
              {data.commissions.map((c: any) => (
                <li key={c.id}>
                  <Link to={`/commissions/${c.id}`}>{c.name}</Link>
                </li>
              ))}
            </ul>
          </Card>
          <Card title="جلسات">
            {data.meetings.length === 0 && <Empty>موردی یافت نشد.</Empty>}
            <ul className="list">
              {data.meetings.map((m: any) => (
                <li key={m.id}>
                  <Link to={`/meetings/${m.id}`}>{m.title}</Link>
                  <div className="muted small">
                    {m.commission_name} — {dateFa(m.scheduled_at)}
                  </div>
                </li>
              ))}
            </ul>
          </Card>
          <Card title="مصوبات">
            {data.resolutions.length === 0 && <Empty>موردی یافت نشد.</Empty>}
            <ul className="list">
              {data.resolutions.map((r: any) => (
                <li key={r.id}>
                  <Link to={`/resolutions/${r.id}`}>{fa(r.number)}</Link>
                  <div className="small">{r.text}</div>
                </li>
              ))}
            </ul>
          </Card>
        </div>
      )}
    </>
  );
}
