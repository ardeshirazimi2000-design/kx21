import {
  formatJalaliDate,
  formatTime,
  parseJalali,
  toLatinDigits,
  toPersianDigits,
} from '@kx/shared';
import { useEffect, useState, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import type { ApiError } from '../lib/api';
import { JalaliPicker } from './JalaliPicker';

export const fa = (v: string | number | null | undefined) => (v === null || v === undefined ? '—' : toPersianDigits(v));

export function Button({
  variant = 'primary',
  size,
  busy,
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'danger' | 'ghost' | 'success'; size?: 'sm' | 'lg'; busy?: boolean }) {
  return (
    <button {...rest} disabled={rest.disabled || busy} className={`btn btn-${variant} ${size ? `btn-${size}` : ''} ${rest.className ?? ''}`}>
      {busy ? <span className="spinner" aria-hidden /> : null}
      {children}
    </button>
  );
}

export type Tone = 'neutral' | 'info' | 'success' | 'warning' | 'danger' | 'accent';

export function Badge({ tone = 'neutral', children }: { tone?: Tone; children: ReactNode }) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

export function Card({ title, actions, children, className }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`card ${className ?? ''}`}>
      {(title || actions) && (
        <header className="card-head">
          {title && <h2>{title}</h2>}
          {actions && <div className="row gap-sm">{actions}</div>}
        </header>
      )}
      {children}
    </section>
  );
}

/**
 * «بازگشت»: the previous page in this tab, or — for a page opened directly (link, notification, new tab) —
 * its parent page (/meetings/123 → /meetings, a top-level page → the dashboard).
 */
export function BackButton() {
  const nav = useNavigate();
  const loc = useLocation();
  if (loc.pathname === '/') return null;
  const back = () => {
    const idx = (window.history.state as { idx?: number } | null)?.idx ?? 0;
    if (idx > 0) nav(-1);
    else nav(loc.pathname.split('/').filter(Boolean).slice(0, -1).join('/').replace(/^/, '/'));
  };
  return (
    <button type="button" className="back-btn" onClick={back} aria-label="بازگشت به صفحه قبل" title="بازگشت به صفحه قبل">
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M6 3l5 5-5 5" />
      </svg>
      بازگشت
    </button>
  );
}

export function PageHeader({ title, subtitle, actions }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="page-head">
      <div>
        <BackButton />
        <h1>{title}</h1>
        {subtitle && <p className="muted">{subtitle}</p>}
      </div>
      {actions && <div className="row gap-sm wrap">{actions}</div>}
    </div>
  );
}

export function Field({ label, hint, children, error }: { label: string; hint?: string; children: ReactNode; error?: string }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint && !error && <span className="field-hint">{hint}</span>}
      {error && <span className="field-error">{error}</span>}
    </label>
  );
}

export function Modal({ title, onClose, children, footer, wide }: { title: string; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${wide ? 'modal-wide' : ''}`} role="dialog" aria-modal aria-label={title}>
        <header className="modal-head">
          <h3>{title}</h3>
          <button className="icon-btn" onClick={onClose} aria-label="بستن">
            ×
          </button>
        </header>
        <div className="modal-body">{children}</div>
        {footer && <footer className="modal-foot">{footer}</footer>}
      </div>
    </div>
  );
}

export function ErrorBox({ error }: { error: ApiError | Error | null | undefined }) {
  if (!error) return null;
  const details = (error as ApiError).details as { path: string; message: string }[] | undefined;
  return (
    <div className="alert alert-danger" role="alert">
      {error.message}
      {Array.isArray(details) && details.length > 0 && (
        <ul>
          {details.map((d, i) => (
            <li key={i}>{d.message}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

export function Loading() {
  return (
    <div className="loading">
      <span className="spinner" /> در حال بارگذاری…
    </div>
  );
}

export function Stat({ label, value, tone, hint }: { label: string; value: ReactNode; tone?: Tone; hint?: string }) {
  return (
    <div className={`stat ${tone ? `stat-${tone}` : ''}`}>
      <div className="stat-value">{value}</div>
      <div className="stat-label">{label}</div>
      {hint && <div className="stat-hint">{hint}</div>}
    </div>
  );
}

export function Progress({ value }: { value: number }) {
  return (
    <div className="progress" role="progressbar" aria-valuenow={value} aria-valuemin={0} aria-valuemax={100}>
      <div style={{ width: `${Math.max(0, Math.min(100, value))}%` }} />
      <span>{fa(value)}٪</span>
    </div>
  );
}

export function Tabs<T extends string>({ tabs, value, onChange }: { tabs: { id: T; label: ReactNode }[]; value: T; onChange: (v: T) => void }) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map((t) => (
        <button key={t.id} role="tab" aria-selected={value === t.id} className={value === t.id ? 'tab active' : 'tab'} onClick={() => onChange(t.id)}>
          {t.label}
        </button>
      ))}
    </div>
  );
}

/** Jalali date + time input (month calendar picker). Value is an ISO string (or '' when empty). */
export function JalaliDateTimeInput({ value, onChange, withTime = true }: { value: string; onChange: (iso: string) => void; withTime?: boolean }) {
  return <JalaliPicker value={value} onChange={onChange} withTime={withTime} />;
}

/** Jalali date input returning 'YYYY-MM-DD' (Gregorian, for DATE columns). */
export function JalaliDateInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <JalaliDateTimeInput
      withTime={false}
      value={value ? `${value}T12:00:00` : ''}
      onChange={(iso) => {
        const d = new Date(iso);
        onChange(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`);
      }}
    />
  );
}

export function dateFa(d: string | Date | null | undefined) {
  if (!d) return '—';
  return formatJalaliDate(typeof d === 'string' && d.length === 10 ? `${d}T12:00:00` : d);
}

export function dateTimeFa(d: string | Date | null | undefined) {
  if (!d) return '—';
  return `${formatJalaliDate(d)} ${formatTime(d)}`;
}

export function Pager({ page, pageSize, total, onPage }: { page: number; pageSize: number; total: number; onPage: (p: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (pages <= 1) return null;
  return (
    <div className="pager">
      <Button variant="ghost" size="sm" disabled={page <= 1} onClick={() => onPage(page - 1)}>
        قبلی
      </Button>
      <span>
        صفحه {fa(page)} از {fa(pages)}
      </span>
      <Button variant="ghost" size="sm" disabled={page >= pages} onClick={() => onPage(page + 1)}>
        بعدی
      </Button>
    </div>
  );
}
