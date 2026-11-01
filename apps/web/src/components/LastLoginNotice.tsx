import { useState } from 'react';
import { Link } from 'react-router-dom';
import { dateTimeFa, fa } from './ui';

interface Info {
  lastLogin: { at: string; ip: string | null; failedSince: number; lastFailedAt: string | null } | null;
  endedSessions: number;
}

const KEY = 'kx.lastLogin';

/**
 * Shown once after signing in (AFTA: the last successful sign-in and the failed attempts since): a warning when
 * someone else may have tried the password, and when signing in ended an older session.
 */
export function LastLoginNotice() {
  const [info, setInfo] = useState<Info | null>(() => {
    try {
      const raw = sessionStorage.getItem(KEY);
      return raw ? (JSON.parse(raw) as Info) : null;
    } catch {
      return null;
    }
  });
  if (!info || (!info.lastLogin && !info.endedSessions)) return null;
  const close = () => {
    try {
      sessionStorage.removeItem(KEY);
    } catch {
      /* storage unavailable */
    }
    setInfo(null);
  };
  const failed = info.lastLogin?.failedSince ?? 0;
  return (
    <div className={`alert ${failed ? 'alert-warning' : 'alert-info'} row between wrap gap-sm`} role="status">
      <div>
        {info.lastLogin && (
          <div>
            آخرین ورود موفق شما: {dateTimeFa(info.lastLogin.at)}
            {info.lastLogin.ip ? <> از نشانی <span className="ltr">{info.lastLogin.ip.replace(/^::ffff:/, '')}</span></> : null}
          </div>
        )}
        {failed > 0 && (
          <div>
            از آن زمان {fa(failed)} تلاش ناموفق برای ورود به حساب شما ثبت شده است
            {info.lastLogin?.lastFailedAt ? `، آخرین آن ${dateTimeFa(info.lastLogin.lastFailedAt)}` : ''}. اگر کار شما نبوده،{' '}
            <Link to="/profile">رمز عبور را عوض کنید</Link>.
          </div>
        )}
        {info.endedSessions > 0 && <div>با این ورود، {fa(info.endedSessions)} نشست قدیمی‌تر شما (در دستگاه دیگر) بسته شد.</div>}
      </div>
      <button className="btn btn-ghost btn-sm" onClick={close}>
        بستن
      </button>
    </div>
  );
}
