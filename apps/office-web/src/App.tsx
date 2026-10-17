import { useEffect, useState, type ReactNode } from 'react';
import { Link, Navigate, NavLink, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { Loading, fa } from './components/ui';
import { useAuth } from './lib/auth';
import { usePoll } from './lib/hooks';
import { ArchivePage } from './pages/Archive';
import { AuditPage } from './pages/Audit';
import { CartablePage } from './pages/Cartable';
import { DashboardPage } from './pages/Dashboard';
import { IntegrationsPage } from './pages/Integrations';
import { LetterDetailPage } from './pages/LetterDetail';
import { LetterFormPage } from './pages/LetterForm';
import { LettersPage } from './pages/Letters';
import { LoginPage } from './pages/Login';
import { MeetingDetailPage, MeetingsPage } from './pages/Meetings';
import { NotificationsPage, TemplatesPage } from './pages/Notifications';
import { OrgPage } from './pages/Org';
import { ProfilePage } from './pages/Profile';
import { ReportsPage } from './pages/Reports';
import { ResolutionDetailPage, ResolutionsPage } from './pages/Resolutions';
import { RolesPage } from './pages/Roles';
import { UsersPage } from './pages/Users';
import { VerifyPage } from './pages/Verify';
import { WorkflowsPage } from './pages/Workflows';

export function App() {
  const { me, loading } = useAuth();
  const loc = useLocation();
  // Public verification of a printed letter (QR code).
  if (loc.pathname.startsWith('/verify/')) {
    return (
      <Routes>
        <Route path="/verify/:code" element={<VerifyPage />} />
      </Routes>
    );
  }
  if (loading) return <Loading />;
  if (!me) return <LoginPage />;
  if (me.mfaRequired && !me.mfa_enabled) {
    return (
      <Shell>
        <ProfilePage forceMfa />
      </Shell>
    );
  }
  return (
    <Shell>
      <Routes>
        <Route path="/" element={<DashboardPage />} />
        <Route path="/cartable" element={<CartablePage />} />
        <Route path="/letters" element={<LettersPage />} />
        <Route path="/letters/new" element={<LetterFormPage />} />
        <Route path="/letters/:id" element={<LetterDetailPage />} />
        <Route path="/letters/:id/edit" element={<LetterFormPage />} />
        <Route path="/archive" element={<ArchivePage />} />
        <Route path="/workflows" element={<WorkflowsPage />} />
        <Route path="/meetings" element={<MeetingsPage />} />
        <Route path="/meetings/:id" element={<MeetingDetailPage />} />
        <Route path="/resolutions" element={<ResolutionsPage />} />
        <Route path="/resolutions/:id" element={<ResolutionDetailPage />} />
        <Route path="/notifications" element={<NotificationsPage />} />
        <Route path="/notification-templates" element={<TemplatesPage />} />
        <Route path="/reports" element={<ReportsPage />} />
        <Route path="/org" element={<OrgPage />} />
        <Route path="/users" element={<UsersPage />} />
        <Route path="/roles" element={<RolesPage />} />
        <Route path="/integrations" element={<IntegrationsPage />} />
        <Route path="/audit" element={<AuditPage />} />
        <Route path="/profile" element={<ProfilePage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Shell>
  );
}

function Shell({ children }: { children: ReactNode }) {
  const { me, logout, can } = useAuth();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const loc = useLocation();
  const nav = useNavigate();
  const unread = usePoll<{ total: number }>('/notifications?unread=true&pageSize=1', 60_000);
  const cartable = usePoll<unknown[]>('/cartable', 60_000);
  useEffect(() => setOpen(false), [loc.pathname]);
  useEffect(() => {
    void unread.reload();
    void cartable.reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loc.pathname]);

  const item = (to: string, label: string, extra?: ReactNode) => (
    <NavLink to={to} end={to === '/'}>
      <span>{label}</span>
      {extra}
    </NavLink>
  );
  const count = (n?: number) => (n ? <span className="count">{fa(n)}</span> : null);
  const admin = ['org.manage', 'users.manage', 'roles.manage', 'workflow.manage', 'notifications.manage', 'integration.manage', 'audit.view'].some(can);

  return (
    <div className="shell">
      <aside className={`sidebar ${open ? 'open' : ''}`}>
        <Link to="/" className="brand">
          <img src="/iran-chamber-logo.png" width={52} height={52} alt="لوگوی اتاق ایران" />
          <span>
            اتاق بازرگانی، صنایع، معادن و کشاورزی ایران
            <small>اتوماسیون اداری</small>
          </span>
        </Link>
        <nav className="nav">
          {item('/', 'داشبورد')}
          <NavGroup id="letters" title="مکاتبات" paths={['/cartable', '/letters', '/archive']}>
            {item('/cartable', 'کارتابل', count(cartable.data?.length))}
            {item('/letters', 'مکاتبات')}
            {item('/letters/new', 'نامه جدید')}
            {(can('archive.read') || can('archive.manage')) && item('/archive', 'بایگانی')}
          </NavGroup>
          <NavGroup id="commissions" title="کمیسیون‌ها" paths={['/resolutions', '/meetings']}>
            {item('/resolutions', 'مصوبات کمیسیون‌ها')}
            {can('meetings.view') && item('/meetings', 'جلسات کمیسیون‌ها')}
          </NavGroup>
          <NavGroup id="reports" title="اعلان و گزارش" paths={['/notifications', '/reports']}>
            {item('/notifications', 'اعلان‌ها', count(unread.data?.total))}
            {can('reports.view') && item('/reports', 'گزارش‌ها')}
          </NavGroup>
          {admin && (
            <NavGroup
              id="admin"
              title="مدیریت"
              paths={['/workflows', '/org', '/users', '/roles', '/notification-templates', '/integrations', '/audit']}
            >
              {can('workflow.manage') && item('/workflows', 'گردش‌های کار')}
              {can('org.manage') && item('/org', 'ساختار سازمانی')}
              {can('users.manage') && item('/users', 'کاربران')}
              {can('roles.manage') && item('/roles', 'نقش‌ها و مجوزها')}
              {can('notifications.manage') && item('/notification-templates', 'قالب‌های اعلان')}
              {can('integration.manage') && item('/integrations', 'یکپارچه‌سازی')}
              {can('audit.view') && item('/audit', 'رویدادنگاری')}
            </NavGroup>
          )}
        </nav>
      </aside>
      <div className="main">
        <header className="topbar">
          <button className="btn btn-secondary btn-sm menu-btn" onClick={() => setOpen(!open)} aria-label="منو">
            ☰
          </button>
          <form
            className="search"
            onSubmit={(e) => {
              e.preventDefault();
              const v = q.trim();
              if (v.length >= 2) nav(`/letters?q=${encodeURIComponent(v)}`);
            }}
          >
            <input className="input" placeholder="جستجوی نامه: موضوع، متن، شماره یا کد رهگیری…" value={q} onChange={(e) => setQ(e.target.value)} />
          </form>
          <div className="grow" />
          <span className="muted small">{me!.positions[0] ? `${me!.positions[0].title} — ${me!.positions[0].unitName}` : ''}</span>
          <Link to="/profile" className="muted">
            {me!.full_name}
          </Link>
          <button className="btn btn-ghost btn-sm" onClick={() => void logout()}>
            خروج
          </button>
        </header>
        <main className="content">{children}</main>
      </div>
    </div>
  );
}

const NAV_KEY = 'oa.nav.collapsed';
const readCollapsed = (): string[] => {
  try {
    return JSON.parse(localStorage.getItem(NAV_KEY) ?? '[]');
  } catch {
    return [];
  }
};

/** Collapsible sidebar group; the group holding the current page always opens. */
function NavGroup({ id, title, paths, children }: { id: string; title: string; paths: string[]; children: ReactNode }) {
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
