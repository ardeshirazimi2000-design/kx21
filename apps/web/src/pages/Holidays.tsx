import { toGregorian, toJalali } from '@kx/shared';
import { useState } from 'react';
import { Badge, Button, Card, dateFa, dateTimeFa, Empty, ErrorBox, Field, fa, JalaliDateInput, PageHeader } from '../components/ui';
import { del, post } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useApi } from '../lib/hooks';

/**
 * Holidays of the meetings calendar: Fridays and the official calendar (web service) are automatic; here the
 * Super Admin adds nationwide holidays and a chamber admin its province's own (e.g. a local occasion).
 */

const pad = (n: number) => String(n).padStart(2, '0');
const gDay = (jy: number, jm: number, jd: number) => {
  const [y, m, d] = toGregorian(jy, jm, jd);
  return `${y}-${pad(m)}-${pad(d)}`;
};
const weekday = (date: string) => new Date(`${date}T12:00:00`).toLocaleDateString('fa-IR', { weekday: 'long' });

export function HolidaysPage() {
  const { me, chamberId } = useAuth();
  const superAdmin = !!me?.is_super_admin;
  const now = new Date();
  const thisYear = toJalali(now.getFullYear(), now.getMonth() + 1, now.getDate())[0];
  const [year, setYear] = useState(thisYear);
  const { data, reload } = useApi<any[]>(`/holidays/defined?${chamberId ? `chamberId=${chamberId}&` : ''}from=${gDay(year, 1, 1)}&to=${gDay(year + 1, 1, 1)}`);
  const chambers = useApi<any[]>('/chambers');
  const chamberName = chambers.data?.find((c) => c.id === chamberId)?.name;
  const canEdit = (h: any) => (h.chamber_id ? superAdmin || me!.adminChambers.includes(h.chamber_id) : superAdmin);

  const [form, setForm] = useState({ date: '', title: '', scope: superAdmin ? 'national' : 'chamber' });
  const [err, setErr] = useState<Error | null>(null);
  const [busy, setBusy] = useState(false);
  const add = async () => {
    setBusy(true);
    setErr(null);
    try {
      await post('/holidays', { chamberId: form.scope === 'national' ? null : chamberId, date: form.date, title: form.title.trim() });
      setForm({ ...form, date: '', title: '' });
      void reload();
    } catch (e) {
      setErr(e as Error);
    } finally {
      setBusy(false);
    }
  };
  const remove = async (h: any) => {
    if (!confirm(`تعطیلی «${h.title}» (${dateFa(h.date)}) حذف شود؟`)) return;
    try {
      await del(`/holidays/${h.id}`);
      void reload();
    } catch (e) {
      setErr(e as Error);
    }
  };

  return (
    <>
      <PageHeader title="تعطیلات" subtitle="روزهای تعطیل در تقویم جلسات مشخص می‌شوند و برای تعریف جلسه در آن‌ها تأیید گرفته می‌شود." />
      <Card title="افزودن تعطیلی" className="mb">
        <ErrorBox error={err} />
        <p className="muted small" style={{ marginTop: 0 }}>
          جمعه‌ها و تعطیلات رسمی تقویم (از سرویس تقویم رسمی) خودکار در تقویم می‌آیند. اینجا روزهایی را اضافه کنید که در تقویم رسمی نیستند؛ مثل تعطیلی‌های اعلام‌شده یا مناسبت‌های استانی.
        </p>
        <div className="grid grid-3">
          <Field label="تاریخ">
            <JalaliDateInput value={form.date} onChange={(date) => setForm({ ...form, date })} />
          </Field>
          <Field label="عنوان">
            <input className="input" value={form.title} maxLength={120} placeholder="مثلاً تعطیلی به دلیل آلودگی هوا" onChange={(e) => setForm({ ...form, title: e.target.value })} />
          </Field>
          <Field label="محدوده">
            <select className="input" value={form.scope} onChange={(e) => setForm({ ...form, scope: e.target.value })} disabled={!superAdmin}>
              {superAdmin && <option value="national">سراسری (همه اتاق‌ها)</option>}
              {chamberId && <option value="chamber">فقط {chamberName ?? 'این اتاق'}</option>}
            </select>
          </Field>
        </div>
        <Button busy={busy} disabled={!form.date || form.title.trim().length < 2 || (form.scope === 'chamber' && !chamberId)} onClick={() => void add()}>
          افزودن
        </Button>
      </Card>

      <Card
        title="تعطیلات تعریف‌شده"
        className="mb"
        actions={
          <select className="input" style={{ width: 'auto' }} value={year} onChange={(e) => setYear(Number(e.target.value))} aria-label="سال">
            {Array.from({ length: 7 }, (_, i) => thisYear + 2 - i).map((y) => (
              <option key={y} value={y}>
                {fa(y)}
              </option>
            ))}
          </select>
        }
      >
        {data?.length === 0 && <Empty>برای سال {fa(year)} تعطیلی‌ای تعریف نشده است.</Empty>}
        {!!data?.length && (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>تاریخ</th>
                  <th>روز</th>
                  <th>عنوان</th>
                  <th>محدوده</th>
                  <th>ثبت</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {data.map((h) => (
                  <tr key={h.id}>
                    <td>{dateFa(h.date)}</td>
                    <td className="small">{weekday(h.date)}</td>
                    <td>{h.title}</td>
                    <td>{h.chamber_id ? <Badge tone="info">{h.chamber_name}</Badge> : <Badge tone="accent">سراسری</Badge>}</td>
                    <td className="small muted">{h.created_by_name}</td>
                    <td>
                      {canEdit(h) && (
                        <Button size="sm" variant="ghost" onClick={() => void remove(h)}>
                          <span style={{ color: 'var(--danger)' }}>حذف</span>
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <OfficialCalendar superAdmin={superAdmin} />
    </>
  );
}

/** Status of the official calendar web service; the Super Admin can test it with a day. */
function OfficialCalendar({ superAdmin }: { superAdmin: boolean }) {
  const { data, reload } = useApi<{ provider: string; enabled: boolean; url: string; cachedDays: number; lastCheckedAt: string | null }>('/holidays/service');
  const [date, setDate] = useState('');
  const [result, setResult] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  if (!data) return null;
  const test = async () => {
    setBusy(true);
    try {
      setResult(await post('/holidays/service/test', { date }));
      void reload();
    } finally {
      setBusy(false);
    }
  };
  const clear = async () => {
    if (!confirm('پاسخ‌های ذخیره‌شده سرویس پاک شود؟ روزها دوباره از سرویس پرسیده می‌شوند.')) return;
    await del('/holidays/service/cache');
    void reload();
  };
  return (
    <Card title="سرویس تقویم رسمی">
      {data.enabled ? (
        <p style={{ marginTop: 0 }}>
          <Badge tone="success">فعال</Badge> <span className="muted small ltr">{data.url}</span>
          <br />
          <span className="muted small">
            پاسخ {fa(data.cachedDays)} روز ذخیره شده است{data.lastCheckedAt ? ` — آخرین پرسش: ${dateTimeFa(data.lastCheckedAt)}` : ''}. هر روز یک بار از سرویس پرسیده و تا ۳۰ روز نگه داشته می‌شود.
          </span>
        </p>
      ) : (
        <p className="muted" style={{ marginTop: 0 }}>
          <Badge>غیرفعال</Badge> فقط جمعه‌ها و تعطیلات تعریف‌شده در این صفحه در نظر گرفته می‌شوند. برای فعال‌سازی، توکن سرویس (همان توکن استعلام هویت) باید در تنظیمات سرور باشد.
        </p>
      )}
      {superAdmin && data.enabled && (
        <>
          <div className="row gap-sm wrap" style={{ alignItems: 'end' }}>
            <Field label="آزمایش با یک روز">
              <JalaliDateInput value={date} onChange={setDate} />
            </Field>
            <Button variant="secondary" busy={busy} disabled={!date} onClick={() => void test()}>
              پرسش از سرویس
            </Button>
            <Button variant="ghost" onClick={() => void clear()}>
              پاک کردن پاسخ‌های ذخیره‌شده
            </Button>
          </div>
          {result && (
            <div className="mt">
              {result.ok ? (
                <p>
                  {result.isHoliday ? <Badge tone="danger">تعطیل</Badge> : <Badge tone="success">کاری</Badge>} {result.title}
                </p>
              ) : (
                <p style={{ color: 'var(--danger)' }}>{result.error}</p>
              )}
              <details>
                <summary className="small muted">پاسخ خام سرویس</summary>
                <pre className="ltr small" style={{ whiteSpace: 'pre-wrap' }}>
                  {JSON.stringify(result.raw ?? null, null, 2)}
                </pre>
              </details>
            </div>
          )}
        </>
      )}
    </Card>
  );
}
