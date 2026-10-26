import { Link } from 'react-router-dom';
import { Pill, RESOLUTION_STATUS } from '../components/labels';
import { Icon, type IconName } from '../components/icons';
import { Card, Empty, Loading, Stat, dateFa, fa } from '../components/ui';
import { useAuth } from '../lib/auth';
import { useApi } from '../lib/hooks';
import { CartableTable } from './Cartable';
import { MonthlyChart } from './Reports';

export function DashboardPage() {
  const { me, can } = useAuth();
  const cartable = useApi<any[]>('/cartable');
  const report = useApi<any>(can('reports.view') ? '/reports/dashboard' : null);
  const resolutions = useApi<{ items: any[] }>('/resolutions?mine=true&status=open,in_progress,returned&pageSize=5');
  const items = cartable.data ?? [];
  const r = report.data;
  return (
    <>
      <section className="hero">
        <div>
          <span className="hero-date">{today()}</span>
          <h1>
            {greeting()}، {me!.full_name}
          </h1>
          <p>{items.length ? `${fa(items.length)} کار در کارتابل شما منتظر اقدام است.` : 'کارتابل شما خالی است.'}</p>
        </div>
        <Link to="/cartable" className="btn btn-lg" style={{ background: 'var(--gold)', color: '#1d1606' }}>
          <Icon name="inbox" /> رفتن به کارتابل
        </Link>
      </section>
      <nav className="quick" aria-label="دسترسی سریع">
        {QUICK.filter((q) => !q.perm || can(q.perm)).map((q) => (
          <Link key={q.to} to={q.to}>
            <span className="qi">
              <Icon name={q.icon} size={20} />
            </span>
            {q.label}
          </Link>
        ))}
      </nav>
      <div className="grid grid-4 mb">
        <Stat icon={<Icon name="inbox" size={22} />} label="کارهای کارتابل" value={fa(items.length)} tone={items.length ? 'info' : undefined} />
        <Stat
          icon={<Icon name="alert" size={22} />}
          label="معوق"
          value={fa(items.filter((i) => i.overdue).length)}
          tone={items.some((i) => i.overdue) ? 'danger' : undefined}
        />
        <Stat icon={<Icon name="workflow" size={22} />} label="گام‌های گردش کار" value={fa(items.filter((i) => i.workflow_step_id).length)} />
        <Stat
          icon={<Icon name="resolution" size={22} />}
          label="مصوبات در دست اجرا"
          value={fa(resolutions.data?.items.length ?? 0)}
          tone={resolutions.data?.items.length ? 'warning' : undefined}
        />
      </div>
      <div className="grid grid-2">
        <Card
          title="کارتابل"
          actions={
            <Link to="/cartable" className="btn btn-ghost btn-sm">
              همه
            </Link>
          }
        >
          {cartable.loading && !cartable.data ? <Loading /> : <CartableTable items={items.slice(0, 8)} compact />}
        </Card>
        <Card
          title="مصوبات محول‌شده به من"
          actions={
            <Link to="/resolutions" className="btn btn-ghost btn-sm">
              همه
            </Link>
          }
        >
          {!resolutions.data?.items.length ? (
            <Empty>مصوبه بازی به شما محول نشده است.</Empty>
          ) : (
            <ul className="list">
              {resolutions.data.items.map((x) => (
                <li key={x.id}>
                  <Link to={`/resolutions/${x.id}`}>
                    <strong>{x.number}</strong> — {x.text.slice(0, 90)}
                  </Link>
                  <div className="row gap-sm small muted">
                    <Pill map={RESOLUTION_STATUS} value={x.status} /> مهلت: {dateFa(x.due_date)} · پیشرفت {fa(x.progress)}٪
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
      {r && (
        <>
          <div className="grid grid-4 mt">
            <Stat icon={<Icon name="download" size={22} />} label="نامه وارده (۳۰ روز)" value={fa(r.letters.byKind.incoming ?? 0)} />
            <Stat icon={<Icon name="send" size={22} />} label="نامه صادره (۳۰ روز)" value={fa(r.letters.byKind.outgoing ?? 0)} />
            <Stat
              icon={<Icon name="alert" size={22} />}
              label="ارجاعات معوق"
              value={fa(r.routing.overdue)}
              tone={Number(r.routing.overdue) ? 'danger' : undefined}
            />
            <Stat
              icon={<Icon name="clock" size={22} />}
              label="میانگین زمان پاسخ"
              value={r.routing.avg_response_hours === null ? '—' : `${fa(r.routing.avg_response_hours)} ساعت`}
            />
          </div>
          <Card title="روند ماهانه مکاتبات" className="mt">
            <MonthlyChart data={r.letters.monthly} />
          </Card>
        </>
      )}
    </>
  );
}

const QUICK: { to: string; label: string; icon: IconName; perm?: string }[] = [
  { to: '/letters/new', label: 'نامه جدید', icon: 'pen' },
  { to: '/cartable', label: 'کارتابل', icon: 'inbox' },
  { to: '/letters', label: 'مکاتبات', icon: 'mail' },
  { to: '/smart-search', label: 'جستجوی هوشمند', icon: 'sparkle' },
  { to: '/meetings', label: 'جلسات کمیسیون‌ها', icon: 'calendar', perm: 'meetings.view' },
  { to: '/reports', label: 'گزارش‌ها', icon: 'chart', perm: 'reports.view' },
];

function greeting() {
  const h = new Date().getHours();
  return h < 12 ? 'صبح بخیر' : h < 17 ? 'روز بخیر' : 'عصر بخیر';
}

function today() {
  try {
    const d = new Date();
    const part = (o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('fa-IR-u-ca-persian', o).format(d);
    return `${part({ weekday: 'long' })} ${part({ day: 'numeric' })} ${part({ month: 'long' })} ${part({ year: 'numeric' })}`;
  } catch {
    return dateFa(new Date());
  }
}
