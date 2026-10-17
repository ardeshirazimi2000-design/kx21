import { Fragment, useState } from 'react';
import { Badge, Button, Card, Empty, Loading, PageHeader, Pager, dateTimeFa, fa } from '../components/ui';
import { get } from '../lib/api';
import { useAction, useApi } from '../lib/hooks';

export function AuditPage() {
  const [page, setPage] = useState(1);
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<number | null>(null);
  const qs = `page=${page}&pageSize=50${q ? `&q=${encodeURIComponent(q)}` : ''}`;
  const r = useApi<{ items: any[]; total: number; page: number; pageSize: number }>(`/audit?${qs}`, [qs]);
  const [verify, setVerify] = useState<{ brokenAt: number | null; count: number } | null>(null);
  const act = useAction();
  return (
    <>
      <PageHeader
        title="رویدادنگاری (Audit Log)"
        subtitle="همه تغییرات با زنجیره هش ثبت می‌شوند و قابل ویرایش یا حذف نیستند"
        actions={
          <Button variant="secondary" busy={act.busy} onClick={() => act.run(async () => setVerify(await get('/audit/verify')))}>
            بررسی یکپارچگی زنجیره
          </Button>
        }
      />
      {verify && (
        <div className={`alert ${verify.brokenAt === null ? 'alert-success' : 'alert-danger'}`}>
          {verify.brokenAt === null ? `زنجیره سالم است (${fa(verify.count)} رویداد).` : `زنجیره از رویداد شماره ${fa(verify.brokenAt)} دستکاری شده است!`}
        </div>
      )}
      <Card>
        <input className="input mb" placeholder="جستجوی عملیات یا کاربر…" onKeyDown={(e) => e.key === 'Enter' && (setQ((e.target as HTMLInputElement).value.trim()), setPage(1))} />
        {r.loading && !r.data ? (
          <Loading />
        ) : !r.data?.items.length ? (
          <Empty>رویدادی یافت نشد.</Empty>
        ) : (
          <>
            <table className="table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>زمان</th>
                  <th>کاربر</th>
                  <th>عملیات</th>
                  <th>موجودیت</th>
                  <th>IP</th>
                </tr>
              </thead>
              <tbody>
                {r.data.items.map((a) => (
                  <Fragment key={a.id}>
                    <tr className="clickable" onClick={() => setOpen(open === a.id ? null : a.id)}>
                      <td>{fa(a.id)}</td>
                      <td className="small">{dateTimeFa(a.created_at)}</td>
                      <td>{a.user_name ?? 'سامانه'}</td>
                      <td className="mono">{a.action}</td>
                      <td className="small">
                        <Badge>{a.entity}</Badge> <span className="mono">{a.entity_id?.slice(0, 8)}</span>
                      </td>
                      <td className="mono small">{a.ip ?? '—'}</td>
                    </tr>
                    {open === a.id && (
                      <tr>
                        <td colSpan={6}>
                          {a.reason && <div>علت: {a.reason}</div>}
                          <pre className="pre ltr small" style={{ whiteSpace: 'pre-wrap' }}>
                            {JSON.stringify({ before: a.before, after: a.after }, null, 2)}
                          </pre>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
            <Pager page={r.data.page} pageSize={r.data.pageSize} total={Number(r.data.total)} onPage={setPage} />
          </>
        )}
      </Card>
    </>
  );
}
