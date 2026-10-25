import { useState, type ReactNode } from 'react';
import { ErrorBox, Modal } from '../components/ui';
import { setRememberMe } from '../lib/api';
import { useAuth } from '../lib/auth';

/** Support line shown under the login form. */
const SUPPORT_PHONE = '۰۹۱۸ ۱۷۱ ۱۵۹۸';
const SUPPORT_TEL = '09181711598';

const Icon = ({ d, size = 20 }: { d: string; size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d={d} />
  </svg>
);
const USER = 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0';
const LOCK = 'M6 11h12v10H6zM8 11V7a4 4 0 0 1 8 0v4M12 15v2';
const ENTER = 'M10 17l5-5-5-5M15 12H3M14 3h5a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-5';
const KEY = 'M15 7a4 4 0 1 1-3.9 4.9L4 19v2h3v-2h2v-2h2l1.1-1.1A4 4 0 0 1 15 7zM16 9h.01';
const SHIELD = 'M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6zM8.5 12l2.5 2.5 4.5-5';
const PEOPLE = 'M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM2 20a7 7 0 0 1 14 0M16 4.5a3.5 3.5 0 0 1 0 6.5M19 20a7 7 0 0 0-3-5.7';
const CHART = 'M3 17l5-5 4 4 8-8M15 8h5v5';
const PHONE = 'M4 14v-2a8 8 0 0 1 16 0v2M4 14a2 2 0 0 0 2 2h1v-5H6a2 2 0 0 0-2 2zM20 14a2 2 0 0 1-2 2h-1v-5h1a2 2 0 0 1 2 2zM18 16v1a3 3 0 0 1-3 3h-2';
const INFO = 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 11v5M12 8h.01';

function Feature({ icon, title, sub }: { icon: string; title: string; sub: string }) {
  return (
    <div className="lg-feature">
      <span className="lg-feature-icon">
        <Icon d={icon} size={34} />
      </span>
      <strong>{title}</strong>
      <span>{sub}</span>
    </div>
  );
}

function InputWithIcon({ icon, children }: { icon: string; children: ReactNode }) {
  return (
    <label className="lg-input">
      <span className="lg-input-icon">
        <Icon d={icon} />
      </span>
      {children}
    </label>
  );
}

export function LoginPage() {
  const { login, verifyMfa } = useAuth();
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(true);
  const [mfaToken, setMfaToken] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState<Error | null>(null);
  const [busy, setBusy] = useState(false);
  const [help, setHelp] = useState<null | 'forgot' | 'guide'>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setRememberMe(remember);
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
    <div className="lg">
      <main className="lg-form-side">
        <div className="lg-mobile-brand">
          <img src="/iran-chamber-logo.png" width={64} height={64} alt="لوگوی اتاق ایران" />
          <div>
            <div className="lg-hero-name">اتاق بازرگانی، صنایع، معادن و کشاورزی ایران</div>
            <div className="lg-mobile-sub">پلتفرم کمیسیون‌های تخصصی</div>
          </div>
        </div>
        <form className="lg-card" onSubmit={submit}>
          <div className="lg-card-body">
            <h1>ورود به سامانه</h1>
            <p className="lg-lead">برای دسترسی به پلتفرم کمیسیون‌های تخصصی وارد حساب کاربری خود شوید.</p>
            <ErrorBox error={error} />
            {!mfaToken ? (
              <>
                <InputWithIcon icon={USER}>
                  <input
                    aria-label="نام کاربری"
                    placeholder="نام کاربری (ایمیل یا شماره موبایل)"
                    autoComplete="username"
                    value={identifier}
                    onChange={(e) => setIdentifier(e.target.value)}
                    required
                  />
                </InputWithIcon>
                <InputWithIcon icon={LOCK}>
                  <input aria-label="رمز عبور" placeholder="رمز عبور" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
                </InputWithIcon>
                <label className="lg-remember">
                  <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
                  مرا به خاطر بسپار
                </label>
              </>
            ) : (
              <>
                <p className="lg-lead">کد ۶ رقمی برنامهٔ Authenticator را وارد کنید.</p>
                <InputWithIcon icon={KEY}>
                  <input aria-label="کد تأیید دومرحله‌ای" placeholder="کد تأیید دومرحله‌ای" inputMode="numeric" autoFocus maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} />
                </InputWithIcon>
              </>
            )}
            <button type="submit" className="lg-submit" disabled={busy}>
              {busy ? 'در حال ورود…' : mfaToken ? 'تأیید' : 'ورود'}
              {!busy && <Icon d={ENTER} />}
            </button>
            {!mfaToken && (
              <button type="button" className="lg-link" onClick={() => setHelp('forgot')}>
                <Icon d={KEY} size={18} />
                رمز عبور خود را فراموش کرده‌اید؟
              </button>
            )}
          </div>
          <footer className="lg-card-foot">
            <button type="button" className="lg-foot-item lg-link" onClick={() => setHelp('guide')}>
              <Icon d={INFO} />
              راهنمای ورود
            </button>
            <span className="lg-foot-sep" />
            <a className="lg-foot-item" href={`tel:${SUPPORT_TEL}`}>
              <Icon d={PHONE} />
              <span>
                <small>پشتیبانی سامانه</small>
                <span className="lg-phone">{SUPPORT_PHONE}</span>
              </span>
            </a>
          </footer>
        </form>
      </main>

      <aside className="lg-hero">
        <div className="lg-hero-brand">
          <img src="/iran-chamber-logo.png" width={92} height={92} alt="لوگوی اتاق ایران" />
          <div>
            <div className="lg-hero-name">اتاق بازرگانی، صنایع، معادن و کشاورزی ایران</div>
            <div className="lg-hero-en">Iran Chamber of Commerce, Industries, Mines and Agriculture</div>
          </div>
        </div>
        <div className="lg-hero-text">
          <h2>پلتفرم کمیسیون‌های تخصصی</h2>
          <h3>اتاق بازرگانی، صنایع، معادن و کشاورزی ایران</h3>
          <span className="lg-hero-rule" />
          <p>
            هم‌افزایی بخش خصوصی،
            <br />
            برای توسعه اقتصادی کشور
          </p>
        </div>
        <div className="lg-features">
          <Feature icon={CHART} title="مدیریت هوشمند" sub="فرآیندهای کمیسیون‌ها" />
          <Feature icon={PEOPLE} title="ارتباط حرفه‌ای" sub="با اعضا و فعالان اقتصادی" />
          <Feature icon={SHIELD} title="امنیت بالا" sub="در دسترس و مطمئن" />
        </div>
      </aside>

      {help === 'forgot' && (
        <Modal title="بازیابی رمز عبور" onClose={() => setHelp(null)}>
          <p style={{ marginTop: 0 }}>رمز عبور هر کاربر را مدیر اتاق مربوط تعریف می‌کند. برای دریافت رمز جدید:</p>
          <ul>
            <li>اعضا، دبیران و رؤسای کمیسیون‌ها: با دبیرخانهٔ اتاق خود یا مدیر اتاق تماس بگیرید.</li>
            <li>مدیران اتاق‌ها: با پشتیبانی سامانه (<span className="lg-phone">{SUPPORT_PHONE}</span>) تماس بگیرید.</li>
          </ul>
          <p className="muted small" style={{ marginBottom: 0 }}>
            پس از ورود با رمز جدید، آن را از «پروفایل و امنیت» به رمز دلخواه خود تغییر دهید.
          </p>
        </Modal>
      )}
      {help === 'guide' && (
        <Modal title="راهنمای ورود" onClose={() => setHelp(null)}>
          <ol style={{ marginTop: 0, paddingInlineStart: 20, lineHeight: 2 }}>
            <li>در «نام کاربری»، ایمیل یا شماره موبایلی را بنویسید که در سامانه برایتان ثبت شده است.</li>
            <li>رمز عبوری را که مدیر اتاق به شما داده وارد کنید و «ورود» را بزنید.</li>
            <li>اگر ورود دومرحله‌ای را فعال کرده‌اید، کد ۶ رقمی برنامهٔ Authenticator را وارد کنید.</li>
            <li>روی رایانهٔ مشترک، «مرا به خاطر بسپار» را بردارید تا با بستن مرورگر از حساب خارج شوید.</li>
            <li>برنامهٔ اندروید سامانه را هم می‌توانید از مدیر اتاق بگیرید و با همین نام کاربری وارد شوید.</li>
          </ol>
        </Modal>
      )}
    </div>
  );
}
