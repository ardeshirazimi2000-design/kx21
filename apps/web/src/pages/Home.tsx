import { ROLE_LABELS, type InviteeRole } from '@kx/shared';
import { Link, useNavigate } from 'react-router-dom';
import { MeetingStatusBadge, ResolutionBadge } from '../components/status';
import { Badge, Card, dateFa, dateTimeFa, Empty, fa, Loading, PageHeader, Progress, Stat } from '../components/ui';
import { useAuth } from '../lib/auth';
import { useApi } from '../lib/hooks';

export function HomePage() {
  const { me, isAdmin, chamberId } = useAuth();
  const home = useApi('/me/home');
  // A secretary/chair may serve several commissions: show the follow-up dashboard of each.
  const officerOf = me!.memberships.filter((m) => ['chair', 'vice_chair', 'secretary'].includes(m.position));
  return (
    <>
      <PageHeader title={`سلام، ${me!.full_name}`} subtitle="خلاصه وضعیت جلسات، مصوبات و کارهای شما" />
      {isAdmin && chamberId && <ChamberDashboard chamberId={chamberId} />}
      {officerOf.map((m) => (
        <CommissionDashboard key={m.commission_id} commissionId={m.commission_id} name={m.commission_name} />
      ))}
      {home.loading && !home.data ? <Loading /> : home.data && <MyHome data={home.data} />}
    </>
  );
}

function MyHome({ data }: { data: any }) {
  const nav = useNavigate();
  return (
    <div className="grid grid-2 mt">
      <Card title="جلسات در جریان و پیش رو">
        {data.live.length === 0 && data.upcoming.length === 0 && <Empty>جلسه‌ای برای شما برنامه‌ریزی نشده است.</Empty>}
        <ul className="list">
          {data.live.map((m: any) => (
            <li key={m.id} className="row between gap">
              <div>
                <span className="dot dot-live" /> <Link to={`/meetings/${m.id}`}>{m.title}</Link>
                <div className="muted small">{m.commission_name}</div>
              </div>
              <MeetingStatusBadge status={m.status} />
            </li>
          ))}
          {data.upcoming
            .filter((m: any) => !data.live.some((l: any) => l.id === m.id))
            .map((m: any) => (
              <li key={m.id} className="row between gap clickable" onClick={() => nav(`/meetings/${m.id}`)} style={{ cursor: 'pointer' }}>
                <div>
                  <strong>{m.title}</strong>
                  <div className="muted small">
                    {m.commission_name} — {dateTimeFa(m.scheduled_at)}
                  </div>
                </div>
                <Badge tone="info">{ROLE_LABELS[m.my_role as InviteeRole]}</Badge>
              </li>
            ))}
        </ul>
      </Card>
      <Card title="مصوبات من (مسئول اجرا)" actions={<Link to="/resolutions?mine=true">همه</Link>}>
        {data.resolutions.length === 0 ? (
          <Empty>مصوبه بازی به شما سپرده نشده است.</Empty>
        ) : (
          <ul className="list">
            {data.resolutions.map((r: any) => (
              <li key={r.id}>
                <div className="row between gap">
                  <Link to={`/resolutions/${r.id}`}>{fa(r.number)}</Link>
                  <ResolutionBadge status={r.status} overdue={r.is_overdue} />
                </div>
                <div className="small">{r.text}</div>
                <div className="row gap between small muted">
                  <span>مهلت: {dateFa(r.due_date)}</span>
                  <div style={{ width: 140 }}>
                    <Progress value={r.progress} />
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
      {data.referrals.length > 0 && (
        <Card title="ارجاعات کارشناسی در انتظار پاسخ" actions={<Link to="/referrals">مشاهده</Link>}>
          <ul className="list">
            {data.referrals.map((r: any) => (
              <li key={r.id}>
                {r.request} <span className="muted small">— مهلت: {dateFa(r.due_date)}</span>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}

function ChamberDashboard({ chamberId }: { chamberId: string }) {
  const { data } = useApi(`/dashboard/chamber?chamberId=${chamberId}`);
  if (!data) return null;
  return (
    <>
      <div className="grid grid-4">
        <Stat label="کمیسیون‌های فعال" value={fa(data.totals.commissions)} />
        <Stat label="جلسات ۳۰ روز اخیر" value={fa(data.totals.meetings_30d)} tone="info" />
        <Stat label="مصوبات باز" value={fa(data.totals.open_resolutions)} tone="warning" />
        <Stat label="مصوبات معوق" value={fa(data.overdueResolutions.length)} tone="danger" hint={`${fa(data.totals.live_meetings)} جلسه در حال برگزاری`} />
      </div>
      <div className="grid grid-2 mt">
        <Card title="عملکرد کمیسیون‌ها (دوره جاری)">
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>کمیسیون</th>
                  <th>جلسات</th>
                  <th>مصوبات</th>
                  <th>انجام‌شده</th>
                  <th>معوق</th>
                </tr>
              </thead>
              <tbody>
                {data.commissions.map((c: any) => (
                  <tr key={c.id}>
                    <td>
                      <Link to={`/commissions/${c.id}`}>{c.name}</Link>
                    </td>
                    <td>{fa(c.meetings_held)}</td>
                    <td>{fa(c.resolutions_total)}</td>
                    <td>{fa(c.resolutions_done)}</td>
                    <td>{c.resolutions_overdue > 0 ? <Badge tone="danger">{fa(c.resolutions_overdue)}</Badge> : fa(0)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
        <OverdueCard rows={data.overdueResolutions} showCommission />
      </div>
    </>
  );
}

export function OverdueCard({ rows, showCommission }: { rows: any[]; showCommission?: boolean }) {
  return (
    <Card title="مصوبات معوق" className="overdue">
      {rows.length === 0 ? (
        <Empty>مصوبه معوقی وجود ندارد.</Empty>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>شماره</th>
                {showCommission && <th>کمیسیون</th>}
                <th>مسئول</th>
                <th>تأخیر</th>
                <th>پیشرفت</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="highlight">
                  <td>
                    <Link to={`/resolutions/${r.id}`} title={r.text}>
                      {fa(r.number)}
                    </Link>
                  </td>
                  {showCommission && <td>{r.commission_name}</td>}
                  <td>{r.owner_name ?? '—'}</td>
                  <td>{fa(r.days_late)} روز</td>
                  <td style={{ minWidth: 110 }}>
                    <Progress value={r.progress} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

export function CommissionDashboard({ commissionId, name }: { commissionId: string; name?: string }) {
  const { data } = useApi(`/dashboard/commission?commissionId=${commissionId}`);
  if (!data) return null;
  const rs = data.resolutionsByStatus;
  return (
    <div className="mt">
      {name && <h2 className="mb">{name}</h2>}
      <div className="grid grid-4">
        <Stat label="جلسات برگزارشده" value={fa(data.meetings.held)} />
        <Stat label="میانگین حضور اعضا" value={data.attendanceRate === null ? '—' : `${fa(data.attendanceRate)}٪`} tone="info" />
        <Stat label="مصوبات انجام‌شده" value={fa(rs.done ?? 0)} tone="success" hint={`${fa((rs.open ?? 0) + (rs.in_progress ?? 0) + (rs.returned ?? 0))} در جریان، ${fa(rs.submitted ?? 0)} منتظر بررسی`} />
        <Stat label="مصوبات معوق" value={fa(data.overdueResolutions.length)} tone="danger" hint={`${fa(data.meetings.minutes_pending)} صورتجلسه در انتظار`} />
      </div>
      <div className="grid grid-2 mt">
        <Card title="جلسات پیش رو">
          {data.upcomingMeetings.length === 0 ? (
            <Empty>جلسه‌ای برنامه‌ریزی نشده است.</Empty>
          ) : (
            <ul className="list">
              {data.upcomingMeetings.map((m: any) => (
                <li key={m.id} className="row between">
                  <Link to={`/meetings/${m.id}`}>
                    جلسه {fa(m.number)}: {m.title}
                  </Link>
                  <span className="row gap-sm">
                    <span className="muted small">{dateTimeFa(m.scheduled_at)}</span>
                    <MeetingStatusBadge status={m.status} />
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <OverdueCard rows={data.overdueResolutions} />
      </div>
    </div>
  );
}
