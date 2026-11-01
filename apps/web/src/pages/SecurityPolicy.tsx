import { useEffect, useState } from 'react';
import { Button, Card, ErrorBox, Field, fa, Loading, PageHeader } from '../components/ui';
import { put } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useApi } from '../lib/hooks';

type Policy = {
  password: { minLength: number; requireLower: boolean; requireUpper: boolean; requireDigit: boolean; requireSymbol: boolean };
  lockout: { maxFailures: number; lockMinutes: number; captchaAfter: number };
  session: { maxConcurrent: number; webIdleMinutes: number; mobileIdleDays: number };
};

/**
 * The security policy of the whole system (AFTA requirements), changed by the IT administrator only: password
 * rules, temporary lockout and CAPTCHA after failed sign-ins, and session limits.
 */
export function SecurityPolicyPage() {
  // The security auditor reviews the settings without changing them.
  const readOnly = !useAuth().me?.is_super_admin;
  const { data, error, reload } = useApi<{ policy: Policy; defaults: Policy; limits: Record<string, [number, number]> }>('/security-policy');
  const [form, setForm] = useState<Policy | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<Error | null>(null);
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    if (data) setForm(data.policy);
  }, [data]);
  if (error) return <ErrorBox error={error} />;
  if (!data || !form) return <Loading />;
  const L = data.limits;
  const num = <G extends keyof Policy>(group: G, key: keyof Policy[G] & string, label: string, unit: string, hint?: string) => (
    <Field label={label} hint={`${hint ? `${hint} — ` : ''}بین ${fa(L[key][0])} و ${fa(L[key][1])} ${unit}`}>
      <input
        className="input ltr"
        type="number"
        min={L[key][0]}
        max={L[key][1]}
        value={form[group][key] as number}
        onChange={(e) => setForm({ ...form, [group]: { ...form[group], [key]: Number(e.target.value) } })}
      />
    </Field>
  );
  const check = (key: keyof Policy['password'] & string, label: string) => (
    <label className="check">
      <input type="checkbox" checked={form.password[key] as boolean} onChange={(e) => setForm({ ...form, password: { ...form.password, [key]: e.target.checked } })} /> {label}
    </label>
  );
  const save = async () => {
    setBusy(true);
    setErr(null);
    setSaved(false);
    try {
      const r = await put<{ policy: Policy }>('/security-policy', form);
      setForm(r.policy);
      setSaved(true);
      void reload();
    } catch (e) {
      setErr(e as Error);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <PageHeader
        title="تنظیمات امنیتی"
        subtitle="سیاست رمز عبور، قفل حساب و نشست‌ها برای همهٔ کاربران سامانه؛ هر تغییر در رویدادنگاری ثبت می‌شود"
        actions={
          !readOnly && (
          <>
            <Button variant="ghost" onClick={() => setForm(data.defaults)}>
              مقادیر پیشنهادی
            </Button>
            <Button busy={busy} onClick={() => void save()}>
              ذخیره
            </Button>
          </>
          )
        }
      />
      {readOnly && <div className="alert alert-info">نمایش برای ممیز امنیت؛ تغییر تنظیمات با مدیر فناوری اطلاعات سامانه است.</div>}
      <ErrorBox error={err} />
      {saved && <div className="alert alert-success">تنظیمات امنیتی ذخیره شد و از همین حالا اعمال می‌شود.</div>}
      <fieldset disabled={readOnly} className="grid grid-2" style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
        <Card title="رمز عبور">
          {num('password', 'minLength', 'حداقل طول', 'نویسه')}
          {check('requireUpper', 'حرف بزرگ لاتین (A-Z) لازم است')}
          {check('requireLower', 'حرف کوچک لاتین (a-z) لازم است')}
          {check('requireDigit', 'عدد لازم است')}
          {check('requireSymbol', 'نویسهٔ خاص (مثل ! @ # $) لازم است')}
          <p className="muted small">این قواعد برای رمزهای جدید و تغییر رمز اعمال می‌شود؛ رمزهای فعلی تا تغییر بعدی معتبر می‌مانند.</p>
        </Card>
        <Card title="ورود ناموفق">
          {num('lockout', 'captchaAfter', 'کد امنیتی (CAPTCHA) پس از', 'تلاش ناموفق', 'برای همان حساب یا از همان نشانی')}
          {num('lockout', 'maxFailures', 'قفل موقت حساب پس از', 'تلاش ناموفق پیاپی')}
          {num('lockout', 'lockMinutes', 'مدت قفل', 'دقیقه', 'پس از آن خودکار باز می‌شود')}
        </Card>
        <Card title="نشست‌ها">
          {num('session', 'maxConcurrent', 'حداکثر نشست هم‌زمان هر کاربر', 'نشست', 'ورود تازه، قدیمی‌ترین نشست را می‌بندد')}
          {num('session', 'webIdleMinutes', 'بستن نشست وب پس از بی‌کاری', 'دقیقه')}
          {num('session', 'mobileIdleDays', 'بستن نشست برنامهٔ موبایل پس از بی‌کاری', 'روز')}
        </Card>
      </fieldset>
    </>
  );
}
