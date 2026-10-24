import { useEffect, useState, type ReactNode } from 'react';
import { Link, Navigate, NavLink, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { roleLabel } from '@kx/shared';
import { Loading, fa } from './components/ui';
import { useAuth } from './lib/auth';
import { post } from './lib/api';
import { useApi, useSocket } from './lib/hooks';
import { notificationLink, playChime, setTitleCount, showDesktop, soundEnabled, unlockAudioOnFirstGesture, type LiveNotification } from './lib/notifyAlert';
import { AuditPage } from './pages/Audit';
import { ChambersPage } from './pages/Chambers';
import { CommissionDetailPage } from './pages/CommissionDetail';
import { CommissionsPage } from './pages/Commissions';
import { HomePage } from './pages/Home';
import { IntegrationsPage } from './pages/Integrations';
import { LoginPage } from './pages/Login';
import { MeetingRoomPage } from './pages/MeetingRoom';
import { MeetingsPage } from './pages/Meetings';
import { NetworkDetailPage, NetworksPage } from './pages/Networks';
import { NotificationSettingsPage } from './pages/NotificationSettings';
import { NOTIFICATIONS_CHANGED, NotificationsPage } from './pages/Notifications';
import { PeoplePage } from './pages/People';
import { ProfilePage } from './pages/Profile';
import { ReferralsPage } from './pages/Referrals';
import { ReportsPage } from './pages/Reports';
import { ResolutionDetailPage } from './pages/ResolutionDetail';
import { ResolutionsPage } from './pages/Resolutions';
import { RolesPage } from './pages/Roles';
import { HolidaysPage } from './pages/Holidays';
import { SearchPage } from './pages/Search';
import { TermsPage } from './pages/Terms';

export function App() {
  const { me, loading } = useAuth();
  if (loading) return <Loading />;
  if (!me) {
    return (
      <Routes>
        <Route path="*" element={<LoginPage />} />
      </Routes>
    );
  }
  return (
    <Shell>
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/chambers" element={<ChambersPage />} />
        <Route path="/terms" element={<TermsPage />} />
        <Route path="/commissions" element={<CommissionsPage />} />
        <Route path="/commissions/:id" element={<CommissionDetailPage />} />
        <Route path="/people" element={<PeoplePage />} />
        <Route path="/roles" element={<RolesPage />} />
        <Route path="/holidays" element={<HolidaysPage />} />
        <Route path="/notification-settings" element={<NotificationSettingsPage />} />
        <Route path="/integrations" element={<IntegrationsPage />} />
        <Route path="/meetings" element={<MeetingsPage />} />
        <Route path="/meetings/:id" element={<MeetingRoomPage />} />
        <Route path="/resolutions" element={<ResolutionsPage />} />
        <Route path="/resolutions/:id" element={<ResolutionDetailPage />} />
        <Route path="/networks" element={<NetworksPage />} />
        <Route path="/networks/:id" element={<NetworkDetailPage />} />
        <Route path="/referrals" element={<ReferralsPage />} />
        <Route path="/notifications" element={<NotificationsPage />} />
        <Route path="/reports" element={<ReportsPage />} />
        <Route path="/audit" element={<AuditPage />} />
        <Route path="/profile" element={<ProfilePage />} />
        <Route path="/search" element={<SearchPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Shell>
  );
}

function Shell({ children }: { children: ReactNode }) {
  const { me, logout, isAdmin, chamberId, setChamberId } = useAuth();
  const chambers = useApi<any[]>(isAdmin ? '/chambers' : null);
  const selectable = (chambers.data ?? []).filter((c) => me!.is_super_admin || me!.adminChambers.includes(c.id));
  // A super admin without a home chamber starts on the first chamber.
  useEffect(() => {
    if (!chamberId && selectable.length) setChamberId(selectable[0].id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chamberId, selectable.length]);
  // Narrow screens: the menu slides in over the page (open). Wide screens: the ☰ button hides or shows the sidebar (hidden, remembered).
  const [open, setOpen] = useState(false);
  const [hidden, setHidden] = useState(() => {
    try {
      return localStorage.getItem('kx.nav.hidden') === '1';
    } catch {
      return false;
    }
  });
  const toggleMenu = () => {
    if (window.matchMedia('(max-width: 900px)').matches) return setOpen(!open);
    setHidden(!hidden);
    try {
      localStorage.setItem('kx.nav.hidden', hidden ? '0' : '1');
    } catch {
      /* storage unavailable */
    }
  };
  const [q, setQ] = useState('');
  const loc = useLocation();
  const nav = useNavigate();
  const unread = useApi<{ total: number }>('/notifications?unread=true&pageSize=1');
  const [toasts, setToasts] = useState<LiveNotification[]>([]);
  useSocket({
    notification: (n: LiveNotification) => {
      void unread.reload();
      if (soundEnabled()) playChime();
      showDesktop(n, nav);
      setToasts((t) => [n, ...t.filter((x) => x.id !== n.id)].slice(0, 3));
      window.setTimeout(() => setToasts((t) => t.filter((x) => x.id !== n.id)), 8000);
    },
  });
  useEffect(() => unlockAudioOnFirstGesture(), []);
  useEffect(() => setTitleCount(unread.data?.total ?? 0), [unread.data?.total]);
  // Reading notifications (here or on another page) updates the unread count.
  useEffect(() => {
    const refresh = () => void unread.reload();
    window.addEventListener(NOTIFICATIONS_CHANGED, refresh);
    return () => window.removeEventListener(NOTIFICATIONS_CHANGED, refresh);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => setOpen(false), [loc.pathname]);
  const isOfficer = me!.memberships.some((m) => ['chair', 'vice_chair', 'secretary'].includes(m.position));
  const isExpert = me!.memberships.some((m) => m.position === 'expert');
  const networks = useApi<any[]>('/networks');

  const item = (to: string, label: string, icon: string, extra?: ReactNode) => (
    <NavLink to={to} end={to === '/'}>
      <NavIcon d={icon} />
      <span>{label}</span>
      {extra}
    </NavLink>
  );
  const unreadCount = unread.data?.total ?? 0;
  const roleText = me!.is_super_admin
    ? 'مدیر سامانه'
    : me!.adminChambers.length
      ? 'مدیر اتاق'
      : me!.memberships[0]
        ? `${roleLabel(me!.memberships[0].position, me!.memberships[0].role_title)} کمیسیون`
        : 'کاربر سامانه';

  return (
    <div className={`app ${hidden ? 'nav-hidden' : ''}`}>
      <header className="appbar">
        <button className="appbar-btn menu-btn" onClick={toggleMenu} aria-label={hidden ? 'نمایش منو' : 'منو'} aria-expanded={!hidden} title={hidden ? 'نمایش منو' : 'بستن منو'}>
          <NavIcon d={ICONS.menu} />
        </button>
        <Link to="/" className="appbar-brand">
          <img src="/iran-chamber-logo.png" width={50} height={50} alt="لوگوی اتاق ایران" />
          <span>
            اتاق بازرگانی، صنایع، معادن و کشاورزی ایران
            <small>سامانه کمیسیون‌های تخصصی</small>
          </span>
        </Link>
        <form
          className="appbar-search"
          role="search"
          onSubmit={(e) => {
            e.preventDefault();
            if (q.trim().length >= 2) nav(`/search?q=${encodeURIComponent(q.trim())}`);
          }}
        >
          <NavIcon d={ICONS.search} />
          <input placeholder="جستجو در کمیسیون‌ها، جلسات و مصوبات…" aria-label="جستجو" value={q} onChange={(e) => setQ(e.target.value)} />
        </form>
        <div className="grow" />
        {selectable.length > 1 && (
          <select
            className="appbar-select"
            aria-label="اتاق"
            value={chamberId ?? ''}
            onChange={(e) => {
              setChamberId(e.target.value);
              nav('/');
            }}
          >
            {selectable.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        )}
        {selectable.length === 1 && <span className="appbar-chamber">{selectable[0].name}</span>}
        <button type="button" className="appbar-btn" onClick={() => void logout()} aria-label="خروج" title="خروج">
          <NavIcon d={ICONS.logout} />
        </button>
        <Link to="/profile" className="appbar-btn" aria-label="پروفایل و امنیت" title="پروفایل و امنیت">
          <NavIcon d={ICONS.settings} />
        </Link>
        <Link to="/notifications" className="appbar-avatar" aria-label={unreadCount ? `اعلان‌ها (${fa(unreadCount)} خوانده‌نشده)` : 'اعلان‌ها'} title="اعلان‌ها">
          <span aria-hidden>{me!.full_name.trim().charAt(0)}</span>
          {unreadCount > 0 && <b className="appbar-badge">{fa(Math.min(unreadCount, 99))}</b>}
        </Link>
        <Link to="/profile" className="appbar-user">
          <strong>{me!.full_name}</strong>
          <small>{roleText}</small>
        </Link>
      </header>
      <div className="shell">
        <aside className={`sidebar ${open ? 'open' : ''}`}>
          <nav className="nav">
            {item('/', 'داشبورد', ICONS.home)}
            <NavGroup id="meetings" title="جلسات و مصوبات" icon={ICONS.calendar} paths={['/meetings', '/resolutions', '/referrals', '/notifications']}>
              {item('/meetings', 'تقویم جلسات', ICONS.calendar)}
              {item('/resolutions', 'مصوبات و پیگیری', ICONS.doc)}
              {(isExpert || isOfficer) && item('/referrals', 'ارجاعات کارشناسی', ICONS.inbox)}
              {item('/notifications', 'اعلان‌ها', ICONS.bell, unreadCount ? <span className="count">{fa(unreadCount)}</span> : null)}
            </NavGroup>
            <NavGroup id="structure" title="کمیسیون‌های تخصصی" icon={ICONS.building} paths={['/commissions', '/terms', '/people', '/roles', '/holidays', '/notification-settings', '/integrations', '/chambers']}>
              {item('/commissions', 'کمیسیون‌ها', ICONS.people)}
              {isAdmin && item('/terms', 'دوره‌ها', ICONS.layers)}
              {(isAdmin || isOfficer) && item('/people', 'اشخاص و کاربران', ICONS.user)}
              {isAdmin && item('/roles', 'نقش‌ها و دسترسی‌ها', ICONS.shield)}
              {isAdmin && item('/holidays', 'تعطیلات', ICONS.sun)}
              {isAdmin && item('/notification-settings', 'تنظیمات اطلاع‌رسانی', ICONS.megaphone)}
              {isAdmin && item('/integrations', 'یکپارچه‌سازی', ICONS.plug)}
              {me!.is_super_admin && item('/chambers', 'اتاق‌ها', ICONS.building)}
            </NavGroup>
            {(me!.is_super_admin || !!networks.data?.length) && (
              <NavGroup id="networks" title="شبکه کمیسیون‌ها" icon={ICONS.network} paths={['/networks']}>
                {item('/networks', 'شبکه‌های موضوعی', ICONS.network)}
              </NavGroup>
            )}
            {(isAdmin || isOfficer) && (
              <NavGroup id="reports" title="گزارش و کنترل" icon={ICONS.chart} paths={['/reports', '/audit']}>
                {item('/reports', 'گزارش‌ها و آمار', ICONS.chart)}
                {isAdmin && item('/audit', 'رویدادنگاری (Audit)', ICONS.list)}
              </NavGroup>
            )}
            <NavGroup id="account" title="حساب کاربری" icon={ICONS.user} paths={['/profile']}>
              {item('/profile', 'پروفایل و امنیت', ICONS.user)}
            </NavGroup>
            <button type="button" className="nav-logout" onClick={() => void logout()}>
              <NavIcon d={ICONS.logout} />
              <span>خروج</span>
            </button>
          </nav>
        </aside>
        {open && <button type="button" className="nav-scrim" aria-label="بستن منو" onClick={() => setOpen(false)} />}
        <div className="main">
          <main className="content">{children}</main>
        </div>
      </div>
      <footer className="app-footer">
        <span>کلیه حقوق مادی و معنوی این سامانه متعلق به اتاق بازرگانی، صنایع، معادن و کشاورزی ایران است.</span>
        <span>نسخه {fa(APP_VERSION)}</span>
      </footer>
      <NotificationToasts
        items={toasts}
        onOpen={(n) => {
          setToasts((t) => t.filter((x) => x.id !== n.id));
          void post(`/notifications/${n.id}/read`).then(() => window.dispatchEvent(new Event(NOTIFICATIONS_CHANGED)));
          nav(notificationLink(n));
        }}
        onClose={(id) => setToasts((t) => t.filter((x) => x.id !== id))}
      />
    </div>
  );
}

const APP_VERSION = '1.1';

/** Line icons of the menu and the top bar (24×24, stroked). */
const ICONS = {
  menu: 'M4 6h16M4 12h16M4 18h16',
  search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM20 20l-4-4',
  home: 'M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z',
  calendar: 'M4 6h16v14H4zM4 10h16M8 3v4M16 3v4M8 14h2M12 14h2M16 14h0M8 17h2M12 17h2',
  doc: 'M14 3H6v18h12V7zM14 3v4h4M9 12h6M9 16h6',
  inbox: 'M4 13l2-8h12l2 8M4 13v6h16v-6M4 13h5l1 2h4l1-2h5',
  bell: 'M6 16V11a6 6 0 0 1 12 0v5l2 2H4zM10 21h4',
  people: 'M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM2 20a7 7 0 0 1 14 0M16 4.5a3.5 3.5 0 0 1 0 6.5M19 20a7 7 0 0 0-3-5.7',
  layers: 'M12 3l9 5-9 5-9-5zM3 13l9 5 9-5',
  user: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0',
  shield: 'M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6z',
  sun: 'M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4',
  megaphone: 'M3 11v2a1 1 0 0 0 1 1h3l6 4V6L7 10H4a1 1 0 0 0-1 1zM17 9a4 4 0 0 1 0 6',
  plug: 'M9 7V3M15 7V3M7 7h10v4a5 5 0 0 1-10 0zM12 16v5',
  building: 'M4 21V5l8-3 8 3v16M9 21v-4h6v4M8 8h2M14 8h2M8 12h2M14 12h2',
  network: 'M12 5a2 2 0 1 0 0-.01M5 19a2 2 0 1 0 0-.01M19 19a2 2 0 1 0 0-.01M12 7v4M12 11l-6 6M12 11l6 6',
  chart: 'M4 20V10M10 20V4M16 20v-7M22 20H2',
  list: 'M9 6h12M9 12h12M9 18h12M4 6h.01M4 12h.01M4 18h.01',
  settings: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-2.7 1.1V21a2 2 0 1 1-4 0v-.1a1.6 1.6 0 0 0-2.7-1.1l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0-1.1-2.7H3a2 2 0 1 1 0-4h.1a1.6 1.6 0 0 0 1.1-2.7l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 2.7-1.1V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 2.7 1.1l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0 1.1 2.7H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1.3z',
  logout: 'M14 4h5a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-5M10 16l-4-4 4-4M6 12h10',
};

function NavIcon({ d }: { d: string }) {
  return (
    <svg className="nav-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={d} />
    </svg>
  );
}

const NAV_KEY = 'kx.nav.collapsed';
const readCollapsed = (): string[] => {
  try {
    return JSON.parse(localStorage.getItem(NAV_KEY) ?? '[]');
  } catch {
    return [];
  }
};

/** Collapsible sidebar group; the group holding the current page always opens. */
/** New notifications pop up in a corner of the screen for a few seconds. */
function NotificationToasts({ items, onOpen, onClose }: { items: LiveNotification[]; onOpen: (n: LiveNotification) => void; onClose: (id: string) => void }) {
  if (!items.length) return null;
  return (
    <div className="toasts" role="status" aria-live="polite">
      {items.map((n) => (
        <div key={n.id} className="toast">
          <button type="button" className="toast-body" onClick={() => onOpen(n)}>
            <strong>🔔 {n.title}</strong>
            <span>{n.body}</span>
          </button>
          <button type="button" className="toast-close" aria-label="بستن" onClick={() => onClose(n.id)}>
            ×
          </button>
        </div>
      ))}
    </div>
  );
}

function NavGroup({ id, title, icon, paths, children }: { id: string; title: string; icon: string; paths: string[]; children: ReactNode }) {
  const loc = useLocation();
  const holdsCurrent = paths.some((p) => loc.pathname === p || loc.pathname.startsWith(`${p}/`));
  const [open, setOpen] = useState(() => holdsCurrent || !readCollapsed().includes(id));
  useEffect(() => {
    if (holdsCurrent) setOpen(true);
  }, [holdsCurrent]);
  const toggle = () => {
    const next = !open;
    setOpen(next);
    try {
      const set = new Set(readCollapsed());
      if (next) set.delete(id);
      else set.add(id);
      localStorage.setItem(NAV_KEY, JSON.stringify([...set]));
    } catch {
      /* storage unavailable */
    }
  };
  return (
    <div className={`nav-section ${open ? 'open' : ''}`}>
      <button type="button" className="nav-group" aria-expanded={open} aria-controls={`nav-${id}`} onClick={toggle}>
        <NavIcon d={icon} />
        <span>{title}</span>
        <svg className="nav-chevron" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M4 6l4 4 4-4" />
        </svg>
      </button>
      <div id={`nav-${id}`} className="nav-items" hidden={!open}>
        {children}
      </div>
    </div>
  );
}
