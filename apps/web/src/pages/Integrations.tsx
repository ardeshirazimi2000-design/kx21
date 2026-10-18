import { useState } from 'react';
import { Badge, Button, Card, Empty, ErrorBox, Field, Loading, Modal, PageHeader, Pager, dateTimeFa, fa } from '../components/ui';
import { patch, post } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useApi } from '../lib/hooks';

const SCOPE_LABEL: Record<string, string> = {
  'meetings:read': 'خواندن جلسات و کمیسیون‌ها',
  'resolutions:read': 'خواندن مصوبات',
  'resolutions:feedback': 'ثبت گزارش اجرای مصوبات',
  'referrals:write': 'ارجاع موضوع به کمیسیون',
  'documents:read': 'دریافت مستندات',
  'documents:write': 'ارسال پیوست',
  'events:read': 'دریافت رویدادها (Webhook)',
};
const EVENT_LABEL: Record<string, string> = {
  '*': 'همه رویدادها',
  'resolution.created': 'ثبت مصوبه',
  'resolution.updated': 'تغییر مصوبه',
  'meeting.updated': 'تغییر جلسه',
  'meeting.invitation_letters_requested': 'درخواست نامه دعوت',
  'referral.updated': 'تغییر وضعیت ارجاع',
};
const EVENT_STATUS: Record<string, [string, 'warning' | 'success' | 'danger' | 'neutral']> = {
  pending: ['در صف', 'warning'],
  delivered: ['تحویل‌شده', 'success'],
  failed: ['ناموفق', 'danger'],
  skipped: ['رد شد', 'neutral'],
};

interface Secrets {
  apiKey: string;
  clientId: string;
  webhookSecret: string;
}

/** External systems (e.g. office automation) connected through the integration API. */
export function IntegrationsPage() {
  const { chamberId } = useAuth();
  const r = useApi<{ items: any[]; scopes: string[]; events: string[] }>(chamberId ? `/integrations?chamberId=${chamberId}` : null, [chamberId]);
  const [edit, setEdit] = useState<any | null>(null);
  const [secrets, setSecrets] = useState<Secrets | null>(null);
  const [log, setLog] = useState<any | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const run = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      await r.reload();
    } catch (e) {
      setError(e as Error);
    }
  };
  return (
    <>
      <PageHeader
        title="یکپارچه‌سازی با سامانه‌های دیگر"
        subtitle="سامانه‌هایی مانند اتوماسیون اداری با کلید API یا OAuth2 به جلسات و مصوبات دسترسی دارند و رویدادها را از طریق Webhook امضاشده دریافت می‌کنند"
        actions={<Button onClick={() => setEdit({})}>تعریف سامانه</Button>}
      />
      <ErrorBox error={error ?? r.error} />
      {secrets && (
        <div className="alert alert-warning">
          <strong>این مقادیر فقط یک بار نمایش داده می‌شوند؛ در سامانه مقصد ذخیره کنید.</strong>
          <dl className="mt">
            <dt>کلید API</dt>
            <dd className="ltr">{secrets.apiKey}</dd>
            <dt>شناسه کلاینت (OAuth2)</dt>
            <dd className="ltr">{secrets.clientId}</dd>
            <dt>رمز امضای Webhook</dt>
            <dd className="ltr">{secrets.webhookSecret}</dd>
          </dl>
          <Button variant="ghost" size="sm" onClick={() => setSecrets(null)}>
            ذخیره کردم
          </Button>
        </div>
      )}
      <Card>
        {r.loading && !r.data ? (
          <Loading />
        ) : !r.data?.items.length ? (
          <Empty>هنوز سامانه‌ای تعریف نشده است.</Empty>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>سامانه</th>
                <th>کلید</th>
                <th>Webhook</th>
                <th>رویدادها</th>
                <th>آخرین استفاده</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {r.data.items.map((c) => (
                <tr key={c.id}>
                  <td>
                    {c.name} {c.is_active ? <Badge tone="success">فعال</Badge> : <Badge>غیرفعال</Badge>}
                    {c.description && <div className="small muted">{c.description}</div>}
                  </td>
                  <td className="ltr small">{c.key_prefix}…</td>
                  <td className="ltr small">{c.webhook_url ?? '—'}</td>
                  <td className="small">
                    {Number(c.pending_events) > 0 && <Badge tone="warning">{fa(c.pending_events)} در صف</Badge>} {Number(c.failed_events) > 0 && <Badge tone="danger">{fa(c.failed_events)} ناموفق</Badge>}
                  </td>
                  <td className="small">{c.last_used_at ? dateTimeFa(c.last_used_at) : '—'}</td>
                  <td>
                    <div className="row gap-sm wrap">
                      <Button variant="ghost" size="sm" onClick={() => setEdit(c)}>
                        ویرایش
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => setLog(c)}>
                        رویدادها
                      </Button>
                      {c.webhook_url && c.is_active && (
                        <Button variant="ghost" size="sm" onClick={() => void run(() => post(`/integrations/${c.id}/ping`))}>
                          ارسال آزمایشی
                        </Button>
                      )}
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => confirm('کلید و رمز فعلی بلافاصله باطل می‌شوند. ادامه می‌دهید؟') && void run(async () => setSecrets(await post(`/integrations/${c.id}/rotate`)))}
                      >
                        صدور کلید جدید
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
      {edit && r.data && (
        <ClientModal
          client={edit}
          scopes={r.data.scopes}
          events={r.data.events}
          onClose={() => setEdit(null)}
          onSave={async (body) => {
            if (edit.id) await patch(`/integrations/${edit.id}`, body);
            else setSecrets(await post('/integrations', { ...body, chamberId }));
            setEdit(null);
            await r.reload();
          }}
        />
      )}
      {log && <EventsModal client={log} onClose={() => (setLog(null), void r.reload())} />}
    </>
  );
}

function ClientModal({ client, scopes, events, onClose, onSave }: { client: any; scopes: string[]; events: string[]; onClose: () => void; onSave: (b: any) => Promise<void> }) {
  const [f, setF] = useState({
    name: client.name ?? 'اتوماسیون اداری',
    description: client.description ?? '',
    webhookUrl: client.webhook_url ?? '',
    scopes: (client.scopes as string[]) ?? [...scopes],
    events: (client.events as string[]) ?? ['*'],
    isActive: client.is_active ?? true,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const toggle = (list: string[], v: string) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  return (
    <Modal
      title={client.id ? `ویرایش ${client.name}` : 'تعریف سامانه خارجی'}
      onClose={onClose}
      footer={
        <Button
          busy={busy}
          onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              await onSave({ ...f, description: f.description || null, webhookUrl: f.webhookUrl || null, ...(client.id ? {} : { isActive: undefined }) });
            } catch (e) {
              setError(e as Error);
            } finally {
              setBusy(false);
            }
          }}
        >
          ذخیره
        </Button>
      }
    >
      <ErrorBox error={error} />
      <Field label="نام سامانه">
        <input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
      </Field>
      <Field label="توضیح">
        <input className="input" value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} />
      </Field>
      <Field label="آدرس Webhook" hint="رویدادها با سرآیند x-kx-signature (HMAC-SHA256) به این آدرس ارسال می‌شوند">
        <input className="input ltr" value={f.webhookUrl} onChange={(e) => setF({ ...f, webhookUrl: e.target.value })} placeholder="https://office.example.ir/api/integrations/meetings/webhook" />
      </Field>
      <Field label="دسترسی‌ها">
        <div className="col gap-sm">
          {scopes.map((s) => (
            <label key={s} className="check">
              <input type="checkbox" checked={f.scopes.includes(s)} onChange={() => setF({ ...f, scopes: toggle(f.scopes, s) })} />
              {SCOPE_LABEL[s] ?? s}
            </label>
          ))}
        </div>
      </Field>
      <Field label="رویدادهای ارسالی">
        <div className="col gap-sm">
          {['*', ...events].map((e) => (
            <label key={e} className="check">
              <input type="checkbox" checked={f.events.includes(e)} onChange={() => setF({ ...f, events: toggle(f.events, e) })} />
              {EVENT_LABEL[e] ?? e}
            </label>
          ))}
        </div>
      </Field>
      {client.id && (
        <label className="check">
          <input type="checkbox" checked={f.isActive} onChange={(e) => setF({ ...f, isActive: e.target.checked })} />
          فعال
        </label>
      )}
    </Modal>
  );
}

function EventsModal({ client, onClose }: { client: any; onClose: () => void }) {
  const [page, setPage] = useState(1);
  const r = useApi<{ items: any[]; total: number; page: number; pageSize: number }>(`/integrations/${client.id}/events?page=${page}`, [page]);
  return (
    <Modal title={`رویدادهای ${client.name}`} onClose={onClose} wide>
      {!r.data ? (
        <Loading />
      ) : !r.data.items.length ? (
        <Empty>رویدادی ثبت نشده است.</Empty>
      ) : (
        <>
          <table className="table">
            <thead>
              <tr>
                <th>رویداد</th>
                <th>زمان</th>
                <th>وضعیت</th>
                <th>تلاش</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {r.data.items.map((e) => (
                <tr key={e.id}>
                  <td>{EVENT_LABEL[e.event] ?? e.event}</td>
                  <td className="small">{dateTimeFa(e.created_at)}</td>
                  <td>
                    <Badge tone={EVENT_STATUS[e.status]?.[1] ?? 'neutral'}>{EVENT_STATUS[e.status]?.[0] ?? e.status}</Badge>
                    {e.last_error && <div className="small field-error ltr">{e.last_error}</div>}
                  </td>
                  <td>{fa(e.attempts)}</td>
                  <td>
                    {['failed', 'skipped'].includes(e.status) && (
                      <Button variant="ghost" size="sm" onClick={async () => (await post(`/integrations/${client.id}/events/${e.id}/retry`), await r.reload())}>
                        ارسال دوباره
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <Pager page={r.data.page} pageSize={r.data.pageSize} total={Number(r.data.total)} onPage={setPage} />
        </>
      )}
    </Modal>
  );
}
