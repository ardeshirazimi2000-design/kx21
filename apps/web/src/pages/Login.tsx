import { useState } from 'react';
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
      <div className="login-brand">
        <img src="/iran-chamber-logo.png" width={96} height={96} alt="لوگوی اتاق ایران" />
        <h1>اتاق بازرگانی، صنایع، معادن و کشاورزی ایران</h1>
        <p>سامانه کمیسیون‌های تخصصی</p>
      </div>
      <form className="card" onSubmit={submit}>
        <ErrorBox error={error} />
        {!mfaToken ? (
          <>
            <Field label="ایمیل یا شماره موبایل">
              <input className="input ltr" autoComplete="username" value={identifier} onChange={(e) => setIdentifier(e.target.value)} required />
            </Field>
            <Field label="رمز عبور">
              <input className="input ltr" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
            </Field>
          </>
        ) : (
          <Field label="کد تأیید دومرحله‌ای" hint="کد ۶ رقمی برنامه Authenticator را وارد کنید">
            <input className="input ltr" inputMode="numeric" autoFocus maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} />
          </Field>
        )}
        <Button type="submit" busy={busy} className="btn-lg" style={{ width: '100%', justifyContent: 'center' }}>
          {mfaToken ? 'تأیید' : 'ورود'}
        </Button>
      </form>
    </div>
  );
}
