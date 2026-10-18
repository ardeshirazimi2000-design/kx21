import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ACTION, ConfBadge, KindBadge, PRIORITY, Pill, STEP_TYPE } from '../components/labels';
import { Badge, Card, Empty, Loading, PageHeader, Tabs, dateTimeFa, fa } from '../components/ui';
import { useApi } from '../lib/hooks';

export function CartableTable({ items, compact }: { items: any[]; compact?: boolean }) {
  if (!items.length) return <Empty>کارتابل شما خالی است.</Empty>;
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th>نامه</th>
            <th>موضوع</th>
            <th>اقدام</th>
            {!compact && <th>از</th>}
            <th>تاریخ</th>
            {!compact && <th>مهلت</th>}
          </tr>
        </thead>
        <tbody>
          {items.map((i) => (
            <tr key={i.routing_id} className={i.overdue ? 'highlight' : ''}>
              <td>
                <div className="row gap-sm">
                  <KindBadge kind={i.kind} />
                  <span className="letter-number">{i.number ? fa(i.number) : 'پیش‌نویس'}</span>
                </div>
              </td>
              <td>
                <Link to={`/letters/${i.letter_id}`}>{i.subject}</Link>
                <div className="row gap-sm">
                  {i.priority !== 'normal' && <Pill map={PRIORITY} value={i.priority} />}
                  <ConfBadge level={i.confidentiality} />
                  {i.status === 'pending' && <Badge tone="info">جدید</Badge>}
                </div>
              </td>
              <td>
                {i.workflow_step_id ? (
                  <Badge tone="accent">
                    {STEP_TYPE[i.step_type] ?? ''}: {i.step_name}
                  </Badge>
                ) : (
                  ACTION[i.action] ?? i.action
                )}
                {i.instruction && !compact && <div className="small muted">{i.instruction}</div>}
              </td>
              {!compact && <td>{i.from_name ?? 'سامانه'}</td>}
              <td className="small">{dateTimeFa(i.created_at)}</td>
              {!compact && <td className="small">{i.due_at ? <span className={i.overdue ? 'field-error' : ''}>{dateTimeFa(i.due_at)}</span> : '—'}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function CartablePage() {
  const r = useApi<any[]>('/cartable');
  const [tab, setTab] = useState<'all' | 'workflow' | 'refer' | 'info' | 'overdue'>('all');
  const all = r.data ?? [];
  const items = all.filter((i) =>
    tab === 'all' ? true : tab === 'workflow' ? !!i.workflow_step_id : tab === 'info' ? i.action === 'info' : tab === 'overdue' ? i.overdue : !i.workflow_step_id && i.action !== 'info',
  );
  return (
    <>
      <PageHeader title="کارتابل" subtitle="ارجاعات و گام‌های گردش کار که منتظر اقدام شما یا سمت شماست" />
      <Card>
        <Tabs
          value={tab}
          onChange={setTab}
          tabs={[
            { id: 'all', label: `همه (${all.length.toLocaleString('fa')})` },
            { id: 'workflow', label: 'گردش کار' },
            { id: 'refer', label: 'ارجاعات' },
            { id: 'info', label: 'جهت اطلاع' },
            { id: 'overdue', label: 'معوق' },
          ]}
        />
        {r.loading && !r.data ? <Loading /> : <CartableTable items={items} />}
      </Card>
    </>
  );
}
