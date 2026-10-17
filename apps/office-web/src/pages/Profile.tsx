import { useState } from 'react';
import { CONFIDENTIALITY } from '../components/labels';
import { SignatureEditor } from '../components/signature';
import { Badge, Button, Card, ErrorBox, Field, PageHeader } from '../components/ui';
import { post } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useAction } from '../lib/hooks';

export function ProfilePage({ forceMfa }: { forceMfa?: boolean }) {
  const { me, refreshMe } = useAuth();
  const [pw, setPw] = useState({ currentPassword: '', newPassword: '', repeat: '' });
  const [setup, setSetup] = useState<{ secret: string; otpauthUrl: string; qrSvg: string } | null>(null);
  const [code, setCode] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const act = useAction();
  return (
    <>
      <PageHeader title="حساب کاربری" subtitle={me!.full_name} />
      {forceMfa && <div className="alert alert-warning">برای نقش شما فعال‌سازی ورود دومرحله‌ای الزامی است. پیش از ادامه کار، آن را فعال کنید.</div>}
      <ErrorBox error={act.error} />
      {msg && <div className="alert alert-success">{msg}</div>}
      <div className="grid grid-2">
        <Card title="مشخصات">
          <dl className="kv">
            <dt>نام کاربری</dt>
            <dd className="mono">{me!.username}</dd>
            <dt>ایمیل</dt>
            <dd className="mono">{me!.email ?? '—'}</dd>
            <dt>موبایل</dt>
            <dd className="mono">{me!.mobile ?? '—'}</dd>
            <dt>سمت‌ها</dt>
            <dd>{me!.positions.map((p) => `${p.title} — ${p.unitName}`).join('، ') || '—'}</dd>
            <dt>نقش‌ها</dt>
            <dd>{me!.roles.join('، ')}</dd>
            <dt>سطح دسترسی</dt>
            <dd>{CONFIDENTIALITY[me!.clearance]}</dd>
          </dl>
        </Card>
        <Card title={<span className="row gap-sm">ورود دومرحله‌ای {me!.mfa_enabled ? <Badge tone="success">فعال</Badge> : <Badge>غیرفعال</Badge>}</span>}>
          {!setup ? (
            <>
              <p className="muted">با برنامه‌هایی مانند Google Authenticator یا Microsoft Authenticator، هنگام ورود یک کد ۶ رقمی هم خواسته می‌شود.</p>
              <Button busy={act.busy} onClick={() => act.run(async () => setSetup(await post('/auth/mfa/setup')))}>
                {me!.mfa_enabled ? 'تنظیم دوباره' : 'فعال‌سازی'}
              </Button>
            </>
          ) : (
            <>
              <p>کد QR زیر را با برنامه Authenticator اسکن کنید و کد ۶ رقمی را وارد کنید.</p>
              <div style={{ width: 180, background: '#fff' }} dangerouslySetInnerHTML={{ __html: setup.qrSvg }} />
              <p className="small muted">
                یا کلید را دستی وارد کنید: <span className="mono">{setup.secret}</span>
              </p>
              <Field label="کد تأیید">
                <input className="input ltr" inputMode="numeric" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} />
              </Field>
              <Button
                busy={act.busy}
                disabled={code.length !== 6}
                onClick={() =>
                  act.run(async () => {
                    await post('/auth/mfa/enable', { code });
                    setSetup(null);
                    setCode('');
                    setMsg('ورود دومرحله‌ای فعال شد.');
                    await refreshMe();
                  })
                }
              >
                تأیید و فعال‌سازی
              </Button>
            </>
          )}
        </Card>
      </div>
      {!forceMfa && (
        <Card title="نمونه امضای من" className="mt">
          <SignatureEditor userId={me!.id} hasSignature={me!.has_signature} onChange={() => void refreshMe()} />
        </Card>
      )}
      {!forceMfa && (
        <Card title="تغییر رمز عبور" className="mt">
          <div className="grid grid-3">
            <Field label="رمز فعلی">
              <input className="input ltr" type="password" autoComplete="current-password" value={pw.currentPassword} onChange={(e) => setPw({ ...pw, currentPassword: e.target.value })} />
            </Field>
            <Field label="رمز جدید" hint="حداقل ۸ نویسه شامل حرف و عدد">
              <input className="input ltr" type="password" autoComplete="new-password" value={pw.newPassword} onChange={(e) => setPw({ ...pw, newPassword: e.target.value })} />
            </Field>
            <Field label="تکرار رمز جدید" error={pw.repeat && pw.repeat !== pw.newPassword ? 'تکرار رمز یکسان نیست' : undefined}>
              <input className="input ltr" type="password" autoComplete="new-password" value={pw.repeat} onChange={(e) => setPw({ ...pw, repeat: e.target.value })} />
            </Field>
          </div>
          <Button
            busy={act.busy}
            disabled={!pw.currentPassword || !pw.newPassword || pw.newPassword !== pw.repeat}
            onClick={() =>
              act.run(async () => {
                await post('/auth/password', { currentPassword: pw.currentPassword, newPassword: pw.newPassword });
                setMsg('رمز عبور تغییر کرد؛ لطفاً دوباره وارد شوید.');
                setPw({ currentPassword: '', newPassword: '', repeat: '' });
              })
            }
          >
            تغییر رمز
          </Button>
        </Card>
      )}
    </>
  );
}
