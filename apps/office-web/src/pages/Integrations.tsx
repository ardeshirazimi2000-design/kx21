import { useEffect, useState } from 'react';
import { UnitSelect } from '../components/pickers';
import { Badge, Button, Card, ErrorBox, Field, Loading, PageHeader, Pager, dateTimeFa, fa } from '../components/ui';
import { post, put } from '../lib/api';
import { useAction, useApi } from '../lib/hooks';

const INBOX: Record<string, [string, 'neutral' | 'success' | 'danger' | 'warning']> = {
  received: ['دریافت‌شده', 'warning'],
  processed: ['پردازش‌شده', 'success'],
  ignored: ['نادیده', 'neutral'],
  failed: ['خطا', 'danger'],
};

export function IntegrationsPage() {
  const r = useApi<any>('/integrations');
  const [page, setPage] = useState(1);
  const inbox = useApi<{ items: any[]; total: number; page: number; pageSize: number }>(`/integrations/meetings/inbox?page=${page}`, [page]);
  const meetings = r.data?.items.find((i: any) => i.kind === 'meetings');
  const intake = r.data?.items.find((i: any) => i.kind === 'intake');
  const [f, setF] = useState({ baseUrl: '', clientId: '', apiKey: '', webhookSecret: '', isActive: true, auth: 'apikey', poll: false, autoFeedback: true, defaultUnitId: '' });
  const [intakeUnit, setIntakeUnit] = useState('');
  const [newKey, setNewKey] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const act = useAction();
  useEffect(() => {
    if (!meetings) return;
    setF((x) => ({
      ...x,
      baseUrl: meetings.base_url ?? '',
      clientId: meetings.client_id ?? '',
      isActive: meetings.is_active,
      auth: meetings.settings?.auth ?? 'apikey',
      poll: !!meetings.settings?.poll,
      autoFeedback: meetings.settings?.autoFeedback !== false,
      defaultUnitId: meetings.settings?.defaultUnitId ?? '',
    }));
  }, [meetings?.id, meetings?.updated_at]);
  useEffect(() => setIntakeUnit(intake?.settings?.defaultUnitId ?? ''), [intake?.id]);
  if (!r.data) return <Loading />;
  const save = () =>
    act.run(async () => {
      await put('/integrations/meetings', {
        baseUrl: f.baseUrl,
        clientId: f.clientId || null,
        apiKey: f.apiKey || undefined,
        webhookSecret: f.webhookSecret || undefined,
        isActive: f.isActive,
        settings: { auth: f.auth, poll: f.poll, autoFeedback: f.autoFeedback, ...(f.defaultUnitId ? { defaultUnitId: f.defaultUnitId } : {}) },
      });
      setF((x) => ({ ...x, apiKey: '', webhookSecret: '' }));
      await r.reload();
      setResult('تنظیمات ذخیره شد.');
    });
  return (
    <>
      <PageHeader title="یکپارچه‌سازی" subtitle="اتصال دوطرفه با سامانه جلسات کمیسیون‌ها و درگاه دریافت نامه (ایمیل، اسکن، سامانه‌های دیگر)" />
      <ErrorBox error={act.error} />
      {result && <div className="alert alert-success">{result}</div>}
      <Card
        title={
          <span className="row gap-sm">
            سامانه جلسات کمیسیون‌ها {meetings?.is_active ? <Badge tone="success">فعال</Badge> : <Badge>غیرفعال</Badge>}
          </span>
        }
        actions={
          meetings && (
            <>
              <Button variant="secondary" size="sm" busy={act.busy} onClick={() => act.run(async () => setResult(`اتصال برقرار است: ${(await post('/integrations/meetings/test')).remote.name}`))}>
                آزمایش اتصال
              </Button>
              <Button variant="secondary" size="sm" busy={act.busy} onClick={() => act.run(async () => {
                const s = await post('/integrations/meetings/sync');
                setResult(`همگام‌سازی انجام شد: ${fa(s.meetings)} جلسه، ${fa(s.events)} رویداد جدید`);
                await inbox.reload();
                await r.reload();
              })}>
                همگام‌سازی اکنون
              </Button>
            </>
          )
        }
      >
        <p className="small muted">
          در سامانه جلسات (بخش «یکپارچه‌سازی»)، یک سامانه خارجی با آدرس وب‌هوک زیر تعریف کنید و کلید API و رمز وب‌هوک صادرشده را اینجا وارد کنید.
        </p>
        <Field label="آدرس وب‌هوک این سامانه (برای ثبت در سامانه جلسات)">
          <input className="input ltr" readOnly value={r.data.webhookUrl} onFocus={(e) => e.target.select()} />
        </Field>
        <div className="grid grid-2">
          <Field label="آدرس سامانه جلسات">
            <input className="input ltr" placeholder="https://commissions.example.ir" value={f.baseUrl} onChange={(e) => setF({ ...f, baseUrl: e.target.value })} />
          </Field>
          <Field label="روش احراز هویت">
            <select className="input" value={f.auth} onChange={(e) => setF({ ...f, auth: e.target.value })}>
              <option value="apikey">کلید API (X-Api-Key)</option>
              <option value="oauth2">OAuth2 (client credentials)</option>
            </select>
          </Field>
          {f.auth === 'oauth2' && (
            <Field label="شناسه کلاینت (client_id)">
              <input className="input ltr" value={f.clientId} onChange={(e) => setF({ ...f, clientId: e.target.value })} />
            </Field>
          )}
          <Field label="کلید API" hint={meetings?.hasApiKey ? 'ذخیره شده است؛ برای تغییر مقدار جدید وارد کنید' : undefined}>
            <input className="input ltr" type="password" autoComplete="off" value={f.apiKey} onChange={(e) => setF({ ...f, apiKey: e.target.value })} />
          </Field>
          <Field label="رمز امضای وب‌هوک" hint={meetings?.hasWebhookSecret ? 'ذخیره شده است' : undefined}>
            <input className="input ltr" type="password" autoComplete="off" value={f.webhookSecret} onChange={(e) => setF({ ...f, webhookSecret: e.target.value })} />
          </Field>
          <Field label="واحد پیش‌فرض نامه‌های مصوبه" hint="وقتی مسئول اجرای مصوبه در اتوماسیون شناسایی نشود">
            <UnitSelect value={f.defaultUnitId} onChange={(v) => setF({ ...f, defaultUnitId: v })} />
          </Field>
        </div>
        <div className="row gap wrap mb">
          <label className="check">
            <input type="checkbox" checked={f.isActive} onChange={(e) => setF({ ...f, isActive: e.target.checked })} />
            فعال
          </label>
          <label className="check">
            <input type="checkbox" checked={f.autoFeedback} onChange={(e) => setF({ ...f, autoFeedback: e.target.checked })} />
            پایان گردش پیگیری، پیشرفت ۱۰۰٪ را به سامانه جلسات گزارش دهد
          </label>
          <label className="check">
            <input type="checkbox" checked={f.poll} onChange={(e) => setF({ ...f, poll: e.target.checked })} />
            دریافت دوره‌ای رویدادها (وقتی وب‌هوک در دسترس نیست)
          </label>
        </div>
        <Button busy={act.busy} disabled={!f.baseUrl} onClick={() => void save()}>
          ذخیره
        </Button>
        {meetings && (
          <dl className="kv mt small">
            <dt>آخرین همگام‌سازی</dt>
            <dd>{meetings.last_sync_at ? dateTimeFa(meetings.last_sync_at) : '—'}</dd>
            {meetings.last_error && (
              <>
                <dt>آخرین خطا</dt>
                <dd className="field-error">{meetings.last_error}</dd>
              </>
            )}
            <dt>رویدادها</dt>
            <dd>{Object.entries(r.data.inbox).map(([k, n]) => `${INBOX[k]?.[0] ?? k}: ${fa(n as string)}`).join(' · ') || '—'}</dd>
            <dt>گزارش‌های پیگیری</dt>
            <dd>{Object.entries(r.data.feedback).map(([k, n]) => `${k === 'sent' ? 'ارسال‌شده' : k === 'pending' ? 'در صف' : 'ناموفق'}: ${fa(n as string)}`).join(' · ') || '—'}</dd>
          </dl>
        )}
      </Card>

      <AiSettings />

      <Card title="رویدادهای دریافتی از سامانه جلسات" className="mt">
        <table className="table">
          <thead>
            <tr>
              <th>رویداد</th>
              <th>دریافت</th>
              <th>وضعیت</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {(inbox.data?.items ?? []).map((e) => (
              <tr key={e.id}>
                <td className="mono">{e.event_type}</td>
                <td className="small">{dateTimeFa(e.received_at)}</td>
                <td>
                  <Badge tone={INBOX[e.status]?.[1] ?? 'neutral'}>{INBOX[e.status]?.[0] ?? e.status}</Badge>
                  {e.error && <div className="small field-error">{e.error}</div>}
                </td>
                <td>
                  {e.status === 'failed' && (
                    <Button variant="ghost" size="sm" onClick={() => act.run(async () => (await post(`/integrations/meetings/inbox/${e.id}/retry`), await inbox.reload()))}>
                      تلاش دوباره
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {inbox.data && <Pager page={inbox.data.page} pageSize={inbox.data.pageSize} total={Number(inbox.data.total)} onPage={setPage} />}
      </Card>

      <Card
        title={
          <span className="row gap-sm">
            درگاه دریافت نامه (ایمیل / اسکن / API) {intake?.is_active ? <Badge tone="success">فعال</Badge> : <Badge>غیرفعال</Badge>}
          </span>
        }
        className="mt"
      >
        <p className="small muted">سامانه‌های دریافت ایمیل، اسکنرهای شبکه یا سامانه‌های دیگر نامه وارده را با کلید زیر به این آدرس می‌فرستند؛ نامه به‌صورت پیش‌نویس در کارتابل دبیرخانه قرار می‌گیرد.</p>
        <Field label="آدرس">
          <input className="input ltr" readOnly value={`POST ${r.data.intakeUrl}`} />
        </Field>
        <Field label="واحد دریافت‌کننده">
          <UnitSelect value={intakeUnit} onChange={setIntakeUnit} emptyLabel="دبیرخانه" />
        </Field>
        {newKey && (
          <div className="alert alert-warning">
            کلید جدید (فقط همین یک بار نمایش داده می‌شود): <span className="mono">{newKey}</span>
          </div>
        )}
        <div className="row gap">
          <Button variant="secondary" busy={act.busy} onClick={() => act.run(async () => (await put('/integrations/intake', { isActive: true, defaultUnitId: intakeUnit || null }), await r.reload()))}>
            ذخیره
          </Button>
          <Button busy={act.busy} onClick={() => act.run(async () => (setNewKey((await put('/integrations/intake', { isActive: true, defaultUnitId: intakeUnit || null, rotateKey: true })).apiKey), await r.reload()))}>
            {intake?.hasInboundKey ? 'صدور کلید جدید' : 'صدور کلید'}
          </Button>
          {intake?.is_active && (
            <Button variant="ghost" onClick={() => act.run(async () => (await put('/integrations/intake', { isActive: false, defaultUnitId: intakeUnit || null }), await r.reload()))}>
              غیرفعال‌سازی
            </Button>
          )}
        </div>
      </Card>
    </>
  );
}

/** Optional AI model for the smart search (any OpenAI-compatible API, ideally on the organisation's own server). */
function AiSettings() {
  const r = useApi<any>('/integrations/ai');
  const [f, setF] = useState({ baseUrl: '', apiKey: '', embeddingModel: '', chatModel: '', isActive: true });
  const [test, setTest] = useState<any>(null);
  const act = useAction();
  useEffect(() => {
    if (r.data) setF({ baseUrl: r.data.baseUrl, apiKey: '', embeddingModel: r.data.embeddingModel, chatModel: r.data.chatModel, isActive: r.data.baseUrl ? r.data.isActive : true });
  }, [r.data]);
  const s = r.data?.stats;
  return (
    <Card title="هوش مصنوعی (جستجوی هوشمند)" className="mt">
      <p className="small muted">
        جستجوی هوشمند بدون این تنظیم هم کار می‌کند. با اتصال به یک مدل سازگار با OpenAI (ترجیحاً روی سرور خود سازمان، مثلاً Ollama با مدل چندزبانه bge-m3 برای
        embedding و یک مدل گفتگوی فارسی‌دان)، موضوع جستجو با واژه‌های هم‌معنی گسترش می‌یابد، نتایج از نظر معنایی رتبه‌بندی می‌شوند و خلاصه هوشمند فعال می‌شود. متن
        نامه‌های طبقه‌بندی‌شده هرگز به مدل فرستاده نمی‌شود.
      </p>
      <ErrorBox error={act.error} />
      <div className="grid grid-2">
        <Field label="نشانی API" hint="مثلاً http://ollama:11434/v1">
          <input className="input ltr" value={f.baseUrl} onChange={(e) => setF({ ...f, baseUrl: e.target.value })} />
        </Field>
        <Field label="کلید API" hint={r.data?.hasApiKey ? 'ثبت شده؛ برای تغییر مقدار تازه وارد کنید' : 'اگر سرویس کلید نمی‌خواهد خالی بگذارید'}>
          <input className="input ltr" type="password" value={f.apiKey} onChange={(e) => setF({ ...f, apiKey: e.target.value })} autoComplete="new-password" />
        </Field>
        <Field label="مدل embedding (رتبه‌بندی معنایی)">
          <input className="input ltr" value={f.embeddingModel} onChange={(e) => setF({ ...f, embeddingModel: e.target.value })} placeholder="bge-m3" />
        </Field>
        <Field label="مدل گفتگو (گسترش موضوع و خلاصه)">
          <input className="input ltr" value={f.chatModel} onChange={(e) => setF({ ...f, chatModel: e.target.value })} placeholder="qwen2.5:7b" />
        </Field>
      </div>
      <div className="row gap wrap">
        <label className="check">
          <input type="checkbox" checked={f.isActive} onChange={(e) => setF({ ...f, isActive: e.target.checked })} />
          فعال
        </label>
        <Button
          busy={act.busy}
          onClick={() =>
            act.run(async () => {
              await put('/integrations/ai', { ...f, apiKey: f.apiKey ? f.apiKey : undefined, embeddingModel: f.embeddingModel || null, chatModel: f.chatModel || null });
              setTest(null);
              await r.reload();
            })
          }
        >
          ذخیره
        </Button>
        {r.data?.baseUrl && (
          <Button variant="secondary" busy={act.busy} onClick={() => act.run(async () => setTest(await post('/integrations/ai/test')))}>
            آزمایش اتصال
          </Button>
        )}
        {r.data?.hasApiKey && (
          <Button variant="ghost" busy={act.busy} onClick={() => act.run(async () => (await put('/integrations/ai', { ...f, apiKey: null }), await r.reload()))}>
            حذف کلید
          </Button>
        )}
      </div>
      {test && (
        <ul className="list mt small">
          {test.embedding && <li>embedding: {test.embedding.ok ? <Badge tone="success">موفق ({fa(test.embedding.dimensions)} بُعد)</Badge> : <Badge tone="danger">{test.embedding.error}</Badge>}</li>}
          {test.chat && <li>گفتگو: {test.chat.ok ? <Badge tone="success">موفق</Badge> : <Badge tone="danger">{test.chat.error}</Badge>}</li>}
        </ul>
      )}
      {s && (
        <p className="small muted mt">
          نمایه جستجو: {fa(s.indexed)} از {fa(s.letters)} نامه{s.embedded ? ` · بردار معنایی: ${fa(s.embedded)} نامه` : ''}. نامه‌های تازه در جستجوی بعدی یا اجرای زمان‌بندی‌شده
          نمایه می‌شوند.
        </p>
      )}
    </Card>
  );
}
