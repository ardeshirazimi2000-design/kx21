import { useState } from 'react';
import { Icon } from '../components/icons';
import { Button, ErrorBox, Field } from '../components/ui';
import { useAuth } from '../lib/auth';

export function LoginPage() {
  const { login, verifyMfa } = useAuth();
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [mfaToken, setMfaToken] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState<Error | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (mfaToken) await verifyMfa(mfaToken, code);
      else {
        const r = await login(identifier, password);
        if (r.mfaToken) setMfaToken(r.mfaToken);
      }
    } catch (err) {
      setError(err as Error);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login">
      <aside className="login-side">
        <div className="login-brand">
          <span className="brand-tile brand-tile-lg">
            <img src="/rasa-mark.png" width={64} height={64} alt="" />
          </span>
          <div>
            <h1>رسا</h1>
            <p>سامانه هوشمند اتوماسیون و مدیریت سازمانی</p>
          </div>
        </div>
        <div className="login-pitch">
          <h2>هر فرایند، روشن؛ هر تصمیم، به‌موقع.</h2>
          <ul>
            <li>
              <Icon name="mail" /> ثبت، ارجاع و پیگیری نامه‌های وارده، صادره و داخلی
            </li>
            <li>
              <Icon name="signature" /> امضای الکترونیک و چاپ روی سربرگ رسمی
            </li>
            <li>
              <Icon name="resolution" /> پیگیری اجرای مصوبات کمیسیون‌های تخصصی
            </li>
            <li>
              <Icon name="shield" /> ورود امن با تأیید دومرحله‌ای
            </li>
          </ul>
        </div>
        <small>© اتاق بازرگانی، صنایع، معادن و کشاورزی ایران</small>
      </aside>
      <main className="login-main">
        <form className="login-form" onSubmit={submit}>
          <div className="login-mobile-brand">
            <img src="/rasa-logo.png" width={200} height={219} alt="رسا — سامانه هوشمند اتوماسیون و مدیریت سازمانی" />
          </div>
          <h2>{mfaToken ? 'تأیید دومرحله‌ای' : 'ورود به سامانه'}</h2>
          <p className="muted">{mfaToken ? 'کد برنامه Authenticator خود را وارد کنید.' : 'با حساب کاربری سازمانی خود وارد شوید.'}</p>
          <ErrorBox error={error} />
          {!mfaToken ? (
            <>
              <Field label="نام کاربری، ایمیل یا موبایل">
                <input className="input ltr" autoComplete="username" value={identifier} onChange={(e) => setIdentifier(e.target.value)} required />
              </Field>
              <Field label="رمز عبور">
                <input
                  className="input ltr"
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                />
              </Field>
            </>
          ) : (
            <Field label="کد تأیید دومرحله‌ای" hint="کد ۶ رقمی برنامه Authenticator را وارد کنید">
              <input
                className="input ltr"
                inputMode="numeric"
                autoFocus
                maxLength={6}
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
              />
            </Field>
          )}
          <Button type="submit" busy={busy} className="btn-lg" style={{ width: '100%', justifyContent: 'center' }}>
            {mfaToken ? 'تأیید' : 'ورود'}
          </Button>
        </form>
      </main>
    </div>
  );
}
