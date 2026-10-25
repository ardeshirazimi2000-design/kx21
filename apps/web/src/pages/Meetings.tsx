import { formatTime, JALALI_MONTHS, jalaliMonthLength, MEETING_TYPE_LABELS, MEETING_TYPES, toGregorian, toJalali, type MeetingType } from '@kx/shared';
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArchivalMeetingModal } from '../components/Archival';
import { MeetingStatusBadge } from '../components/status';
import { dateOfJalali, firstColumn, jalaliOf, WEEK_HEADER } from '../components/JalaliPicker';
import { Badge, Button, Card, dateTimeFa, Empty, ErrorBox, Field, fa, JalaliDateTimeInput, Loading, Modal, PageHeader } from '../components/ui';
import { post } from '../lib/api';
import { useAuth } from '../lib/auth';
import { confirmHoliday } from '../lib/holidays';
import { useApi } from '../lib/hooks';

export function MeetingsPage() {
  const nav = useNavigate();
  const { me, chamberId } = useAuth();
  const now = new Date();
  const today = toJalali(now.getFullYear(), now.getMonth() + 1, now.getDate());
  const [[jy, jm], setMonth] = useState<[number, number]>([today[0], today[1]]);
  // Years offered in the picker: the archive of past terms and a few years ahead.
  const years = useMemo(() => {
    const from = Math.min(today[0] - 15, jy);
    const to = Math.max(today[0] + 5, jy);
    return Array.from({ length: to - from + 1 }, (_, i) => to - i);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jy]);
  const [mine, setMine] = useState(false);
  const range = useMemo(() => {
    const [gy, gm, gd] = toGregorian(jy, jm, 1);
    const [ny, nm] = jm === 12 ? [jy + 1, 1] : [jy, jm + 1];
    const [gy2, gm2, gd2] = toGregorian(ny, nm, 1);
    return { from: new Date(gy, gm - 1, gd).toISOString(), to: new Date(gy2, gm2 - 1, gd2).toISOString() };
  }, [jy, jm]);
  const { data, loading, reload } = useApi(`/meetings?from=${range.from}&to=${range.to}&pageSize=100&mine=${mine}`);
  const holidays = useApi<Holiday[]>(`/holidays?${chamberId ? `chamberId=${chamberId}&` : ''}from=${gDay(jy, jm, 1)}&to=${gDay(jy, jm, jalaliMonthLength(jy, jm))}`);
  const [open, setOpen] = useState<false | { date?: string }>(false);
  const [recording, setRecording] = useState(false);
  // Meetings are created by each commission's secretary/chair (executive work), not by the chamber admin.
  const canCreate = me!.memberships.some((m) => ['chair', 'vice_chair', 'secretary'].includes(m.position));
  const shift = (d: number) => {
    const n = jy * 12 + (jm - 1) + d;
    setMonth([Math.floor(n / 12), (n % 12) + 1]);
  };

  const byDay = useMemo(() => {
    const groups = new Map<string, any[]>();
    for (const m of data?.items ?? []) {
      const d = new Date(m.scheduled_at);
      const key = fa(toJalali(d.getFullYear(), d.getMonth() + 1, d.getDate())[2]);
      groups.set(key, [...(groups.get(key) ?? []), m]);
    }
    return [...groups.entries()];
  }, [data]);

  return (
    <>
      <PageHeader
        title="تقویم جلسات"
        actions={
          <>
            <label className="check" style={{ margin: 0 }}>
              <input type="checkbox" checked={mine} onChange={(e) => setMine(e.target.checked)} /> فقط جلسات من
            </label>
            {canCreate && (
              <Button variant="secondary" onClick={() => setRecording(true)}>
                ثبت جلسهٔ برگزارشده (سوابق)
              </Button>
            )}
            {canCreate && <Button onClick={() => setOpen({})}>جلسه جدید</Button>}
          </>
        }
      />
      {recording && (
        <ArchivalMeetingModal
          commissions={me!.memberships
            .filter((m) => ['chair', 'vice_chair', 'secretary'].includes(m.position))
            .map((m) => ({ id: m.commission_id, name: m.commission_name }))}
          onClose={() => setRecording(false)}
        />
      )}
      <Card>
        <div className="row between wrap gap-sm mb cal-nav">
          <span className="row gap-sm">
            <Button variant="secondary" size="sm" onClick={() => shift(-12)} title="همین ماه در سال قبل">
              سال قبل
            </Button>
            <Button variant="secondary" size="sm" onClick={() => shift(-1)}>
              ماه قبل
            </Button>
          </span>
          <span className="row gap-sm">
            <select className="input cal-pick" value={jm} onChange={(e) => setMonth([jy, Number(e.target.value)])} aria-label="ماه">
              {JALALI_MONTHS.map((name, i) => (
                <option key={name} value={i + 1}>
                  {name}
                </option>
              ))}
            </select>
            <select className="input cal-pick" value={jy} onChange={(e) => setMonth([Number(e.target.value), jm])} aria-label="سال">
              {years.map((y) => (
                <option key={y} value={y}>
                  {fa(y)}
                </option>
              ))}
            </select>
            {(jy !== today[0] || jm !== today[1]) && (
              <Button variant="ghost" size="sm" onClick={() => setMonth([today[0], today[1]])}>
                امروز
              </Button>
            )}
          </span>
          <span className="row gap-sm">
            <Button variant="secondary" size="sm" onClick={() => shift(1)}>
              ماه بعد
            </Button>
            <Button variant="secondary" size="sm" onClick={() => shift(12)} title="همین ماه در سال بعد">
              سال بعد
            </Button>
          </span>
        </div>
        <MonthCalendar
          year={jy}
          month={jm}
          meetings={data?.items ?? []}
          holidays={holidays.data ?? []}
          onOpen={(id) => nav(`/meetings/${id}`)}
          onPickDay={canCreate ? (date) => setOpen({ date }) : undefined}
        />
        {canCreate && <p className="muted small mt">برای تعریف جلسه، روی روز مورد نظر در تقویم بزنید.</p>}
      </Card>
      <Card title="فهرست جلسات این ماه">
        {loading && !data ? (
          <Loading />
        ) : byDay.length === 0 ? (
          <Empty>در این ماه جلسه‌ای ثبت نشده است.</Empty>
        ) : (
          byDay.map(([day, items]) => (
            <div key={day} className="row gap" style={{ alignItems: 'flex-start', borderBottom: '1px solid var(--border)', padding: '10px 0' }}>
              <div style={{ width: 56, textAlign: 'center' }}>
                <div style={{ fontSize: '1.5rem', fontWeight: 700 }}>{day}</div>
                <div className="muted small">{JALALI_MONTHS[jm - 1]}</div>
              </div>
              <div className="grow col gap-sm">
                {items.map((m) => (
                  <div key={m.id} className="agenda-item row between gap wrap" style={{ cursor: 'pointer', marginBottom: 0 }} onClick={() => nav(`/meetings/${m.id}`)}>
                    <div>
                      <strong>
                        {m.commission_name} — جلسه {fa(m.number)}
                      </strong>
                      <div>{m.title}</div>
                      <div className="muted small">
                        {dateTimeFa(m.scheduled_at)} — {MEETING_TYPE_LABELS[m.type as MeetingType]}
                        {m.location ? ` — ${m.location}` : ''}
                      </div>
                    </div>
                    <div className="row gap-sm">
                      {m.my_role && <Badge tone="info">دعوت‌شده</Badge>}
                      <MeetingStatusBadge status={m.status} />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))
        )}
      </Card>
      {open && <NewMeetingModal initialDate={open.date} onClose={() => setOpen(false)} onSaved={(id) => { setOpen(false); void reload(); nav(`/meetings/${id}`); }} />}
    </>
  );
}

export function NewMeetingModal({ commissionId, initialDate, onClose, onSaved }: { commissionId?: string; initialDate?: string; onClose: () => void; onSaved: (id: string) => void }) {
  const { me } = useAuth();
  const webinar = !!me?.features?.webinar;
  const commissions = useApi(commissionId ? null : '/commissions?pageSize=100');
  const options = (commissions.data?.items ?? []).filter(
    (c: any) => ['chair', 'vice_chair', 'secretary'].includes(c.my_position),
  );
  const [form, setForm] = useState({
    commissionId: commissionId ?? '',
    title: '',
    scheduledAt: initialDate ?? '',
    durationMinutes: 90,
    type: 'in_person' as MeetingType,
    location: '',
    onlineLink: '',
  });
  const [agenda, setAgenda] = useState<string[]>(['']);
  const [err, setErr] = useState<Error | null>(null);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      const r = await confirmHoliday((allowHoliday) =>
        post('/meetings', {
          ...form,
          commissionId: form.commissionId || options[0]?.id,
          location: form.location || null,
          onlineLink: form.onlineLink || null,
          agenda: agenda.filter((a) => a.trim().length >= 2).map((title) => ({ title })),
          schedule: true,
          allowHoliday,
        }),
      );
      if (r) onSaved(r.id);
    } catch (e) {
      setErr(e as Error);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title="جلسه جدید" wide onClose={onClose} footer={<Button busy={busy} onClick={save}>ایجاد جلسه</Button>}>
      <ErrorBox error={err} />
      {!commissionId && (
        <Field label="کمیسیون">
          <select className="input" value={form.commissionId || options[0]?.id || ''} onChange={(e) => setForm({ ...form, commissionId: e.target.value })}>
            {options.map((c: any) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </Field>
      )}
      <Field label="عنوان جلسه">
        <input className="input" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
      </Field>
      <div className="grid grid-3">
        <Field label="تاریخ و ساعت (شمسی)">
          <JalaliDateTimeInput value={form.scheduledAt} onChange={(v) => setForm({ ...form, scheduledAt: v })} />
        </Field>
        <Field label="مدت (دقیقه)">
          <input className="input" type="number" value={form.durationMinutes} onChange={(e) => setForm({ ...form, durationMinutes: Number(e.target.value) })} />
        </Field>
        <Field label="نوع جلسه">
          <select className="input" value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value as MeetingType })}>
            {MEETING_TYPES.map((t) => (
              <option key={t} value={t}>
                {MEETING_TYPE_LABELS[t]}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <div className="grid grid-2">
        {form.type !== 'online' && (
          <Field label="مکان">
            <input className="input" value={form.location} onChange={(e) => setForm({ ...form, location: e.target.value })} />
          </Field>
        )}
        {form.type !== 'in_person' && (
          <Field
            label={webinar ? 'لینک پلتفرم دیگر (اختیاری)' : 'لینک جلسه آنلاین'}
            hint={webinar ? 'وبینار داخلی سامانه برای این جلسه خودکار آماده می‌شود؛ فقط اگر از پلتفرم دیگری (مثل اسکای‌روم) استفاده می‌کنید لینک آن را وارد کنید.' : undefined}
          >
            <input className="input ltr" value={form.onlineLink} onChange={(e) => setForm({ ...form, onlineLink: e.target.value })} />
          </Field>
        )}
      </div>
      <h3 className="mb">دستور جلسه</h3>
      {agenda.map((a, i) => (
        <div className="row gap-sm mb" key={i}>
          <span className="muted">{fa(i + 1)}.</span>
          <input className="input" value={a} onChange={(e) => setAgenda(agenda.map((x, j) => (j === i ? e.target.value : x)))} />
          <Button variant="ghost" size="sm" onClick={() => setAgenda(agenda.filter((_, j) => j !== i))}>
            حذف
          </Button>
        </div>
      ))}
      <Button variant="secondary" size="sm" onClick={() => setAgenda([...agenda, ''])}>
        + آیتم
      </Button>
      <p className="muted small mt">همه اعضای فعال کمیسیون (به‌جز کارشناسان) به‌صورت خودکار دعوت می‌شوند؛ مدعوین را بعداً در صفحه جلسه اضافه کنید.</p>
    </Modal>
  );
}

const LIVE = ['checkin_open', 'in_progress', 'agenda_processing'];

/** Month grid (Saturday-first) with the meetings of each day; clicking a day can start a new meeting. */
type Holiday = { date: string; title: string; source: string };
const pad2 = (n: number) => String(n).padStart(2, '0');
/** Gregorian YYYY-MM-DD of a Jalali day. */
const gDay = (jy: number, jm: number, jd: number) => {
  const [y, m, d] = toGregorian(jy, jm, jd);
  return `${y}-${pad2(m)}-${pad2(d)}`;
};

function MonthCalendar({
  year,
  month,
  meetings,
  holidays,
  onOpen,
  onPickDay,
}: {
  year: number;
  month: number;
  meetings: any[];
  holidays: Holiday[];
  onOpen: (id: string) => void;
  onPickDay?: (iso: string) => void;
}) {
  const holidayOf = new Map(holidays.map((h) => [h.date, h]));
  const today = jalaliOf(new Date());
  const lead = firstColumn(year, month);
  const days = jalaliMonthLength(year, month);
  const byDay = new Map<number, any[]>();
  for (const m of meetings) {
    const [y, mo, d] = jalaliOf(new Date(m.scheduled_at));
    if (y === year && mo === month) byDay.set(d, [...(byDay.get(d) ?? []), m]);
  }
  const cells: (number | null)[] = [...Array(lead).fill(null), ...Array.from({ length: days }, (_, i) => i + 1)];
  while (cells.length % 7) cells.push(null);
  return (
    <div className="cal" role="grid" aria-label={`${JALALI_MONTHS[month - 1]} ${year}`}>
      {WEEK_HEADER.map((w, i) => (
        <div key={w} className={`cal-wd ${i === 6 ? 'jp-fri' : ''}`}>
          <span className="cal-wd-long">{['شنبه', 'یکشنبه', 'دوشنبه', 'سه‌شنبه', 'چهارشنبه', 'پنجشنبه', 'جمعه'][i]}</span>
          <span className="cal-wd-short">{w}</span>
        </div>
      ))}
      {cells.map((d, i) => {
        if (d === null) return <div key={`e${i}`} className="cal-cell cal-out" />;
        const isToday = today[0] === year && today[1] === month && today[2] === d;
        const items = byDay.get(d) ?? [];
        const holiday = holidayOf.get(gDay(year, month, d));
        // Fridays are already shown in red; other holidays get their occasion written in the cell.
        const occasion = holiday && holiday.source !== 'friday' ? holiday.title.replace(/،? ?جمعه$/, '') : null;
        return (
          <div
            key={d}
            className={`cal-cell ${isToday ? 'cal-today' : ''} ${onPickDay ? 'cal-pickable' : ''} ${holiday ? 'cal-holiday' : ''}`}
            onClick={() => onPickDay?.(dateOfJalali([year, month, d], 10, 0).toISOString())}
            title={holiday ? `تعطیل: ${holiday.title}` : onPickDay ? 'تعریف جلسه در این روز' : undefined}
          >
            <div className={`cal-num ${i % 7 === 6 || holiday ? 'jp-fri' : ''}`}>
              <span>{fa(d)}</span>
              {onPickDay && <span className="cal-add">+ جلسه</span>}
            </div>
            {occasion && <div className="cal-occasion">{occasion}</div>}
            {items.map((m) => (
              <button
                key={m.id}
                type="button"
                className={`cal-ev ${LIVE.includes(m.status) ? 'cal-ev-live' : ''} ${m.status === 'cancelled' ? 'cal-ev-cancelled' : ''}`}
                title={`${m.commission_name} — جلسه ${fa(m.number)}: ${m.title}`}
                onClick={(e) => {
                  e.stopPropagation();
                  onOpen(m.id);
                }}
              >
                {fa(formatTime(m.scheduled_at))} {m.title}
              </button>
            ))}
          </div>
        );
      })}
    </div>
  );
}
