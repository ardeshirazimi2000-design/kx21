import { JALALI_MONTHS, jalaliMonthLength, toGregorian, toJalali } from '@kx/shared';
import { useEffect, useRef, useState } from 'react';

const fa = (v: number | string) => String(v).replace(/\d/g, (d) => '۰۱۲۳۴۵۶۷۸۹'[Number(d)]);
/** Saturday-first week (the Iranian week). */
export const WEEK_HEADER = ['ش', 'ی', 'د', 'س', 'چ', 'پ', 'ج'];

export type JDate = [number, number, number];

export const jalaliOf = (d: Date): JDate => toJalali(d.getFullYear(), d.getMonth() + 1, d.getDate());
export const dateOfJalali = ([y, m, d]: JDate, hour = 12, minute = 0) => {
  const [gy, gm, gd] = toGregorian(y, m, d);
  return new Date(gy, gm - 1, gd, hour, minute);
};
/** Column (0 = Saturday … 6 = Friday) of the first day of a Jalali month. */
export const firstColumn = (y: number, m: number) => (dateOfJalali([y, m, 1]).getDay() + 1) % 7;

export function shiftMonth(y: number, m: number, delta: number): [number, number] {
  const idx = y * 12 + (m - 1) + delta;
  return [Math.floor(idx / 12), (idx % 12) + 1];
}

/** Drawn chevron (font glyphs like «›» are mirrored or unclear in RTL text). */
function Chevron({ dir, double }: { dir: 'left' | 'right'; double?: boolean }) {
  const p = dir === 'right' ? 'M6 3l5 5-5 5' : 'M10 3L5 8l5 5';
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {double ? (
        <>
          <path d={p} transform="translate(-3 0)" />
          <path d={p} transform="translate(3 0)" />
        </>
      ) : (
        <path d={p} />
      )}
    </svg>
  );
}

/** Month grid used by the date picker. */
function MonthGrid({ value, onPick }: { value: JDate | null; onPick: (d: JDate) => void }) {
  const today = jalaliOf(new Date());
  const [[y, m], setYM] = useState<[number, number]>(() => (value ? [value[0], value[1]] : [today[0], today[1]]));
  const days = jalaliMonthLength(y, m);
  const lead = firstColumn(y, m);
  const cells: (number | null)[] = [...Array(lead).fill(null), ...Array.from({ length: days }, (_, i) => i + 1)];
  while (cells.length % 7) cells.push(null);
  const same = (a: JDate | null, d: number) => !!a && a[0] === y && a[1] === m && a[2] === d;
  return (
    <div className="jp-pop" role="dialog" aria-label="انتخاب تاریخ">
      <div className="jp-head">
        <button type="button" dir="ltr" className="jp-nav" onClick={() => setYM(shiftMonth(y, m, -12))} aria-label="سال قبل" title="سال قبل">
          <Chevron dir="right" double />
        </button>
        <button type="button" dir="ltr" className="jp-nav" onClick={() => setYM(shiftMonth(y, m, -1))} aria-label="ماه قبل" title="ماه قبل">
          <Chevron dir="right" />
        </button>
        <strong className="jp-title">
          {JALALI_MONTHS[m - 1]} {fa(y)}
        </strong>
        <button type="button" dir="ltr" className="jp-nav" onClick={() => setYM(shiftMonth(y, m, 1))} aria-label="ماه بعد" title="ماه بعد">
          <Chevron dir="left" />
        </button>
        <button type="button" dir="ltr" className="jp-nav" onClick={() => setYM(shiftMonth(y, m, 12))} aria-label="سال بعد" title="سال بعد">
          <Chevron dir="left" double />
        </button>
      </div>
      <div className="jp-grid">
        {WEEK_HEADER.map((w, i) => (
          <span key={w} className={`jp-wd ${i === 6 ? 'jp-fri' : ''}`}>
            {w}
          </span>
        ))}
        {cells.map((d, i) =>
          d === null ? (
            <span key={`e${i}`} />
          ) : (
            <button
              key={d}
              type="button"
              className={`jp-day ${i % 7 === 6 ? 'jp-fri' : ''} ${same(today, d) ? 'jp-today' : ''} ${same(value, d) ? 'jp-sel' : ''}`}
              onClick={() => onPick([y, m, d])}
            >
              {fa(d)}
            </button>
          ),
        )}
      </div>
      <div className="jp-foot">
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => onPick(today)}>
          امروز
        </button>
      </div>
    </div>
  );
}

const HOURS = Array.from({ length: 24 }, (_, i) => i);
const MINUTES = [0, 15, 30, 45];
const two = (n: number) => String(n).padStart(2, '0');

/**
 * Jalali date (and optional time) picker: the field opens a month calendar and the user just picks a
 * day; time is chosen from hour/minute lists. Value is an ISO string ('' when empty).
 */
export function JalaliPicker({ value, onChange, withTime = true, placeholder = 'انتخاب تاریخ' }: { value: string; onChange: (iso: string) => void; withTime?: boolean; placeholder?: string }) {
  const current = value ? new Date(value) : null;
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const jd = current ? jalaliOf(current) : null;
  const hour = current ? current.getHours() : 10;
  const minute = current ? current.getMinutes() - (current.getMinutes() % 15) : 0;

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === 'Escape' : !ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', close);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', close);
    };
  }, [open]);

  const emit = (d: JDate, h: number, mi: number) => onChange(dateOfJalali(d, withTime ? h : 12, withTime ? mi : 0).toISOString());
  const label = jd ? `${['یکشنبه', 'دوشنبه', 'سه‌شنبه', 'چهارشنبه', 'پنجشنبه', 'جمعه', 'شنبه'][current!.getDay()]} ${fa(jd[2])} ${JALALI_MONTHS[jd[1] - 1]} ${fa(jd[0])}` : '';

  return (
    <div className="row gap-sm wrap jp" ref={ref}>
      <div className="jp-anchor grow">
        <button type="button" className={`input jp-field ${jd ? '' : 'jp-empty'}`} onClick={() => setOpen(!open)} aria-haspopup="dialog" aria-expanded={open}>
          <span aria-hidden>📅</span> {label || placeholder}
        </button>
        {open && (
          <MonthGrid
            value={jd}
            onPick={(d) => {
              emit(d, hour, minute);
              setOpen(false);
            }}
          />
        )}
      </div>
      {withTime && (
        <div className="row gap-sm" style={{ alignItems: 'center' }} dir="ltr">
          <select className="input" style={{ width: 'auto' }} aria-label="ساعت" value={hour} disabled={!jd} onChange={(e) => jd && emit(jd, Number(e.target.value), minute)}>
            {HOURS.map((h) => (
              <option key={h} value={h}>
                {fa(two(h))}
              </option>
            ))}
          </select>
          <span>:</span>
          <select className="input" style={{ width: 'auto' }} aria-label="دقیقه" value={minute} disabled={!jd} onChange={(e) => jd && emit(jd, hour, Number(e.target.value))}>
            {MINUTES.map((mi) => (
              <option key={mi} value={mi}>
                {fa(two(mi))}
              </option>
            ))}
          </select>
        </div>
      )}
    </div>
  );
}
