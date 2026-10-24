import { formatJalaliDate, formatTime } from '@kx/shared';
import type { ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { useApi } from '../lib/hooks';
import { notificationLink } from '../lib/notifyAlert';
import { fa } from './ui';

/**
 * Top of the dashboard: welcome banner, the user's numbers, latest notifications, upcoming meetings, quick
 * access and the chamber's overall figures.
 */

const Svg = ({ d, size = 22 }: { d: string; size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d={d} />
  </svg>
);
const I = {
  calendar: 'M4 6h16v14H4zM4 10h16M8 3v4M16 3v4M8 14h2M12 14h2M8 17h2M12 17h2',
  folder: 'M3 7a1 1 0 0 1 1-1h5l2 2h9a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z',
  people: 'M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM2 20a7 7 0 0 1 14 0M16 4.5a3.5 3.5 0 0 1 0 6.5M19 20a7 7 0 0 0-3-5.7',
  doc: 'M14 3H6v18h12V7zM14 3v4h4M9 12h6M9 16h6',
  megaphone: 'M3 11v2a1 1 0 0 0 1 1h3l6 4V6L7 10H4a1 1 0 0 0-1 1zM17 9a4 4 0 0 1 0 6',
  grid: 'M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z',
  chart: 'M4 20V10M10 20V4M16 20v-7M22 20H2',
  user: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0',
  bell: 'M6 16V11a6 6 0 0 1 12 0v5l2 2H4zM10 21h4',
  arrow: 'M15 6l-6 6 6 6',
  bank: 'M3 10l9-6 9 6M5 10v8M9.5 10v8M14.5 10v8M19 10v8M3 20h18',
  network: 'M12 5a2 2 0 1 0 0-.01M5 19a2 2 0 1 0 0-.01M19 19a2 2 0 1 0 0-.01M12 7v4M12 11l-6 6M12 11l6 6',
};
const TINTS = ['violet', 'blue', 'green', 'slate'] as const;

function StatCard({ title, value, sub, icon, tint, to }: { title: string; value: number | undefined; sub: string; icon: string; tint: (typeof TINTS)[number]; to: string }) {
  return (
    <Link to={to} className="dash-stat">
      <div>
        <div className="dash-stat-title">{title}</div>
        <div className="dash-stat-value">{value === undefined ? '…' : fa(value)}</div>
        <div className="dash-stat-sub">{sub}</div>
      </div>
      <span className={`dash-icon dash-${tint}`}>
        <Svg d={icon} size={26} />
      </span>
    </Link>
  );
}

function Panel({ title, icon, more, children }: { title: string; icon: string; more?: string; children: ReactNode }) {
  return (
    <section className="dash-panel">
      <header>
        <h2>
          <span className="dash-panel-icon">
            <Svg d={icon} size={20} />
          </span>
          {title}
        </h2>
        {more && <Link to={more}>مشاهده همه</Link>}
      </header>
      {children}
    </section>
  );
}

/** Short label of a notification's kind. */
const kindOf = (event: string) =>
  event.startsWith('meeting') || event.startsWith('vote') || event.startsWith('minutes')
    ? { label: 'جلسه', tone: 'blue' }
    : event.startsWith('resolution')
      ? { label: 'مصوبه', tone: 'green' }
      : event.startsWith('network')
        ? { label: 'شبکه', tone: 'violet' }
        : { label: 'اطلاعیه', tone: 'slate' };

export function DashboardOverview({ upcoming }: { upcoming: any[] | undefined }) {
  const nav = useNavigate();
  const { me, isAdmin, chamberId } = useAuth();
  const overview = useApi<{ mine: Record<string, number>; overall: Record<string, number>; scope: string | null }>(
    `/me/overview${isAdmin && chamberId ? `?chamberId=${chamberId}` : ''}`,
  );
  const notes = useApi<{ items: any[] }>('/notifications?pageSize=4');
  const isOfficer = me!.memberships.some((m) => ['chair', 'vice_chair', 'secretary'].includes(m.position));
  const mine = overview.data?.mine;
  const all = overview.data?.overall;
  const quick: [string, string, string][] = [
    ['/meetings', 'جلسات', I.calendar],
    ['/resolutions', 'مصوبات', I.doc],
    ['/commissions', 'کمیسیون‌ها', I.people],
    ['/notifications', 'اعلان‌ها', I.bell],
    isAdmin || isOfficer ? ['/reports', 'گزارش‌ها', I.chart] : ['/networks', 'شبکه‌ها', I.network],
    ['/profile', 'پروفایل', I.user],
  ];

  return (
    <div className="dash">
      <section className="dash-banner">
        <div className="dash-banner-text">
          <img src="/iran-chamber-logo.png" width={84} height={84} alt="" />
          <div>
            <h1>به پلتفرم کمیسیون‌های تخصصی</h1>
            <p className="dash-banner-sub">اتاق بازرگانی، صنایع، معادن و کشاورزی ایران خوش آمدید</p>
            <p className="dash-banner-tag">
              همکاری، مشورت، توسعه بخش خصوصی <span className="dash-rule" />
            </p>
          </div>
        </div>
        <div className="dash-banner-photo" role="img" aria-label="ساختمان اتاق بازرگانی، صنایع، معادن و کشاورزی ایران" />
      </section>

      <div className="dash-stats">
        <StatCard title="رویدادهای پیش رو" value={mine?.upcoming} sub="جلسهٔ پیش رو" icon={I.calendar} tint="violet" to="/meetings" />
        <StatCard title={isAdmin && chamberId ? 'کمیسیون‌های اتاق' : 'کمیسیون‌های من'} value={mine?.commissions} sub="کمیسیون فعال" icon={I.folder} tint="blue" to="/commissions" />
        <StatCard title="جلسات برگزار شده" value={mine?.meetings_this_month} sub="در ماه جاری" icon={I.people} tint="green" to="/meetings" />
        <StatCard title="مصوبات کمیسیون‌ها" value={mine?.open_resolutions} sub="مصوبهٔ در دست اجرا" icon={I.doc} tint="slate" to="/resolutions" />
      </div>

      <div className="dash-row">
        <Panel title="دسترسی سریع" icon={I.grid}>
          <div className="dash-quick">
            {quick.map(([to, label, icon]) => (
              <Link key={to} to={to} className="dash-tile">
                <span className="dash-icon dash-blue">
                  <Svg d={icon} />
                </span>
                {label}
              </Link>
            ))}
          </div>
        </Panel>
        <Panel title="جلسات پیش رو" icon={I.calendar} more="/meetings">
          {upcoming && upcoming.length === 0 && <p className="dash-empty">جلسه‌ای برای شما برنامه‌ریزی نشده است.</p>}
          <ul className="dash-list">
            {(upcoming ?? []).slice(0, 4).map((m: any, i: number) => (
              <li key={m.id}>
                <button type="button" onClick={() => nav(`/meetings/${m.id}`)}>
                  <span className={`dash-icon dash-${TINTS[i % TINTS.length]}`}>
                    <Svg d={I.people} size={20} />
                  </span>
                  <span className="dash-list-main">
                    <strong>{m.title}</strong>
                    <span>
                      {m.commission_name} — {formatJalaliDate(m.scheduled_at)} <span className="dash-sep">|</span> ساعت {fa(formatTime(m.scheduled_at))}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </Panel>
        <Panel title="آخرین اطلاعیه‌ها" icon={I.megaphone} more="/notifications">
          {notes.data?.items.length === 0 && <p className="dash-empty">اطلاعیه‌ای ندارید.</p>}
          <ul className="dash-list">
            {(notes.data?.items ?? []).map((n: any) => {
              const k = kindOf(n.event);
              return (
                <li key={n.id} className={n.read_at ? '' : 'dash-unread'}>
                  <button type="button" onClick={() => nav(notificationLink(n))}>
                    <span className="dash-list-main">
                      <span className={`dash-tag dash-${k.tone}`}>{k.label}</span>
                      <strong>{n.title}</strong>
                    </span>
                    <span className="dash-date">{formatJalaliDate(n.created_at)}</span>
                    <span className="dash-arrow">
                      <Svg d={I.arrow} size={16} />
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </Panel>
      </div>

      <div className="dash-bottom">
        <section className="dash-panel dash-totals">
          <header>
            <h2>
              <span className="dash-panel-icon">
                <Svg d={I.chart} size={20} />
              </span>
              آمار کلی{overview.data?.scope ? ` — ${overview.data.scope}` : ''}
            </h2>
          </header>
          <div className="dash-totals-grid">
            <div>
              <strong>{all ? fa(all.resolutions_this_year) : '…'}</strong>
              <span>مصوبه در سال جاری</span>
            </div>
            <div>
              <strong>{all ? fa(all.meetings_this_year) : '…'}</strong>
              <span>جلسه در سال جاری</span>
            </div>
            <div>
              <strong>{all ? fa(all.members) : '…'}</strong>
              <span>عضو فعال</span>
            </div>
            <div>
              <strong>{all ? fa(all.commissions) : '…'}</strong>
              <span>کمیسیون تخصصی</span>
            </div>
          </div>
        </section>
        <section className="dash-quote">
          <div>
            <p>«تقویت بخش خصوصی، موتور محرک اقتصاد ملی است.»</p>
            <span>اتاق بازرگانی، صنایع، معادن و کشاورزی ایران</span>
          </div>
          <span className="dash-icon dash-blue dash-quote-icon">
            <Svg d={I.bank} size={30} />
          </span>
        </section>
      </div>
    </div>
  );
}
