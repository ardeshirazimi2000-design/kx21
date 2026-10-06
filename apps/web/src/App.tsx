import { useEffect, useState, type ReactNode } from 'react';
import { Link, Navigate, NavLink, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { Loading, fa } from './components/ui';
import { useAuth } from './lib/auth';
import { useApi, useSocket } from './lib/hooks';
import { AuditPage } from './pages/Audit';
import { ChambersPage } from './pages/Chambers';
import { CommissionDetailPage } from './pages/CommissionDetail';
import { CommissionsPage } from './pages/Commissions';
import { HomePage } from './pages/Home';
import { LoginPage } from './pages/Login';
import { MeetingRoomPage } from './pages/MeetingRoom';
import { MeetingsPage } from './pages/Meetings';
import { NotificationsPage } from './pages/Notifications';
import { PeoplePage } from './pages/People';
import { ProfilePage } from './pages/Profile';
import { ReferralsPage } from './pages/Referrals';
import { ReportsPage } from './pages/Reports';
import { ResolutionDetailPage } from './pages/ResolutionDetail';
import { ResolutionsPage } from './pages/Resolutions';
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
        <Route path="/meetings" element={<MeetingsPage />} />
        <Route path="/meetings/:id" element={<MeetingRoomPage />} />
        <Route path="/resolutions" element={<ResolutionsPage />} />
        <Route path="/resolutions/:id" element={<ResolutionDetailPage />} />
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
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const loc = useLocation();
  const nav = useNavigate();
  const unread = useApi<{ total: number }>('/notifications?unread=true&pageSize=1');
  useSocket({ notification: () => void unread.reload() });
  useEffect(() => setOpen(false), [loc.pathname]);
  const isOfficer = me!.memberships.some((m) => ['chair', 'vice_chair', 'secretary'].includes(m.position));
  const isExpert = me!.memberships.some((m) => m.position === 'expert');

  const item = (to: string, label: string, extra?: ReactNode) => (
    <NavLink to={to} end={to === '/'}>
      <span>{label}</span>
      {extra}
    </NavLink>
  );

  return (
    <div className="shell">
      <aside className={`sidebar ${open ? 'open' : ''}`}>
        <Link to="/" className="brand">
          <img src="/favicon.svg" width={34} height={34} alt="" />
          <span>
            سامانه کمیسیون‌ها
            <small>اتاق بازرگانی</small>
          </span>
        </Link>
        <nav className="nav">
          {item('/', 'داشبورد')}
          <div className="nav-group">جلسات</div>
          {item('/meetings', 'تقویم جلسات')}
          {item('/resolutions', 'مصوبات و پیگیری')}
          {(isExpert || isOfficer) && item('/referrals', 'ارجاعات کارشناسی')}
          {item('/notifications', 'اعلان‌ها', unread.data?.total ? <span className="count">{fa(unread.data.total)}</span> : null)}
          <div className="nav-group">ساختار</div>
          {item('/commissions', 'کمیسیون‌ها')}
          {isAdmin && item('/terms', 'دوره‌ها')}
          {(isAdmin || isOfficer) && item('/people', 'اشخاص و کاربران')}
          {me!.is_super_admin && item('/chambers', 'اتاق‌ها')}
          {(isAdmin || isOfficer) && (
            <>
              <div className="nav-group">گزارش و کنترل</div>
              {item('/reports', 'گزارش‌ها')}
              {isAdmin && item('/audit', 'رویدادنگاری (Audit)')}
            </>
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
              if (q.trim().length >= 2) nav(`/search?q=${encodeURIComponent(q.trim())}`);
            }}
          >
            <input className="input" placeholder="جستجو در کمیسیون‌ها، جلسات و مصوبات…" value={q} onChange={(e) => setQ(e.target.value)} />
          </form>
          <div className="grow" />
          {selectable.length > 1 && (
            <select
              className="input"
              style={{ maxWidth: 260 }}
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
          {selectable.length === 1 && <span className="muted small">{selectable[0].name}</span>}
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
