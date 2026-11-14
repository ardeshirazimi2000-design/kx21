import { useEffect, useRef, useState } from 'react';
import { Button, Card, ErrorBox, Field, Loading, PageHeader } from '../components/ui';
import { del, put, upload } from '../lib/api';
import { useAction } from '../lib/hooks';
import { setOrgProfile, useOrgProfile, type OrgProfile } from '../lib/org';

/** «مشخصات سازمان»: the name and logo shown on the login page, the letter verification page and the letterheads. */
export function OrgProfilePage() {
  const org = useOrgProfile();
  const [name, setName] = useState('');
  const [shortName, setShortName] = useState('');
  const [saved, setSaved] = useState(false);
  const act = useAction();
  const logoInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!org) return;
    setName(org.name);
    setShortName(org.shortName ?? '');
  }, [org]);
  if (!org) return <Loading />;

  const done = (p: OrgProfile) => {
    setOrgProfile(p);
    setSaved(true);
  };
  const save = () => act.run(async () => done(await put<OrgProfile>('/org-profile', { name, shortName: shortName || null })));
  const setLogo = (file?: File | null) => file && act.run(async () => done(await upload<OrgProfile>('/org-profile/logo', {}, file)));
  const removeLogo = () => act.run(async () => done(await del<OrgProfile>('/org-profile/logo')));

  return (
    <>
      <PageHeader title="مشخصات سازمان" subtitle="نام و لوگوی سازمان در صفحه ورود، صفحه صحت‌سنجی نامه و سربرگ‌هایی که نام سازمان در آن‌ها خالی است نمایش داده می‌شود." />
      <ErrorBox error={act.error} />
      {saved && !act.error && <div className="alert alert-success">ذخیره شد.</div>}
      <div className="grid grid-2">
        <Card title="نام سازمان">
          <Field label="نام کامل سازمان">
            <input className="input" value={name} maxLength={300} onChange={(e) => (setName(e.target.value), setSaved(false))} placeholder="مثلاً: شرکت توسعه فناوری نمونه" />
          </Field>
          <Field label="نام کوتاه (اختیاری)">
            <input className="input" value={shortName} maxLength={100} onChange={(e) => (setShortName(e.target.value), setSaved(false))} />
          </Field>
          <Button busy={act.busy} onClick={save}>
            ذخیره
          </Button>
        </Card>
        <Card title="لوگو">
          <div className="org-logo-preview">
            {org.logoUrl ? <img src={org.logoUrl} className={org.hasLogo ? undefined : 'org-logo-builtin'} alt="" /> : <span className="muted small">لوگویی ثبت نشده است</span>}
          </div>
          <p className="small muted">PNG یا JPG، حداکثر ۲ مگابایت. لوگوی اختصاصی هر قالب نامه بر این لوگو مقدم است.</p>
          <input ref={logoInput} type="file" accept="image/png,image/jpeg" hidden onChange={(e) => (void setLogo(e.target.files?.[0]), (e.target.value = ''))} />
          <div className="row gap">
            <Button variant="secondary" busy={act.busy} onClick={() => logoInput.current?.click()}>
              {org.logoUrl ? 'تعویض لوگو' : 'بارگذاری لوگو'}
            </Button>
            {org.logoUrl && (
              <Button variant="ghost" busy={act.busy} onClick={removeLogo}>
                حذف لوگو
              </Button>
            )}
          </div>
        </Card>
      </div>
    </>
  );
}
