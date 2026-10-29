import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { usePoll } from '../lib/hooks';
import { Icon, type IconName } from './icons';
import { fa } from './ui';

type Badge = 'cartable' | 'unread';
type MenuItem = { to: string; label: string; icon: IconName; perm?: string | string[]; badge?: Badge; end?: boolean };
/** flat: the items sit directly under the dashboard, with no group heading (used for the main letters group). */
type MenuGroup = { id: string; title: string; icon: IconName; items: MenuItem[]; flat?: boolean };

/** The whole menu in one place: groups, icons and the permission each page needs. Pages without a perm are open to every user. */
export const MENU: MenuGroup[] = [
  {
    id: 'letters',
    title: 'مکاتبات',
    icon: 'mail',
    flat: true,
    items: [
      { to: '/cartable', label: 'کارتابل', icon: 'inbox', badge: 'cartable' },
      { to: '/letters', label: 'مکاتبات', icon: 'mail', end: true },
      { to: '/letters/new', label: 'نامه جدید', icon: 'pen' },
      { to: '/smart-search', label: 'جستجوی هوشمند', icon: 'sparkle' },
      { to: '/archive', label: 'بایگانی', icon: 'archive', perm: ['archive.read', 'archive.manage'] },
      { to: '/signatures', label: 'نمونه امضاها', icon: 'signature', perm: 'signatures.manage' },
      { to: '/letter-templates', label: 'قالب‌های نامه', icon: 'template', perm: 'templates.manage' },
      { to: '/contacts', label: 'مخاطبین بیرونی', icon: 'contacts', perm: 'contacts.manage' },
    ],
  },
  {
    id: 'commissions',
    title: 'کمیسیون‌ها',
    icon: 'users',
    items: [
      { to: '/resolutions', label: 'مصوبات کمیسیون‌ها', icon: 'resolution' },
      { to: '/meetings', label: 'جلسات کمیسیون‌ها', icon: 'calendar', perm: 'meetings.view' },
    ],
  },
  {
    id: 'reports',
    title: 'اعلان و گزارش',
    icon: 'chart',
    items: [
      { to: '/notifications', label: 'اعلان‌ها', icon: 'bell', badge: 'unread' },
      { to: '/reports', label: 'گزارش‌ها', icon: 'chart', perm: 'reports.view' },
    ],
  },
  {
    id: 'admin',
    title: 'مدیریت سیستم',
    icon: 'shield',
    items: [
      { to: '/workflows', label: 'گردش‌های کار', icon: 'workflow', perm: 'workflow.manage' },
      { to: '/org', label: 'ساختار سازمانی', icon: 'org', perm: 'org.manage' },
      { to: '/users', label: 'کاربران', icon: 'user', perm: 'users.manage' },
      { to: '/roles', label: 'نقش‌ها و مجوزها', icon: 'shield', perm: 'roles.manage' },
      { to: '/notification-templates', label: 'قالب‌های اعلان', icon: 'bellCog', perm: 'notifications.manage' },
      { to: '/integrations', label: 'یکپارچه‌سازی', icon: 'plug', perm: 'integration.manage' },
      { to: '/audit', label: 'رویدادنگاری', icon: 'audit', perm: 'audit.view' },
    ],
  },
];

const EXTRA_TITLES: [RegExp, string, string?][] = [
  [/^\/$/, 'داشبورد'],
  [/^\/letters\/[^/]+\/edit$/, 'ویرایش نامه', 'مکاتبات'],
  [/^\/letters\/(?!new$)[^/]+$/, 'جزئیات نامه', 'مکاتبات'],
  [/^\/meetings\/[^/]+$/, 'جزئیات جلسه', 'کمیسیون‌ها'],
  [/^\/resolutions\/[^/]+$/, 'جزئیات مصوبه', 'کمیسیون‌ها'],
  [/^\/profile$/, 'حساب کاربری'],
];

/** Group and page title of a path, for the breadcrumb and the browser tab. */
function locate(pathname: string): { group?: string; page: string } {
  for (const [re, page, group] of EXTRA_TITLES) if (re.test(pathname)) return { group, page };
  for (const g of MENU) for (const i of g.items) if (pathname === i.to) return { group: g.title, page: i.label };
  return { page: 'اتوماسیون اداری' };
}

const readJson = <T,>(key: string, fallback: T): T => {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : (JSON.parse(v) as T);
  } catch {
    return fallback;
  }
};
const writeJson = (key: string, value: unknown) => {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage unavailable */
  }
};

export type Theme = 'system' | 'light' | 'dark';
const THEME_KEY = 'oa.theme';
export function applyTheme(theme: Theme = readJson<Theme>(THEME_KEY, 'system')) {
  const root = document.documentElement;
  if (theme === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', theme);
}

const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0])
    .join('‌');

export function Shell({ children }: { children: ReactNode }) {
  const { me, logout, can } = useAuth();
  const [open, setOpen] = useState(false);
  const [mini, setMini] = useState(() => readJson('oa.nav.mini', false));
  const [theme, setTheme] = useState<Theme>(() => readJson<Theme>(THEME_KEY, 'system'));
  const loc = useLocation();
  const unread = usePoll<{ total: number }>('/notifications?unread=true&pageSize=1', 60_000);
  const cartable = usePoll<unknown[]>('/cartable', 60_000);
  useEffect(() => setOpen(false), [loc.pathname]);
  useEffect(() => {
    void unread.reload();
    void cartable.reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loc.pathname]);
  const where = locate(loc.pathname);
  useEffect(() => {
    document.title = `${where.page} — رسا`;
  }, [where.page]);

  const counts: Record<Badge, number | undefined> = { cartable: cartable.data?.length, unread: unread.data?.total };
  const allowed = (i: MenuItem) => !i.perm || (Array.isArray(i.perm) ? i.perm.some(can) : can(i.perm));
  const groups = MENU.map((g) => ({ ...g, items: g.items.filter(allowed) })).filter((g) => g.items.length);
  const toggleMini = () => {
    setMini(!mini);
    writeJson('oa.nav.mini', !mini);
  };
  const cycleTheme = () => {
    const next: Theme = theme === 'system' ? 'light' : theme === 'light' ? 'dark' : 'system';
    setTheme(next);
    writeJson(THEME_KEY, next);
    applyTheme(next);
  };
  const position = me!.positions[0];

  return (
    <div className={`shell ${mini ? 'shell-mini' : ''}`}>
      <aside className={`sidebar ${open ? 'open' : ''}`} aria-label="منوی اصلی">
        <Link to="/" className="brand" title="رسا — سامانه هوشمند اتوماسیون و مدیریت سازمانی">
          <span className="brand-tile">
            <img src="/rasa-mark.png" width={38} height={38} alt="لوگوی رسا" />
          </span>
          <span className="brand-text">
            <span className="brand-name">رسا</span>
            <small>سامانه هوشمند اتوماسیون و مدیریت سازمانی</small>
          </span>
        </Link>
        <nav className="nav">
          <NavLink to="/" end className="nav-link" title="داشبورد">
            <Icon name="home" />
            <span className="nav-label">داشبورد</span>
          </NavLink>
          {groups.map((g) => (
            <NavGroup key={g.id} group={g} mini={mini}>
              {g.items.map((i) => {
                const n = i.badge ? counts[i.badge] : undefined;
                return (
                  <NavLink key={i.to} to={i.to} end={i.end ?? true} className="nav-link" title={i.label}>
                    <Icon name={i.icon} />
                    <span className="nav-label">{i.label}</span>
                    {n ? <span className="count">{fa(n > 99 ? '99+' : n)}</span> : null}
                  </NavLink>
                );
              })}
            </NavGroup>
          ))}
        </nav>
        <div className="sidebar-foot">
          <Link to="/profile" className="me-card" title={me!.full_name}>
            <span className="avatar">{initials(me!.full_name)}</span>
            <span className="me-text">
              <strong>{me!.full_name}</strong>
              {position && <small>{position.title}</small>}
            </span>
          </Link>
          <button type="button" className="nav-collapse" onClick={toggleMini} aria-pressed={mini} title={mini ? 'باز کردن منو' : 'جمع کردن منو'}>
            <Icon name="collapse" />
            <span className="nav-label">جمع کردن منو</span>
          </button>
        </div>
      </aside>
      {open && <div className="sidebar-backdrop" onClick={() => setOpen(false)} aria-hidden />}
      <div className="main">
        <header className="topbar">
          <button className="icon-btn menu-btn" onClick={() => setOpen(!open)} aria-label="منو" aria-expanded={open}>
            <Icon name="menu" size={22} />
          </button>
          <div className="crumbs">
            {where.group && where.group !== where.page && <span className="crumb-group">{where.group}</span>}
            <span className="crumb-page">{where.page}</span>
          </div>
          <TopSearch />
          <div className="grow" />
          <Link to="/letters/new" className="btn btn-primary btn-sm top-new">
            <Icon name="plus" size={16} />
            <span>نامه جدید</span>
          </Link>
          <button type="button" className="icon-btn" onClick={cycleTheme} title={THEME_LABEL[theme]} aria-label={THEME_LABEL[theme]}>
            <Icon name={theme === 'dark' ? 'moon' : theme === 'light' ? 'sun' : 'monitor'} size={20} />
          </button>
          <Link to="/notifications" className="icon-btn bell" title="اعلان‌ها" aria-label="اعلان‌ها">
            <Icon name="bell" size={20} />
            {counts.unread ? <span className="dot-count">{fa(counts.unread > 9 ? '9+' : counts.unread)}</span> : null}
          </Link>
          <UserMenu name={me!.full_name} position={position ? `${position.title} — ${position.unitName}` : ''} onLogout={() => void logout()} />
        </header>
        <main className="content">{children}</main>
      </div>
    </div>
  );
}

const THEME_LABEL: Record<Theme, string> = { system: 'پوسته: هماهنگ با سیستم', light: 'پوسته: روشن', dark: 'پوسته: تیره' };

/** Letter search in the top bar; Ctrl+K or "/" focuses it from anywhere. */
function TopSearch() {
  const [q, setQ] = useState('');
  const nav = useNavigate();
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const typing = e.target instanceof HTMLElement && (e.target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName));
      if ((e.key === 'k' && (e.ctrlKey || e.metaKey)) || (e.key === '/' && !typing)) {
        e.preventDefault();
        ref.current?.focus();
      }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, []);
  return (
    <form
      className="search"
      role="search"
      onSubmit={(e) => {
        e.preventDefault();
        const v = q.trim();
        if (v.length >= 2) nav(`/letters?q=${encodeURIComponent(v)}`);
      }}
    >
      <Icon name="search" size={17} className="search-icon" />
      <input ref={ref} className="input" placeholder="جستجوی نامه: موضوع، شماره یا کد رهگیری…" value={q} onChange={(e) => setQ(e.target.value)} />
      <kbd className="search-kbd">Ctrl K</kbd>
    </form>
  );
}

function UserMenu({ name, position, onLogout }: { name: string; position: string; onLogout: () => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const loc = useLocation();
  useEffect(() => setOpen(false), [loc.pathname]);
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
  return (
    <div className="user-menu" ref={ref}>
      <button type="button" className="user-btn" onClick={() => setOpen(!open)} aria-haspopup="menu" aria-expanded={open}>
        <span className="avatar avatar-sm">{initials(name)}</span>
        <span className="user-name">{name}</span>
        <Icon name="chevron" size={14} />
      </button>
      {open && (
        <div className="menu-pop" role="menu">
          <div className="menu-head">
            <strong>{name}</strong>
            {position && <small className="muted">{position}</small>}
          </div>
          <Link to="/profile" role="menuitem">
            <Icon name="user" size={16} /> حساب کاربری و امنیت
          </Link>
          <button type="button" role="menuitem" className="danger" onClick={onLogout}>
            <Icon name="logout" size={16} /> خروج از سامانه
          </button>
        </div>
      )}
    </div>
  );
}

const NAV_KEY = 'oa.nav.collapsed';

/** Collapsible sidebar group; the group holding the current page always opens. In the narrow (icon) menu every group stays open. */
function NavGroup({ group, mini, children }: { group: MenuGroup; mini: boolean; children: ReactNode }) {
  const { id, title, icon } = group;
  const loc = useLocation();
  const holdsCurrent = group.items.some((i) => loc.pathname === i.to || loc.pathname.startsWith(`${i.to}/`));
  const [open, setOpen] = useState(() => holdsCurrent || !readJson<string[]>(NAV_KEY, []).includes(id));
  useEffect(() => {
    if (holdsCurrent) setOpen(true);
  }, [holdsCurrent]);
  const toggle = () => {
    const next = !open;
    setOpen(next);
    const set = new Set(readJson<string[]>(NAV_KEY, []));
    if (next) set.delete(id);
    else set.add(id);
    writeJson(NAV_KEY, [...set]);
  };
  const shown = open || mini;
  if (group.flat) return <div className="nav-items nav-flat">{children}</div>;
  return (
    <div className={`nav-section ${shown ? 'open' : ''} ${holdsCurrent ? 'current' : ''}`}>
      <button type="button" className="nav-group" aria-expanded={shown} aria-controls={`nav-${id}`} onClick={toggle} title={title}>
        <Icon name={icon} size={16} className="nav-group-icon" />
        <span className="nav-label">{title}</span>
        <Icon name="chevron" size={14} className="nav-chevron" />
      </button>
      <div id={`nav-${id}`} className="nav-items" hidden={!shown}>
        {children}
      </div>
    </div>
  );
}
