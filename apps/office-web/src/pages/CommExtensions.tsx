import { useState } from 'react';
import { UserSelect } from '../components/pickers';
import { Badge, Button, Card, Empty, ErrorBox, Field, Loading, Modal, PageHeader, dateTimeFa, fa, type Tone } from '../components/ui';
import { patch, post, put } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useAction, useApi } from '../lib/hooks';
import { useRealtime } from '../lib/realtime';
import '../communications.css';

interface Ext {
  id: string;
  user_id: string;
  full_name: string;
  user_active: boolean;
  unit_name: string | null;
  extension_number: string;
  label: string | null;
  status: 'draft' | 'provisioning' | 'active' | 'suspended' | 'failed' | 'disabled';
  provision_source: 'adapter' | 'manual' | null;
  last_error: string | null;
  last_registered_at: string | null;
  updated_at: string;
}

export const EXT_STATUS: Record<Ext['status'], [string, Tone]> = {
  draft: ['پیش‌نویس', 'neutral'],
  provisioning: ['در حال ایجاد در مرکز تلفن', 'info'],
  active: ['فعال', 'success'],
  suspended: ['معلق', 'warning'],
  failed: ['ایجاد ناموفق', 'danger'],
  disabled: ['غیرفعال‌شده', 'neutral'],
};

/** «مدیریت داخلی‌ها»: assign internal numbers to people and follow each one's lifecycle. Records are never deleted. */
export function CommExtensionsPage() {
  const [q, setQ] = useState('');
  const r = useApi<Ext[]>(`/communications/extensions?q=${encodeURIComponent(q)}`, [q]);
  const status = useApi<{ pbx: { configured: boolean; kind: string; connected: boolean } }>('/communications/status');
  const [adding, setAdding] = useState(false);
  const [secret, setSecret] = useState<{ number: string; username: string; password: string } | null>(null);
  const { can } = useAuth();
  useRealtime({ ExtensionStatusChanged: () => void r.reload() });
  const act = useAction();
  const pbxReady = !!status.data?.pbx.configured;

  const change = (e: Ext, to: Ext['status'], question?: string) =>
    act.run(async () => {
      if (question && !confirm(question)) return;
      await patch(`/communications/extensions/${e.id}`, { status: to });
      await r.reload();
    });
  const newSecret = (e: Ext) =>
    act.run(async () => {
      if (!confirm(`رمز SIP داخلی ${fa(e.extension_number)} عوض شود؟ گوشی فعلی تا وارد کردن رمز جدید وصل نمی‌شود.`)) return;
      const s = await post<{ username: string; password: string }>(`/communications/extensions/${e.id}/credentials`);
      setSecret({ number: e.extension_number, ...s });
    });
  const provision = (e: Ext) =>
    act.run(async () => {
      await post(`/communications/extensions/${e.id}/provision`);
      await r.reload();
    });

  return (
    <>
      <PageHeader
        title="مدیریت داخلی‌ها"
        subtitle="شماره داخلی به شخص تعلق دارد، نه به واحد یا سمت؛ با جابه‌جایی همکار، داخلی او تغییر نمی‌کند"
        actions={<Button onClick={() => setAdding(true)}>تخصیص داخلی</Button>}
      />
      {status.data && !pbxReady && (
        <div className="alert alert-info mb" role="status">
          مرکز تلفن هنوز به رسا متصل نشده است. داخلی را در مرکز تلفن بسازید و سپس «تأیید ایجاد در مرکز تلفن» را بزنید.
        </div>
      )}
      {pbxReady && !status.data?.pbx.connected && (
        <div className="alert alert-warning mb" role="status">
          ارتباط رسا با مرکز تلفن (Asterisk) قطع است. تغییرات داخلی‌ها پس از وصل شدن دوباره به مرکز تلفن اعمال می‌شود.
        </div>
      )}
      <Card>
        <input className="input mb" placeholder="جستجوی شماره یا نام…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="جستجو" />
        <ErrorBox error={r.error ?? act.error} />
        {r.loading && !r.data ? (
          <Loading />
        ) : !r.data?.length ? (
          <Empty>هنوز داخلی‌ای ثبت نشده است.</Empty>
        ) : (
          <ul className="ext-list">
            {r.data.map((e) => {
              const [label, tone] = EXT_STATUS[e.status];
              return (
                <li key={e.id} className={`ext-row ${e.status === 'disabled' ? 'inactive' : ''}`}>
                  <span className="ext-number mono">{fa(e.extension_number)}</span>
                  <span className="ext-owner">
                    <strong>{e.full_name}</strong>
                    <span className="small muted">
                      {e.unit_name ?? '—'}
                      {e.label ? ` · ${e.label}` : ''}
                      {!e.user_active && ' · کاربر غیرفعال'}
                    </span>
                    {e.last_error && <span className="small text-danger">{e.last_error}</span>}
                  </span>
                  <span className="ext-status">
                    <Badge tone={tone}>{label}</Badge>
                    <span className="small muted">{dateTimeFa(e.updated_at)}</span>
                    {pbxReady && e.status === 'active' && (
                      <span className="small muted">{e.last_registered_at ? `آخرین اتصال گوشی: ${dateTimeFa(e.last_registered_at)}` : 'هنوز گوشی‌ای وصل نشده'}</span>
                    )}
                  </span>
                  <span className="ext-actions">
                    {['draft', 'failed'].includes(e.status) && pbxReady && (
                      <Button size="sm" onClick={() => provision(e)} disabled={act.busy}>
                        ایجاد در مرکز تلفن
                      </Button>
                    )}
                    {['draft', 'failed'].includes(e.status) && (
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => change(e, 'active', `داخلی ${fa(e.extension_number)} در مرکز تلفن ساخته شده است؟`)}
                        disabled={act.busy}
                      >
                        تأیید ایجاد در مرکز تلفن
                      </Button>
                    )}
                    {e.status === 'active' && pbxReady && (
                      <Button size="sm" variant="secondary" onClick={() => newSecret(e)} disabled={act.busy}>
                        رمز جدید گوشی
                      </Button>
                    )}
                    {e.status === 'active' && (
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => change(e, 'suspended', `داخلی ${fa(e.extension_number)} معلق شود؟`)}
                        disabled={act.busy}
                      >
                        تعلیق
                      </Button>
                    )}
                    {e.status === 'suspended' && (
                      <Button size="sm" variant="secondary" onClick={() => change(e, 'active')} disabled={act.busy}>
                        فعال‌سازی دوباره
                      </Button>
                    )}
                    {e.status !== 'disabled' && (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() =>
                          change(e, 'disabled', `داخلی ${fa(e.extension_number)} برای همیشه غیرفعال شود؟ سابقه آن می‌ماند و شماره به دیگری قابل تخصیص می‌شود.`)
                        }
                        disabled={act.busy}
                      >
                        غیرفعال‌سازی
                      </Button>
                    )}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </Card>
      {pbxReady && can('communications.settings.manage') && <InboundSettings extensions={r.data ?? []} />}
      {secret && <SecretModal secret={secret} onClose={() => setSecret(null)} />}
      {adding && (
        <NewExtension
          onClose={() => setAdding(false)}
          onSaved={async () => {
            setAdding(false);
            await r.reload();
          }}
        />
      )}
    </>
  );
}

function NewExtension({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [userId, setUserId] = useState('');
  const [number, setNumber] = useState('');
  const [label, setLabel] = useState('');
  const [exists, setExists] = useState(false);
  const act = useAction();
  const save = () =>
    act.run(async () => {
      await post('/communications/extensions', {
        userId,
        extensionNumber: number.replace(/[۰-۹]/g, (d) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d))),
        label: label || null,
        existsOnPbx: exists,
      });
      onSaved();
    });
  return (
    <Modal
      title="تخصیص شماره داخلی"
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            انصراف
          </Button>
          <Button onClick={save} busy={act.busy} disabled={!userId || !number}>
            ثبت
          </Button>
        </>
      }
    >
      <ErrorBox error={act.error} />
      <Field label="کاربر">
        <UserSelect value={userId} onChange={setUserId} />
      </Field>
      <Field label="شماره داخلی" hint="۲ تا ۶ رقم">
        <input className="input mono" inputMode="numeric" value={number} onChange={(e) => setNumber(e.target.value)} maxLength={6} />
      </Field>
      <Field label="برچسب (اختیاری)" hint="مثلاً «میز کار» یا «اتاق جلسات»">
        <input className="input" value={label} onChange={(e) => setLabel(e.target.value)} maxLength={100} />
      </Field>
      <label className="row gap-sm">
        <input type="checkbox" checked={exists} onChange={(e) => setExists(e.target.checked)} />
        این داخلی از قبل در مرکز تلفن ساخته شده است (مستقیم فعال شود)
      </label>
    </Modal>
  );
}

/** The new SIP password, shown once: it is not stored in the browser and cannot be shown again (only replaced). */
function SecretModal({ secret, onClose }: { secret: { number: string; username: string; password: string }; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(secret.password);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };
  return (
    <Modal
      title={`تنظیمات گوشی داخلی ${fa(secret.number)}`}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={copy}>
            {copied ? 'رونوشت شد' : 'رونوشت رمز'}
          </Button>
          <Button onClick={onClose}>وارد کردم، بستن</Button>
        </>
      }
    >
      <div className="alert alert-warning">این رمز فقط همین یک بار نمایش داده می‌شود. آن را مستقیم در گوشی یا نرم‌افزار تلفن وارد کنید و جایی یادداشت نکنید.</div>
      <div className="secret-box">
        <span className="muted">SIP server</span>
        <span className="mono">{window.location.hostname}</span>
        <span className="muted">User / Auth ID</span>
        <span className="mono">{secret.username}</span>
        <span className="muted">Password</span>
        <span className="mono">{secret.password}</span>
      </div>
      <p className="small muted">درگاه 5060 و پروتکل UDP. اگر گوشی پیش‌تر با رمز قبلی وصل بوده، تا وارد کردن رمز جدید وصل نمی‌شود.</p>
    </Modal>
  );
}

/** Where calls from the city line ring: one or more active extensions together. */
function InboundSettings({ extensions }: { extensions: Ext[] }) {
  const s = useApi<{ targets: string[]; ringSeconds: number }>('/communications/settings/inbound');
  const [targets, setTargets] = useState<string[] | null>(null);
  const [ring, setRing] = useState<number | null>(null);
  const act = useAction();
  const [saved, setSaved] = useState(false);
  const current = targets ?? s.data?.targets ?? [];
  const seconds = ring ?? s.data?.ringSeconds ?? 40;
  const active = extensions.filter((e) => e.status === 'active');
  const toggle = (n: string) => {
    setSaved(false);
    setTargets(current.includes(n) ? current.filter((x) => x !== n) : [...current, n]);
  };
  const save = () =>
    act.run(async () => {
      const r = await put<{ targets: string[]; ringSeconds: number }>('/communications/settings/inbound', { targets: current, ringSeconds: seconds });
      s.setData(r);
      setTargets(null);
      setRing(null);
      setSaved(true);
    });
  return (
    <Card title="تماس‌های خط شهری">
      <p className="small muted">وقتی کسی با شماره سازمان تماس می‌گیرد، این داخلی‌ها با هم زنگ می‌خورند؛ اولین کسی که بردارد پاسخ می‌دهد.</p>
      <ErrorBox error={s.error ?? act.error} />
      {!active.length ? (
        <Empty>هنوز داخلی فعالی نیست.</Empty>
      ) : (
        <div className="inbound-targets">
          {active.map((e) => (
            <label key={e.id} className="row gap-sm">
              <input type="checkbox" checked={current.includes(e.extension_number)} onChange={() => toggle(e.extension_number)} />
              <span className="mono">{fa(e.extension_number)}</span> {e.full_name}
            </label>
          ))}
        </div>
      )}
      {!current.length && <div className="alert alert-info mb">مقصدی انتخاب نشده است؛ به تماس‌گیرنده پیام «سرویس در دسترس نیست» پخش می‌شود.</div>}
      <div className="row gap-sm">
        <Field label="مدت زنگ (ثانیه)" hint="۱۰ تا ۱۲۰">
          <input
            className="input mono"
            type="number"
            min={10}
            max={120}
            value={seconds}
            onChange={(e) => (setSaved(false), setRing(Number(e.target.value)))}
            style={{ maxWidth: 120 }}
          />
        </Field>
      </div>
      <div className="row gap-sm">
        <Button onClick={save} busy={act.busy} disabled={targets === null && ring === null}>
          ذخیره
        </Button>
        {saved && <span className="small text-success">ذخیره شد و به مرکز تلفن اعمال می‌شود.</span>}
      </div>
    </Card>
  );
}
