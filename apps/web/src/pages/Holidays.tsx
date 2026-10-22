import { toGregorian, toJalali } from '@kx/shared';
import { useState } from 'react';
import { Badge, Button, Card, dateFa, Empty, ErrorBox, Field, fa, JalaliDateInput, Modal, PageHeader } from '../components/ui';
import { del, post } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useApi } from '../lib/hooks';

/**
 * Holidays of the meetings calendar: Fridays are automatic; here the Super Admin adds a year's official holidays
 * (reviewed from the bundled list) and other nationwide holidays, and a chamber admin its province's own.
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
  const [reviewing, setReviewing] = useState(false);
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
          جمعه‌ها خودکار در تقویم می‌آیند. تعطیلات رسمی هر سال را با دکمهٔ «تعطیلات رسمی سال…» در پایین یک‌جا ثبت کنید؛ اینجا روزهای دیگر را اضافه کنید، مثل تعطیلی‌های اعلام‌شده یا مناسبت‌های استانی.
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
        {superAdmin && (
          <div className="row gap-sm wrap mb" style={{ alignItems: 'center' }}>
            <Button variant="secondary" onClick={() => setReviewing(true)}>
              تعطیلات رسمی سال {fa(year)}…
            </Button>
            <span className="muted small">فهرست تعطیلات رسمی سال را می‌بینید، بررسی می‌کنید و یک‌جا ثبت می‌کنید.</span>
          </div>
        )}
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

      {reviewing && (
        <OfficialHolidaysModal
          year={year}
          onClose={() => setReviewing(false)}
          onSaved={() => {
            setReviewing(false);
            void reload();
          }}
        />
      )}
    </>
  );
}

/**
 * A year's official holidays (from the bundled dataset, or the fixed solar ones for other years) for the
 * Super Admin to review before adding them as nationwide holidays.
 */
function OfficialHolidaysModal({ year, onClose, onSaved }: { year: number; onClose: () => void; onSaved: () => void }) {
  const { data } = useApi<{ source: 'dataset' | 'solar'; missing: string[]; items: { date: string; jalali: string; title: string; exists: boolean }[] }>(
    `/holidays/official?year=${year}`,
  );
  const [skip, setSkip] = useState<Set<string>>(new Set());
  const [err, setErr] = useState<Error | null>(null);
  const [busy, setBusy] = useState(false);
  const fresh = (data?.items ?? []).filter((i) => !i.exists);
  const chosen = fresh.filter((i) => !skip.has(i.date));
  const save = async () => {
    setBusy(true);
    setErr(null);
    try {
      await post('/holidays/official', { year, dates: chosen.map((i) => i.date) });
      onSaved();
    } catch (e) {
      setErr(e as Error);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title={`تعطیلات رسمی سال ${fa(year)}`}
      wide
      onClose={onClose}
      footer={
        <Button busy={busy} disabled={!chosen.length} onClick={() => void save()}>
          ثبت {fa(chosen.length)} روز به‌عنوان تعطیلی سراسری
        </Button>
      }
    >
      <ErrorBox error={err} />
      {!data ? (
        <p className="muted">در حال بارگذاری…</p>
      ) : (
        <>
          {data.source === 'dataset' ? (
            <p className="small muted" style={{ marginTop: 0 }}>
              از مجموعه دادهٔ تعطیلات رسمی ایران. پیش از ثبت با تقویم رسمی همان سال مقایسه کنید و هر روزی را که نمی‌خواهید از انتخاب خارج کنید.
            </p>
          ) : (
            <p className="small muted" style={{ marginTop: 0 }}>
              برای این سال فقط تعطیلات ثابت شمسی در دسترس است؛ تعطیلات قمری را از تقویم رسمی دستی اضافه کنید.
            </p>
          )}
          {data.missing.length > 0 && (
            <div className="small mb" style={{ color: 'var(--danger)' }}>
              این مناسبت‌ها در منبع نیامده‌اند؛ تاریخشان را از تقویم رسمی پیدا کنید و با «افزودن تعطیلی» ثبت کنید: {data.missing.join('، ')}
            </div>
          )}
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th />
                  <th>تاریخ</th>
                  <th>روز</th>
                  <th>مناسبت</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((i) => (
                  <tr key={i.date} style={{ opacity: i.exists ? 0.55 : 1 }}>
                    <td>
                      <input
                        type="checkbox"
                        aria-label={i.title}
                        disabled={i.exists}
                        checked={i.exists || !skip.has(i.date)}
                        onChange={(e) => {
                          const next = new Set(skip);
                          if (e.target.checked) next.delete(i.date);
                          else next.add(i.date);
                          setSkip(next);
                        }}
                      />
                    </td>
                    <td>{dateFa(i.date)}</td>
                    <td className="small">{weekday(i.date)}</td>
                    <td>
                      {i.title}
                      {i.exists && <span className="muted small"> (قبلاً ثبت شده)</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </Modal>
  );
}
