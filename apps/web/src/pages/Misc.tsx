import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Badge, Button, Card, dateFa, dateTimeFa, Empty, ErrorBox, Field, fa, JalaliDateInput, Loading, PageHeader, Pager } from '../components/ui';
import { download, post } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useApi, usePasswordRules } from '../lib/hooks';
import { desktopPermission, notificationLink, playChime, requestDesktop, setSoundEnabled, soundEnabled } from '../lib/notifyAlert';

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

const EVENT_LINK = (n: any) => {
  const to = notificationLink(n);
  return to === '/notifications' ? null : to;
};

/** Tells the menu badge to recount unread notifications. */
export const NOTIFICATIONS_CHANGED = 'kx:notifications-changed';
const changed = () => void window.dispatchEvent(new Event(NOTIFICATIONS_CHANGED));

/** How new notifications get the user's attention in this browser: sound and desktop notifications. */
function AlertSettings() {
  const [sound, setSound] = useState(soundEnabled());
  const [desktop, setDesktop] = useState(desktopPermission());
  return (
    <Card className="mb">
      <div className="row between wrap gap-sm" style={{ alignItems: 'center' }}>
        <label className="check" style={{ margin: 0 }}>
          <input
            type="checkbox"
            checked={sound}
            onChange={(e) => {
              setSoundEnabled(e.target.checked);
              setSound(e.target.checked);
              if (e.target.checked) playChime();
            }}
          />{' '}
          🔔 پخش صدا هنگام رسیدن اعلان تازه
        </label>
        <Button size="sm" variant="ghost" onClick={playChime}>
          آزمایش صدا
        </Button>
      </div>
      <p className="muted small" style={{ marginBottom: 0 }}>
        {desktop === 'granted'
          ? 'اعلان‌های تازه وقتی این صفحه پشت پنجره‌های دیگر است، در گوشهٔ صفحهٔ رایانه هم نمایش داده می‌شوند.'
          : desktop === 'unsupported'
            ? 'وقتی سامانه باز است، اعلان تازه با صدا و یک کادر در گوشهٔ صفحه نمایش داده می‌شود. نمایش اعلان روی دسکتاپ رایانه (وقتی پنجرهٔ دیگری باز است) به نشانی امن (https) نیاز دارد.'
            : 'وقتی سامانه باز است، اعلان تازه با صدا و یک کادر در گوشهٔ صفحه نمایش داده می‌شود.'}
        {(desktop === 'default' || desktop === 'denied') && (
          <>
            {' '}
            <Button size="sm" variant="secondary" disabled={desktop === 'denied'} onClick={() => void requestDesktop().then((p) => setDesktop(p))}>
              {desktop === 'denied' ? 'اعلان دسکتاپ در تنظیمات مرورگر بسته شده است' : 'فعال‌سازی اعلان روی دسکتاپ'}
            </Button>
          </>
        )}
      </p>
    </Card>
  );
}

export function NotificationsPage() {
  const nav = useNavigate();
  const [page, setPage] = useState(1);
  const { data, reload } = useApi(`/notifications?page=${page}`);
  return (
    <>
      <PageHeader title="اعلان‌ها" actions={<Button variant="secondary" onClick={() => post('/notifications/read-all').then(changed).then(reload)}>علامت‌گذاری همه به‌عنوان خوانده‌شده</Button>} />
      <AlertSettings />
      <Card>
        {data?.items.length === 0 && <Empty>اعلانی ندارید.</Empty>}
        <ul className="list">
          {data?.items.map((n: any) => (
            <li
              key={n.id}
              style={{ cursor: 'pointer', fontWeight: n.read_at ? 400 : 600 }}
              onClick={async () => {
                if (!n.read_at) await post(`/notifications/${n.id}/read`).then(changed);
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

/** Persian names of the security-relevant events; others show their code. */
const AUDIT_LABELS: Record<string, string> = {
  'auth.login': 'ورود',
  'auth.login_failed': 'ورود ناموفق',
  'auth.account_locked': 'قفل موقت حساب',
  'auth.password_changed': 'تغییر رمز عبور',
  'auth.mfa_enabled': 'فعال‌سازی ورود دومرحله‌ای',
  'security.policy_changed': 'تغییر تنظیمات امنیتی',
  'staff.role_granted': 'واگذاری نقش مدیریتی',
  'staff.role_revoked': 'برداشتن نقش مدیریتی',
  'chamber.admin_added': 'تعیین مدیر اتاق',
  'chamber.admin_removed': 'برداشتن مدیر اتاق',
  'audit.viewed': 'مشاهدهٔ رویدادنگاری',
  'document.downloaded': 'دریافت فایل',
  'document.opened': 'مشاهدهٔ فایل',
  'document.uploaded': 'بارگذاری فایل',
  'document.deleted': 'حذف فایل',
  'transcript.requested': 'درخواست تبدیل فایل جلسه به متن',
  'transcript.cancelled': 'لغو تبدیل فایل جلسه به متن',
  'minutes.transcript_applied': 'افزودن شرح مذاکرات از فایل صوتی به صورتجلسه',
  'report.resolutions_exported': 'خروجی مصوبات (CSV)',
  'report.activity_exported': 'خروجی گزارش دوره‌ای',
};

const NO_FILTER = { person: '', action: '', ip: '', from: '', to: '', order: 'desc' };

export function AuditPage() {
  const { me } = useAuth();
  const [page, setPage] = useState(1);
  // Filters apply on «نمایش», not on every keystroke: each query of the log is itself recorded.
  const [form, setForm] = useState(NO_FILTER);
  const [applied, setApplied] = useState(NO_FILTER);
  const qs = Object.entries(applied)
    .filter(([k, v]) => v && !(k === 'order' && v === 'desc'))
    .map(([k, v]) => `&${k}=${encodeURIComponent(v)}`)
    .join('');
  const { data } = useApi(`/audit?page=${page}&pageSize=50${qs}`);
  // The auditor of every chamber checks the whole chain; a chamber's auditor that chamber's.
  const verify = useApi(me?.auditAll ? '/audit/verify' : me?.auditChambers[0] ? `/audit/verify?chamberId=${me.auditChambers[0]}` : null);
  const apply = (f = form) => {
    setApplied(f);
    setPage(1);
  };
  return (
    <>
      <PageHeader
        title="رویدادنگاری (Audit Log)"
        subtitle="ثبت غیرقابل‌تغییر تمام تغییرات حساس، به‌صورت زنجیره هش؛ مشاهدهٔ این صفحه هم ثبت می‌شود"
        actions={verify.data && <Badge tone={verify.data.intact ? 'success' : 'danger'}>{verify.data.intact ? 'زنجیره سالم است' : `دستکاری در رکورد ${verify.data.brokenAt}`}</Badge>}
      />
      <Card>
        <form
          className="audit-filters mb"
          onSubmit={(e) => {
            e.preventDefault();
            apply();
          }}
        >
          <Field label="شخص">
            <input className="input" placeholder="نام، ایمیل یا موبایل" value={form.person} onChange={(e) => setForm({ ...form, person: e.target.value })} />
          </Field>
          <Field label="نوع رویداد">
            <input className="input ltr" placeholder="auth, document, vote…" value={form.action} onChange={(e) => setForm({ ...form, action: e.target.value })} list="audit-actions" />
            <datalist id="audit-actions">
              {Object.entries(AUDIT_LABELS).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </datalist>
          </Field>
          <Field label="نشانی IP">
            <input className="input ltr" value={form.ip} onChange={(e) => setForm({ ...form, ip: e.target.value })} />
          </Field>
          <Field label="از تاریخ">
            <JalaliDateInput value={form.from} onChange={(v) => setForm({ ...form, from: v })} />
          </Field>
          <Field label="تا تاریخ">
            <JalaliDateInput value={form.to} onChange={(v) => setForm({ ...form, to: v })} />
          </Field>
          <Field label="ترتیب">
            <select className="input" value={form.order} onChange={(e) => setForm({ ...form, order: e.target.value })}>
              <option value="desc">جدیدترین اول</option>
              <option value="asc">قدیمی‌ترین اول</option>
            </select>
          </Field>
          <div className="row gap-sm" style={{ alignSelf: 'end' }}>
            <Button type="submit">نمایش</Button>
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                setForm(NO_FILTER);
                apply(NO_FILTER);
              }}
            >
              پاک کردن
            </Button>
          </div>
        </form>
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
                  <td>{AUDIT_LABELS[l.action] ?? <span className="ltr">{l.action}</span>}</td>
                  <td className="ltr">
                    {l.entity}
                    {l.entity_id ? `:${String(l.entity_id).slice(0, 8)}` : ''}
                  </td>
                  <td>{l.reason ?? ''}</td>
                  <td className="ltr">{l.ip?.replace(/^::ffff:/, '')}</td>
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
  const passwordRules = usePasswordRules();
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
          <Field label="رمز جدید" hint={`${passwordRules}؛ پس از تغییر، نشست‌های شما در دستگاه‌های دیگر بسته می‌شوند`}>
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
