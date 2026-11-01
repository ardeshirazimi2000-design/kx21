import { useState } from 'react';
import { Badge, Button, Card, dateFa, Empty, ErrorBox, Field, Loading, PageHeader, type Tone } from '../components/ui';
import { del, post } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useApi } from '../lib/hooks';

type Role = 'system_it' | 'chamber_admin' | 'it_admin' | 'auditor' | 'national';

const ROLES: { key: Role; label: string; tone: Tone; scope: 'system' | 'chamber' | 'either'; does: string; never: string }[] = [
  {
    key: 'system_it',
    label: 'مدیر فناوری اطلاعات سامانه',
    tone: 'accent',
    scope: 'system',
    does: 'تعریف اتاق‌ها، اشخاص، حساب‌های ورود و رمز، نقش‌ها و تنظیمات امنیتی در همهٔ اتاق‌ها',
    never: 'دیدن محتوای جلسات و مصوبات، اقدام در فرآیندها، خواندن رویدادنگاری',
  },
  {
    key: 'it_admin',
    label: 'مدیر فناوری اطلاعات اتاق',
    tone: 'info',
    scope: 'chamber',
    does: 'حساب‌های ورود و رمز، فعال و غیرفعال کردن حساب‌ها، نقش‌ها و دسترسی‌ها و کلیدهای یکپارچه‌سازی همان اتاق',
    never: 'اقدام در فرآیندها، خواندن رویدادنگاری',
  },
  {
    key: 'chamber_admin',
    label: 'مدیر اتاق',
    tone: 'success',
    scope: 'chamber',
    does: 'دوره‌ها، کمیسیون‌ها، اعضا، گزارش‌ها، تنظیمات اطلاع‌رسانی، بازگشایی صورتجلسه با ذکر دلیل',
    never: 'تعریف رمز و حساب ورود (با مدیر فناوری است)، خواندن رویدادنگاری',
  },
  {
    key: 'national',
    label: 'دبیرخانهٔ ملی',
    tone: 'warning',
    scope: 'system',
    does: 'داشبورد آماری همهٔ اتاق‌ها؛ ادارهٔ شبکه‌های کمیسیون‌ها و پیشنهادهای ملی',
    never: 'دیدن جلسات، صورتجلسات و مصوبات اتاق‌ها؛ تعریف کاربر و نقش',
  },
  {
    key: 'auditor',
    label: 'ممیز امنیت',
    tone: 'danger',
    scope: 'either',
    does: 'خواندن و جست‌وجوی رویدادنگاری و بررسی سلامت زنجیرهٔ آن؛ مشاهدهٔ تنظیمات امنیتی (ممیز کل سامانه)',
    never: 'هر تغییری؛ هم‌زمان نقش مدیریتی داشتن',
  },
];
const LABEL = Object.fromEntries(ROLES.map((r) => [r.key, r])) as Record<Role, (typeof ROLES)[number]>;

/**
 * «نقش‌های مدیریتی» (AFTA separation of duties): the system's IT administrator hands out the administrative roles;
 * the security auditor is never also an administrator, and nobody changes their own roles.
 */
export function StaffRolesPage() {
  const { me } = useAuth();
  const { data, error, reload } = useApi<{ items: any[]; warnings: string[] }>('/staff-roles');
  const chambers = useApi<any[]>('/chambers');
  const [q, setQ] = useState('');
  const people = useApi<any>(q.trim().length >= 2 ? `/people?q=${encodeURIComponent(q.trim())}&pageSize=10` : null, [q]);
  const [person, setPerson] = useState<any | null>(null);
  const [role, setRole] = useState<Role>('auditor');
  const [chamberId, setChamberId] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<Error | null>(null);
  if (!me?.is_super_admin) return <ErrorBox error={new Error('این بخش فقط برای مدیر فناوری اطلاعات سامانه است')} />;
  if (error) return <ErrorBox error={error} />;
  if (!data) return <Loading />;

  const act = async (fn: () => Promise<unknown>) => {
    setErr(null);
    setBusy(true);
    try {
      await fn();
      await reload();
      return true;
    } catch (e) {
      setErr(e as Error);
      return false;
    } finally {
      setBusy(false);
    }
  };
  const spec = LABEL[role];
  const needsChamber = spec.scope === 'chamber';
  const grant = () =>
    act(() => post('/staff-roles', { userId: person.id, role, chamberId: spec.scope === 'system' ? null : chamberId || null })).then((ok) => {
      if (ok) {
        setPerson(null);
        setQ('');
      }
    });

  const byPerson = new Map<string, { fullName: string; email: string | null; roles: any[] }>();
  for (const r of data.items) {
    const p = byPerson.get(r.userId) ?? { fullName: r.fullName, email: r.email, roles: [] as any[] };
    p.roles.push(r);
    byPerson.set(r.userId, p);
  }

  return (
    <>
      <PageHeader title="نقش‌های مدیریتی" subtitle="تفکیک وظایف مدیریت فناوری، ممیزی امنیت و فرآیندها (الزام سند افتا)؛ هر تغییر در رویدادنگاری ثبت می‌شود" />
      <ErrorBox error={err} />
      {data.warnings.length > 0 && (
        <div className="alert alert-warning">
          <strong>توصیه‌های تفکیک وظایف</strong>
          <ul style={{ margin: '6px 0 0', paddingInlineStart: 18 }}>
            {data.warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </div>
      )}

      <Card title="واگذاری نقش">
        <div className="grid grid-2">
          <Field group label="شخص" hint="نام، موبایل، ایمیل یا کد ملی؛ شخص باید حساب ورود فعال داشته باشد">
            {person ? (
              <div className="row gap-sm">
                <strong>{person.full_name}</strong>
                <span className="muted small">{person.chamber_name}</span>
                <Button size="sm" variant="ghost" onClick={() => setPerson(null)}>
                  تغییر
                </Button>
              </div>
            ) : (
              <>
                <input className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="جست‌وجو…" />
                {people.data?.items?.length > 0 && (
                  <ul className="list" style={{ maxHeight: 220, overflow: 'auto' }}>
                    {people.data.items.map((p: any) => (
                      <li key={p.id}>
                        <button type="button" className="link-btn" onClick={() => setPerson(p)} disabled={!p.can_login}>
                          {p.full_name}
                        </button>{' '}
                        <span className="muted small">
                          — {p.chamber_name}
                          {!p.can_login && ' (بدون حساب ورود)'}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </>
            )}
          </Field>
          <Field label="نقش" hint={`${spec.does}`}>
            <select className="input" value={role} onChange={(e) => setRole(e.target.value as Role)}>
              {ROLES.map((r) => (
                <option key={r.key} value={r.key}>
                  {r.label}
                </option>
              ))}
            </select>
          </Field>
          {spec.scope !== 'system' && (
            <Field label="اتاق" hint={spec.scope === 'either' ? 'خالی: ممیز همهٔ اتاق‌ها' : undefined}>
              <select className="input" value={chamberId} onChange={(e) => setChamberId(e.target.value)}>
                <option value="">{spec.scope === 'either' ? 'همهٔ اتاق‌ها' : '—'}</option>
                {(chambers.data ?? []).map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </Field>
          )}
        </div>
        <Button busy={busy} disabled={!person || (needsChamber && !chamberId)} onClick={() => void grant()}>
          واگذاری نقش
        </Button>
      </Card>

      <Card title="دارندگان نقش‌ها">
        {byPerson.size === 0 && <Empty>نقشی ثبت نشده است.</Empty>}
        <table className="table">
          <tbody>
            {[...byPerson.entries()].map(([userId, p]) => (
              <tr key={userId}>
                <td>
                  <strong>{p.fullName}</strong>
                  {p.email && <div className="muted small ltr">{p.email}</div>}
                </td>
                <td>
                  <div className="row gap-sm wrap">
                    {p.roles.map((r: any) => (
                      <span key={`${r.role}-${r.chamberId}`} className="row gap-sm" style={{ alignItems: 'center' }}>
                        <Badge tone={LABEL[r.role as Role].tone}>
                          {LABEL[r.role as Role].label}
                          {r.chamberName ? ` — ${r.chamberName}` : r.role === 'auditor' ? ' — همهٔ اتاق‌ها' : ''}
                        </Badge>
                        {userId !== me.id && (
                          <button
                            type="button"
                            className="link-btn small"
                            style={{ color: 'var(--danger)' }}
                            title={`برداشتن نقش${r.grantedAt ? ` (از ${dateFa(r.grantedAt)})` : ''}`}
                            disabled={busy}
                            onClick={() =>
                              confirm(`نقش «${LABEL[r.role as Role].label}» از ${p.fullName} برداشته شود؟ نشست‌های باز او بسته می‌شود.`) &&
                              void act(() => del('/staff-roles', { userId, role: r.role, chamberId: r.chamberId }))
                            }
                          >
                            برداشتن
                          </button>
                        )}
                      </span>
                    ))}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      <Card title="شرح نقش‌ها">
        <table className="table">
          <thead>
            <tr>
              <th>نقش</th>
              <th>کارها</th>
              <th>نمی‌تواند</th>
            </tr>
          </thead>
          <tbody>
            {ROLES.map((r) => (
              <tr key={r.key}>
                <td>
                  <Badge tone={r.tone}>{r.label}</Badge>
                </td>
                <td className="small">{r.does}</td>
                <td className="small muted">{r.never}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </>
  );
}
