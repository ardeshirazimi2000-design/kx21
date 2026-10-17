import { Link } from 'react-router-dom';
import { Pill, RESOLUTION_STATUS } from '../components/labels';
import { Card, Empty, Loading, PageHeader, Stat, dateFa, fa } from '../components/ui';
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
      <PageHeader title={`خوش آمدید، ${me!.full_name}`} subtitle="خلاصه کارهای در انتظار شما" />
      <div className="grid grid-4 mb">
        <Stat label="کارهای کارتابل" value={fa(items.length)} tone={items.length ? 'info' : undefined} />
        <Stat label="معوق" value={fa(items.filter((i) => i.overdue).length)} tone={items.some((i) => i.overdue) ? 'danger' : undefined} />
        <Stat label="گام‌های گردش کار" value={fa(items.filter((i) => i.workflow_step_id).length)} />
        <Stat label="مصوبات در دست اجرا" value={fa(resolutions.data?.items.length ?? 0)} tone={resolutions.data?.items.length ? 'warning' : undefined} />
      </div>
      <div className="grid grid-2">
        <Card title="کارتابل" actions={<Link to="/cartable" className="btn btn-ghost btn-sm">همه</Link>}>
          {cartable.loading && !cartable.data ? <Loading /> : <CartableTable items={items.slice(0, 8)} compact />}
        </Card>
        <Card title="مصوبات محول‌شده به من" actions={<Link to="/resolutions" className="btn btn-ghost btn-sm">همه</Link>}>
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
            <Stat label="نامه وارده (۳۰ روز)" value={fa(r.letters.byKind.incoming ?? 0)} />
            <Stat label="نامه صادره (۳۰ روز)" value={fa(r.letters.byKind.outgoing ?? 0)} />
            <Stat label="ارجاعات معوق" value={fa(r.routing.overdue)} tone={Number(r.routing.overdue) ? 'danger' : undefined} />
            <Stat label="میانگین زمان پاسخ" value={r.routing.avg_response_hours === null ? '—' : `${fa(r.routing.avg_response_hours)} ساعت`} />
          </div>
          <Card title="روند ماهانه مکاتبات" className="mt">
            <MonthlyChart data={r.letters.monthly} />
          </Card>
        </>
      )}
    </>
  );
}
