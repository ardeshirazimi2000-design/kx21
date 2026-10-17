import { JALALI_MONTHS } from '@kx/shared';
import { useState } from 'react';
import { KIND, SOURCE, STATUS } from '../components/labels';
import { Button, Card, ErrorBox, Field, JalaliDateInput, Loading, PageHeader, Stat, fa } from '../components/ui';
import { download } from '../lib/api';
import { useApi } from '../lib/hooks';

export function MonthlyChart({ data }: { data: { label: string; incoming: number; outgoing: number; internal: number }[] }) {
  const max = Math.max(1, ...data.map((d) => d.incoming + d.outgoing + d.internal));
  return (
    <>
      <div className="legend mb">
        <span><i className="seg-incoming" />وارده</span>
        <span><i className="seg-outgoing" />صادره</span>
        <span><i className="seg-internal" />داخلی</span>
      </div>
      <div className="bar-chart">
        {data.map((d) => {
          const total = d.incoming + d.outgoing + d.internal;
          const [, m] = d.label.split('-');
          return (
            <div key={d.label} className="bar" title={`${fa(total)} نامه`}>
              <span>{fa(total)}</span>
              <div style={{ height: `${(total / max) * 120}px` }}>
                <div className="seg-incoming" style={{ flex: d.incoming }} />
                <div className="seg-outgoing" style={{ flex: d.outgoing }} />
                <div className="seg-internal" style={{ flex: d.internal }} />
              </div>
              <span>{JALALI_MONTHS[Number(m) - 1]}</span>
            </div>
          );
        })}
      </div>
    </>
  );
}

const iso = (d: Date) => d.toISOString().slice(0, 10);

export function ReportsPage() {
  const [from, setFrom] = useState(iso(new Date(Date.now() - 30 * 86400_000)));
  const [to, setTo] = useState(iso(new Date()));
  const qs = `from=${from}&to=${to}`;
  const r = useApi<any>(`/reports/dashboard?${qs}`, [qs]);
  const [err, setErr] = useState<Error | null>(null);
  const exp = (report: string, format: string) => download(`/reports/export?report=${report}&format=${format}&${qs}`, `${report}.${format}`).catch(setErr);
  const d = r.data;
  return (
    <>
      <PageHeader
        title="گزارش‌ها و شاخص‌های عملکرد"
        actions={
          <div className="row gap-sm wrap" style={{ alignItems: 'flex-end' }}>
            <Field label="از">
              <JalaliDateInput value={from} onChange={setFrom} />
            </Field>
            <Field label="تا">
              <JalaliDateInput value={to} onChange={setTo} />
            </Field>
          </div>
        }
      />
      <ErrorBox error={err ?? r.error} />
      {!d ? (
        <Loading />
      ) : (
        <>
          <div className="grid grid-4 mb">
            {Object.entries(KIND).map(([k, v]) => (
              <Stat key={k} label={`نامه ${v}`} value={fa(d.letters.byKind[k] ?? 0)} />
            ))}
            <Stat label="ارجاعات انجام‌شده" value={fa(d.routing.done)} tone="success" />
            <Stat label="ارجاعات در انتظار" value={fa(d.routing.pending)} />
            <Stat label="ارجاعات معوق" value={fa(d.routing.overdue)} tone={Number(d.routing.overdue) ? 'danger' : undefined} />
            <Stat label="زمان پاسخ (میانگین / صدک ۹۰)" value={d.routing.avg_response_hours === null ? '—' : `${fa(d.routing.avg_response_hours)} / ${fa(d.routing.p90_response_hours)} ساعت`} />
            <Stat label="گردش‌های در جریان" value={fa(d.workflows.running)} />
            <Stat label="گردش‌های پایان‌یافته" value={fa(d.workflows.completed)} tone="success" />
            <Stat label="گام‌های معوق / ارتقا یافته" value={`${fa(d.workflows.overdue_steps)} / ${fa(d.workflows.escalations)}`} tone={Number(d.workflows.overdue_steps) ? 'warning' : undefined} />
            <Stat label="مصوبات معوق" value={`${fa(d.resolutions.overdue)} از ${fa(d.resolutions.total)}`} tone={Number(d.resolutions.overdue) ? 'danger' : undefined} hint={`میانگین پیشرفت ${fa(d.resolutions.avg_progress ?? 0)}٪`} />
          </div>
          <div className="grid grid-2">
            <Card title="روند ماهانه (۱۲ ماه)">
              <MonthlyChart data={d.letters.monthly} />
            </Card>
            <Card title="وضعیت و منبع نامه‌ها">
              <div className="grid grid-2">
                <ul className="list">
                  {Object.entries(d.letters.byStatus).map(([k, n]) => (
                    <li key={k} className="row between">
                      <span>{STATUS[k]?.[0] ?? k}</span>
                      <strong>{fa(n as string)}</strong>
                    </li>
                  ))}
                </ul>
                <ul className="list">
                  {Object.entries(d.letters.bySource).map(([k, n]) => (
                    <li key={k} className="row between">
                      <span>{SOURCE[k] ?? k}</span>
                      <strong>{fa(n as string)}</strong>
                    </li>
                  ))}
                </ul>
              </div>
            </Card>
          </div>
          <Card
            title="عملکرد واحدها"
            className="mt"
            actions={
              <>
                <Button variant="secondary" size="sm" onClick={() => void exp('units', 'xlsx')}>Excel</Button>
                <Button variant="ghost" size="sm" onClick={() => void exp('units', 'csv')}>CSV</Button>
                <Button variant="ghost" size="sm" onClick={() => window.print()}>PDF / چاپ</Button>
              </>
            }
          >
            <table className="table">
              <thead>
                <tr>
                  <th>واحد</th>
                  <th>نامه ثبت‌شده</th>
                  <th>ارجاع دریافتی</th>
                  <th>انجام‌شده</th>
                  <th>در انتظار</th>
                  <th>معوق</th>
                  <th>میانگین پاسخ (ساعت)</th>
                </tr>
              </thead>
              <tbody>
                {d.units.map((u: any) => (
                  <tr key={u.id}>
                    <td>{u.name}</td>
                    <td>{fa(u.letters)}</td>
                    <td>{fa(u.referrals)}</td>
                    <td>{fa(u.done)}</td>
                    <td>{fa(u.pending)}</td>
                    <td className={Number(u.overdue) ? 'field-error' : ''}>{fa(u.overdue)}</td>
                    <td>{u.avg_response_hours === null ? '—' : fa(u.avg_response_hours)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
          <Card title="خروجی‌ها" className="mt no-print">
            <div className="row gap wrap">
              <Button variant="secondary" onClick={() => void exp('letters', 'xlsx')}>فهرست مکاتبات (Excel)</Button>
              <Button variant="secondary" onClick={() => void exp('routing', 'xlsx')}>ارجاعات و زمان پاسخ (Excel)</Button>
              <Button variant="ghost" onClick={() => void exp('letters', 'csv')}>مکاتبات (CSV)</Button>
              <Button variant="ghost" onClick={() => void exp('routing', 'csv')}>ارجاعات (CSV)</Button>
            </div>
            <p className="small muted">نامه‌های محرمانه در خروجی‌ها درج نمی‌شوند.</p>
          </Card>
        </>
      )}
    </>
  );
}
