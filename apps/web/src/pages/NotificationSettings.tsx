import { NOTIFICATION_EVENT_LABELS, NOTIFICATION_EVENTS, renderTemplate, TEMPLATE_VARIABLES, type NotificationEvent } from '@kx/shared';
import { useEffect, useRef, useState } from 'react';
import { Badge, Button, Card, ErrorBox, fa, Field, Loading, PageHeader } from '../components/ui';
import { api, post } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useApi } from '../lib/hooks';

const SAMPLE = Object.fromEntries(TEMPLATE_VARIABLES.map((v) => [v.key, v.sample]));

/** Persian SMS: 70 characters in one part, 67 per part when longer. */
const smsParts = (text: string) => (text.length <= 70 ? 1 : Math.ceil(text.length / 67));

/** Chamber notification settings: SMS panel (Kavenegar), mail server and the text of every message. */
export function NotificationSettingsPage() {
  const { chamberId, isAdmin, me } = useAuth();
  const { data, error, setData } = useApi<any>(chamberId && isAdmin ? `/chambers/${chamberId}/notification-settings` : null);
  const [form, setForm] = useState<any>(null);
  const [event, setEvent] = useState<NotificationEvent>('meeting.invited');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<Error | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => {
    if (data) setForm(structuredClone(data));
  }, [data]);

  if (!isAdmin) return <ErrorBox error={new Error('این بخش فقط برای مدیر اتاق است')} />;
  if (error) return <ErrorBox error={error} />;
  if (!form) return <Loading />;

  const set = (path: string[], value: unknown) =>
    setForm((f: any) => {
      const next = structuredClone(f);
      let o = next;
      for (const k of path.slice(0, -1)) o = o[k];
      o[path[path.length - 1]] = value;
      return next;
    });
  const save = async () => {
    setBusy(true);
    setErr(null);
    setMsg(null);
    try {
      const r = await api(`/chambers/${chamberId}/notification-settings`, { method: 'PUT', json: { ...form, sms: { ...form.sms, apiKey: form.sms.apiKey || null }, email: { ...form.email, password: form.email.password || null } } });
      setData(r);
      setMsg('تنظیمات اطلاع‌رسانی ذخیره شد');
    } catch (e) {
      setErr(e as Error);
    } finally {
      setBusy(false);
    }
  };
  const ev = form.events[event];

  return (
    <>
      <PageHeader
        title="تنظیمات اطلاع‌رسانی"
        subtitle="پنل پیامک، سرور ایمیل و متن پیام‌هایی که برای دعوت به جلسه، مصوبات و یادآوری‌ها ارسال می‌شود"
        actions={
          <Button busy={busy} onClick={save}>
            ذخیره تنظیمات
          </Button>
        }
      />
      <ErrorBox error={err} />
      {msg && <div className="alert alert-success">{msg}</div>}

      <Card title="آدرس سامانه">
        <Field label="آدرس سامانه برای متغیر {لینک}" hint="مثلاً http://134.255.202.204:8000 یا https://commission.example.ir — در پیامک و ایمیل به صفحه جلسه یا مصوبه لینک داده می‌شود">
          <input className="input ltr" value={form.publicUrl} onChange={(e) => set(['publicUrl'], e.target.value)} placeholder="https://" />
        </Field>
      </Card>

      <div className="grid grid-2 mt">
        <Card title={<span className="row gap-sm">📱 پیامک (کاوه‌نگار) {data.sms.enabled ? <Badge tone="success">فعال</Badge> : <Badge>غیرفعال</Badge>}</span>}>
          <label className="check">
            <input type="checkbox" checked={form.sms.enabled} onChange={(e) => set(['sms', 'enabled'], e.target.checked)} /> ارسال پیامک فعال باشد
          </label>
          <Field label="کلید API کاوه‌نگار" hint={data.sms.apiKeyHint ? `کلید ذخیره‌شده: ${data.sms.apiKeyHint} — برای تغییر، کلید جدید را وارد کنید` : 'از پنل کاوه‌نگار، بخش «تنظیمات حساب ← کلید API»'}>
            <input className="input ltr" type="password" autoComplete="off" value={form.sms.apiKey} onChange={(e) => set(['sms', 'apiKey'], e.target.value)} placeholder={data.sms.apiKeyHint || ''} />
          </Field>
          <Field label="شماره خط فرستنده" hint="خط اختصاصی شما در کاوه‌نگار؛ اگر خالی بماند خط پیش‌فرض حساب استفاده می‌شود">
            <input className="input ltr" value={form.sms.sender} onChange={(e) => set(['sms', 'sender'], e.target.value)} placeholder="10004346" />
          </Field>
          <TestSend channel="sms" chamberId={chamberId!} event={event} initial={me?.mobile ?? ''} label="شماره موبایل" />
        </Card>

        <Card title={<span className="row gap-sm">✉️ ایمیل (SMTP) {data.email.enabled ? <Badge tone="success">فعال</Badge> : <Badge>غیرفعال</Badge>}</span>}>
          <label className="check">
            <input type="checkbox" checked={form.email.enabled} onChange={(e) => set(['email', 'enabled'], e.target.checked)} /> ارسال ایمیل فعال باشد
          </label>
          <div className="grid grid-2">
            <Field label="سرور SMTP">
              <input className="input ltr" value={form.email.host} onChange={(e) => set(['email', 'host'], e.target.value)} placeholder="mail.example.ir" />
            </Field>
            <Field label="پورت" hint="معمولاً ۵۸۷ (STARTTLS) یا ۴۶۵ (SSL)">
              <input className="input ltr" type="number" value={form.email.port} onChange={(e) => set(['email', 'port'], Number(e.target.value))} />
            </Field>
          </div>
          <label className="check">
            <input type="checkbox" checked={form.email.secure} onChange={(e) => set(['email', 'secure'], e.target.checked)} /> اتصال SSL از ابتدا (پورت ۴۶۵)
          </label>
          <div className="grid grid-2">
            <Field label="نام کاربری">
              <input className="input ltr" autoComplete="off" value={form.email.user} onChange={(e) => set(['email', 'user'], e.target.value)} />
            </Field>
            <Field label="رمز عبور" hint={data.email.hasPassword ? 'رمز ذخیره شده است؛ برای تغییر، رمز جدید را وارد کنید' : undefined}>
              <input className="input ltr" type="password" autoComplete="new-password" value={form.email.password} onChange={(e) => set(['email', 'password'], e.target.value)} placeholder={data.email.hasPassword ? '••••••••' : ''} />
            </Field>
            <Field label="نشانی فرستنده">
              <input className="input ltr" value={form.email.from} onChange={(e) => set(['email', 'from'], e.target.value)} placeholder="noreply@example.ir" />
            </Field>
            <Field label="نام فرستنده">
              <input className="input" value={form.email.fromName} onChange={(e) => set(['email', 'fromName'], e.target.value)} placeholder="اتاق بازرگانی …" />
            </Field>
          </div>
          <TestSend channel="email" chamberId={chamberId!} event={event} initial={me?.email ?? ''} label="نشانی ایمیل" />
        </Card>
      </div>

      <Card title="متن پیام‌ها" className="mt">
        <div className="row gap wrap" style={{ alignItems: 'flex-start' }}>
          <div style={{ minWidth: 240, flex: '0 0 260px' }}>
            <ul className="list" style={{ margin: 0 }}>
              {NOTIFICATION_EVENTS.map((e) => {
                const c = form.events[e];
                return (
                  <li key={e}>
                    <button type="button" className={`btn btn-sm ${e === event ? 'btn-primary' : 'btn-ghost'}`} style={{ width: '100%', justifyContent: 'space-between' }} onClick={() => setEvent(e)}>
                      <span>{NOTIFICATION_EVENT_LABELS[e]}</span>
                      <span className="small" style={{ opacity: 0.8 }}>
                        {c.sms.enabled ? '📱' : ''}
                        {c.email.enabled ? '✉️' : ''}
                        {c.push.enabled ? '🔔' : ''}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
          <div className="grow" style={{ minWidth: 300 }}>
            <h3 className="mb">{NOTIFICATION_EVENT_LABELS[event]}</h3>
            <div className="row gap wrap mb">
              <label className="check">
                <input type="checkbox" checked={ev.push.enabled} onChange={(e) => set(['events', event, 'push', 'enabled'], e.target.checked)} /> 🔔 اعلان روی گوشی
              </label>
              <label className="check">
                <input type="checkbox" checked={ev.sms.enabled} onChange={(e) => set(['events', event, 'sms', 'enabled'], e.target.checked)} /> 📱 پیامک
              </label>
              <label className="check">
                <input type="checkbox" checked={ev.email.enabled} onChange={(e) => set(['events', event, 'email', 'enabled'], e.target.checked)} /> ✉️ ایمیل
              </label>
            </div>
            <p className="muted small">
              اعلان داخل سامانه و اپ همیشه ارسال می‌شود. پیامک و ایمیل فقط وقتی ارسال می‌شوند که علاوه بر این تیک، بخش پیامک یا ایمیل بالا هم فعال باشد.
            </p>
            <TemplateEditor label="متن پیامک" value={ev.sms.text} onChange={(v) => set(['events', event, 'sms', 'text'], v)} sms />
            <Field label="موضوع ایمیل">
              <input className="input" value={ev.email.subject} onChange={(e) => set(['events', event, 'email', 'subject'], e.target.value)} />
            </Field>
            <TemplateEditor label="متن ایمیل" value={ev.email.text} onChange={(v) => set(['events', event, 'email', 'text'], v)} rows={8} />
          </div>
        </div>
      </Card>
      <div className="row mt" style={{ justifyContent: 'flex-end' }}>
        <Button busy={busy} onClick={save}>
          ذخیره تنظیمات
        </Button>
      </div>
    </>
  );
}

/** Text area with variable chips (inserted at the cursor) and a preview with sample values. */
function TemplateEditor({ label, value, onChange, sms, rows = 5 }: { label: string; value: string; onChange: (v: string) => void; sms?: boolean; rows?: number }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const insert = (key: string) => {
    const el = ref.current;
    const token = `{${key}}`;
    if (!el) return onChange(value + token);
    const [a, b] = [el.selectionStart ?? value.length, el.selectionEnd ?? value.length];
    onChange(value.slice(0, a) + token + value.slice(b));
    requestAnimationFrame(() => {
      el.focus();
      el.selectionStart = el.selectionEnd = a + token.length;
    });
  };
  const preview = renderTemplate(value, SAMPLE);
  return (
    <div className="mb">
      <Field label={label}>
        <textarea ref={ref} className="input" rows={rows} value={value} onChange={(e) => onChange(e.target.value)} />
      </Field>
      <div className="row gap-sm wrap mb" aria-label="متغیرها">
        {TEMPLATE_VARIABLES.map((v) => (
          <button key={v.key} type="button" className="btn btn-ghost btn-sm" style={{ border: '1px dashed var(--border)' }} title={`${v.label} — نمونه: ${v.sample}`} onClick={() => insert(v.key)}>
            {`{${v.key}}`}
          </button>
        ))}
      </div>
      <div className="small" style={{ background: 'var(--surface-2)', borderRadius: 8, padding: '8px 10px', whiteSpace: 'pre-wrap' }}>
        <div className="muted">پیش‌نمایش با مقادیر نمونه{sms ? ` — ${fa(preview.length)} نویسه، ${fa(smsParts(preview))} پیامک` : ''}:</div>
        {preview || <span className="muted">—</span>}
      </div>
    </div>
  );
}

function TestSend({ channel, chamberId, event, initial, label }: { channel: 'sms' | 'email'; chamberId: string; event: NotificationEvent; initial: string; label: string }) {
  const [to, setTo] = useState(initial);
  const [state, setState] = useState<{ ok?: string; err?: Error; busy?: boolean }>({});
  const run = async () => {
    setState({ busy: true });
    try {
      await post(`/chambers/${chamberId}/notification-settings/test`, { channel, to, event });
      setState({ ok: channel === 'sms' ? 'پیامک آزمایشی ارسال شد' : 'ایمیل آزمایشی ارسال شد' });
    } catch (e) {
      setState({ err: e as Error });
    }
  };
  return (
    <div className="mt" style={{ borderTop: '1px solid var(--border)', paddingTop: 10 }}>
      <div className="muted small mb">ارسال آزمایشی متن «{NOTIFICATION_EVENT_LABELS[event]}» با تنظیمات ذخیره‌شده:</div>
      <div className="row gap-sm">
        <input className="input ltr" value={to} onChange={(e) => setTo(e.target.value)} placeholder={label} aria-label={label} />
        <Button variant="secondary" busy={state.busy} disabled={to.trim().length < 5} onClick={run}>
          ارسال آزمایشی
        </Button>
      </div>
      {state.ok && <div className="alert alert-success mt">{state.ok}</div>}
      <ErrorBox error={state.err} />
    </div>
  );
}
