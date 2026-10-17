import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Badge, Button, Card, Empty, ErrorBox, Field, Loading, Modal, PageHeader, Pager, dateTimeFa } from '../components/ui';
import { api, post, put } from '../lib/api';
import { useAction, useApi } from '../lib/hooks';

export function NotificationsPage() {
  const [page, setPage] = useState(1);
  const r = useApi<{ items: any[]; total: number; page: number; pageSize: number }>(`/notifications?page=${page}`, [page]);
  const nav = useNavigate();
  const open = async (n: any) => {
    if (!n.read_at) await post('/notifications/read', { ids: [n.id] });
    const letterId = n.data?.letterId;
    const resolutionId = n.data?.resolutionId;
    if (letterId) nav(`/letters/${letterId}`);
    else if (resolutionId) nav(`/resolutions/${resolutionId}`);
    else void r.reload();
  };
  return (
    <>
      <PageHeader
        title="اعلان‌ها"
        actions={
          <Button variant="secondary" onClick={async () => (await post('/notifications/read', {}), await r.reload())}>
            همه خوانده شد
          </Button>
        }
      />
      <Card>
        {r.loading && !r.data ? (
          <Loading />
        ) : !r.data?.items.length ? (
          <Empty>اعلانی ندارید.</Empty>
        ) : (
          <>
            <ul className="list">
              {r.data.items.map((n) => (
                <li key={n.id} style={{ cursor: 'pointer', fontWeight: n.read_at ? 400 : 600 }} onClick={() => void open(n)}>
                  <div className="row gap-sm">
                    {!n.read_at && <Badge tone="info">جدید</Badge>}
                    <span>{n.title}</span>
                    <span className="small muted">{dateTimeFa(n.created_at)}</span>
                  </div>
                  {n.body && <div className="small muted">{n.body}</div>}
                </li>
              ))}
            </ul>
            <Pager page={r.data.page} pageSize={r.data.pageSize} total={Number(r.data.total)} onPage={setPage} />
          </>
        )}
      </Card>
    </>
  );
}

const CHANNEL: Record<string, string> = { in_app: 'درون‌برنامه‌ای', email: 'ایمیل', sms: 'پیامک' };

export function TemplatesPage() {
  const r = useApi<any[]>('/notification-templates');
  const [edit, setEdit] = useState<any | null>(null);
  const act = useAction();
  const events = [...new Map((r.data ?? []).map((t) => [t.event, t.label])).entries()];
  return (
    <>
      <PageHeader title="قالب‌های اعلان" subtitle="متن پیام هر رویداد در هر کانال؛ متغیرها با {{نام}} جایگزین می‌شوند" />
      {r.loading && !r.data ? (
        <Loading />
      ) : (
        events.map(([event, label]) => (
          <Card key={event} title={label} className="mb">
            <table className="table">
              <tbody>
                {(r.data ?? [])
                  .filter((t) => t.event === event)
                  .map((t) => (
                    <tr key={t.channel}>
                      <td style={{ width: 140 }}>{CHANNEL[t.channel]}</td>
                      <td>
                        {t.subject && <strong>{t.subject} — </strong>}
                        <span className="small">{t.body || '—'}</span>
                      </td>
                      <td style={{ width: 160 }}>
                        {t.enabled ? <Badge tone="success">فعال</Badge> : <Badge>غیرفعال</Badge>} {t.customized && <Badge tone="info">سفارشی</Badge>}
                      </td>
                      <td style={{ width: 80 }}>
                        <Button variant="ghost" size="sm" onClick={() => setEdit({ ...t })}>
                          ویرایش
                        </Button>
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </Card>
        ))
      )}
      {edit && (
        <Modal
          title={`${edit.label} — ${CHANNEL[edit.channel]}`}
          onClose={() => setEdit(null)}
          footer={
            <>
              <Button busy={act.busy} onClick={() => act.run(async () => (await put(`/notification-templates/${edit.event}/${edit.channel}`, { subject: edit.subject || null, body: edit.body, enabled: edit.enabled }), setEdit(null), await r.reload()))}>
                ذخیره
              </Button>
              {edit.customized && (
                <Button variant="ghost" onClick={() => act.run(async () => (await api(`/notification-templates/${edit.event}/${edit.channel}`, { method: 'DELETE' }), setEdit(null), await r.reload()))}>
                  بازگشت به پیش‌فرض
                </Button>
              )}
            </>
          }
        >
          <ErrorBox error={act.error} />
          {edit.channel !== 'sms' && (
            <Field label="عنوان">
              <input className="input" value={edit.subject ?? ''} onChange={(e) => setEdit({ ...edit, subject: e.target.value })} />
            </Field>
          )}
          <Field label="متن" hint="متغیرها: {{number}} {{subject}} {{actor}} {{action}} {{instruction}} {{step}} {{due}} {{resolution}} {{commission}} …">
            <textarea className="input" rows={5} value={edit.body} onChange={(e) => setEdit({ ...edit, body: e.target.value })} />
          </Field>
          <label className="check">
            <input type="checkbox" checked={edit.enabled} onChange={(e) => setEdit({ ...edit, enabled: e.target.checked })} />
            فعال
          </label>
        </Modal>
      )}
    </>
  );
}
