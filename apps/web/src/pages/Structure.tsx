import { TERM_STATUS_LABELS, type TermStatus } from '@kx/shared';
import { useState } from 'react';
import { del, patch, post } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useApi } from '../lib/hooks';
import { Badge, Button, Card, dateFa, Empty, ErrorBox, Field, fa, JalaliDateInput, Loading, Modal, PageHeader, Pager } from '../components/ui';

/** Chambers (super admin): each provincial chamber has its own admins, terms and commissions. */
export function ChambersPage() {
  const { me, setChamberId } = useAuth();
  const { data, reload, loading } = useApi<any[]>('/chambers');
  const [open, setOpen] = useState(false);
  const [adminFor, setAdminFor] = useState<any | null>(null);
  const [form, setForm] = useState({ name: '', province: '', phone: '', email: '', address: '' });
  const [err, setErr] = useState<Error | null>(null);
  const save = async () => {
    try {
      await post('/chambers', { ...form, email: form.email || null });
      setOpen(false);
      void reload();
    } catch (e) {
      setErr(e as Error);
    }
  };
  const removeAdmin = async (chamberId: string, a: any) => {
    if (!confirm(`دسترسی مدیریت «${a.full_name}» از این اتاق حذف شود؟`)) return;
    await del(`/chambers/${chamberId}/admins/${a.id}`);
    void reload();
  };
  return (
    <>
      <PageHeader
        title="اتاق‌ها"
        subtitle="هر اتاق استانی دوره‌ها، کمیسیون‌ها، اعضا و جلسات مستقل خود را دارد و مدیر آن فقط به اتاق خودش دسترسی دارد."
        actions={me!.is_super_admin && <Button onClick={() => setOpen(true)}>اتاق جدید</Button>}
      />
      <Card>
        {loading && !data ? (
          <Loading />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>نام</th>
                  <th>استان</th>
                  <th>کمیسیون‌های دوره جاری</th>
                  <th>مدیران اتاق</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {data?.map((c) => (
                  <tr key={c.id}>
                    <td>{c.name}</td>
                    <td>{c.province}</td>
                    <td>{fa(c.commission_count)}</td>
                    <td>
                      {(c.admins ?? []).length === 0 && <Badge tone="warning">تعیین نشده</Badge>}
                      {(c.admins ?? []).map((a: any) => (
                        <div key={a.id} className="row gap-sm">
                          <span>{a.full_name}</span>
                          <span className="muted small ltr">{a.email ?? a.mobile}</span>
                          {me!.is_super_admin && (
                            <button className="btn btn-ghost btn-sm" onClick={() => removeAdmin(c.id, a)}>
                              حذف
                            </button>
                          )}
                        </div>
                      ))}
                    </td>
                    <td className="row gap-sm">
                      {me!.is_super_admin && (
                        <Button size="sm" variant="secondary" onClick={() => setAdminFor(c)}>
                          تعیین مدیر اتاق
                        </Button>
                      )}
                      <Button size="sm" variant="ghost" onClick={() => setChamberId(c.id)}>
                        مدیریت این اتاق
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {open && (
        <Modal title="اتاق جدید" onClose={() => setOpen(false)} footer={<Button onClick={save}>ذخیره</Button>}>
          <ErrorBox error={err} />
          {(['name', 'province', 'phone', 'email', 'address'] as const).map((k) => (
            <Field key={k} label={{ name: 'نام اتاق', province: 'استان', phone: 'تلفن', email: 'ایمیل', address: 'نشانی' }[k]}>
              <input className="input" value={form[k]} onChange={(e) => setForm({ ...form, [k]: e.target.value })} />
            </Field>
          ))}
          <p className="muted small">پس از ایجاد، با «تعیین مدیر اتاق» مدیر استانی را مشخص کنید تا دوره‌ها و کمیسیون‌های این اتاق را تعریف کند.</p>
        </Modal>
      )}
      {adminFor && <ChamberAdminModal chamber={adminFor} onClose={() => setAdminFor(null)} onSaved={() => { setAdminFor(null); void reload(); }} />}
    </>
  );
}

function ChamberAdminModal({ chamber, onClose, onSaved }: { chamber: any; onClose: () => void; onSaved: () => void }) {
  const [mode, setMode] = useState<'new' | 'existing'>('new');
  const [form, setForm] = useState({ mobile: '', email: '', password: '' });
  const [identity, setIdentity] = useState<any | null>(null);
  const [manual, setManual] = useState(false);
  const [fullName, setFullName] = useState('');
  const [q, setQ] = useState('');
  const [userId, setUserId] = useState<string | null>(null);
  const people = useApi(mode === 'existing' && q.length >= 2 ? `/people?chamberId=${chamber.id}&q=${encodeURIComponent(q)}&pageSize=8` : null);
  const [err, setErr] = useState<Error | null>(null);
  const save = async () => {
    try {
      if (mode === 'existing') await post(`/chambers/${chamber.id}/admins`, { userId });
      else
        await post(`/chambers/${chamber.id}/admins`, {
          person: manual
            ? { fullName, mobile: form.mobile || null, email: form.email || null, password: form.password }
            : { nationalId: identity?.nationalCode, birthDate: identity?.birthDate, mobile: form.mobile || null, email: form.email || null, password: form.password },
        });
      onSaved();
    } catch (e) {
      setErr(e as Error);
    }
  };
  return (
    <Modal title={`تعیین مدیر — ${chamber.name}`} onClose={onClose} footer={<Button disabled={mode === 'existing' ? !userId : manual ? fullName.length < 2 : !identity} onClick={save}>ثبت</Button>}>
      <ErrorBox error={err} />
      <div className="row gap-sm mb">
        <Button size="sm" variant={mode === 'new' ? 'primary' : 'secondary'} onClick={() => setMode('new')}>
          شخص جدید
        </Button>
        <Button size="sm" variant={mode === 'existing' ? 'primary' : 'secondary'} onClick={() => setMode('existing')}>
          از اشخاص همین اتاق
        </Button>
      </div>
      {mode === 'new' ? (
        <>
          {!manual ? (
            <>
              <IdentityLookup chamberId={chamber.id} onResult={setIdentity} />
              <button className="btn btn-ghost btn-sm mb" onClick={() => setManual(true)}>
                ثبت دستی بدون استعلام
              </button>
            </>
          ) : (
            <Field label="نام و نام خانوادگی">
              <input className="input" value={fullName} onChange={(e) => setFullName(e.target.value)} />
            </Field>
          )}
          <div className="grid grid-2">
            <Field label="ایمیل (نام کاربری)">
              <input className="input ltr" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
            </Field>
            <Field label="موبایل">
              <input className="input ltr" placeholder="09xxxxxxxxx" value={form.mobile} onChange={(e) => setForm({ ...form, mobile: e.target.value })} />
            </Field>
          </div>
          <Field label="رمز عبور اولیه" hint="حداقل ۸ کاراکتر؛ مدیر پس از ورود از «پروفایل» آن را تغییر دهد">
            <input className="input ltr" type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
          </Field>
        </>
      ) : (
        <>
          <Field label="جستجوی شخص">
            <input className="input" value={q} onChange={(e) => { setQ(e.target.value); setUserId(null); }} />
          </Field>
          <ul className="list">
            {people.data?.items.map((p: any) => (
              <li key={p.id}>
                <label className="check" style={{ margin: 0 }}>
                  <input type="radio" checked={userId === p.id} onChange={() => setUserId(p.id)} /> {p.full_name}
                  {!p.can_login && <span className="muted small"> (رمز عبور ندارد)</span>}
                </label>
              </li>
            ))}
          </ul>
        </>
      )}
    </Modal>
  );
}

/** Terms (دوره‌ها) */
export function TermsPage() {
  const { chamberId } = useAuth();
  const { data, reload } = useApi<any[]>(chamberId ? `/terms?chamberId=${chamberId}` : null);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ number: '', title: '', startDate: '', endDate: '', status: 'planned' });
  const [err, setErr] = useState<Error | null>(null);
  const save = async () => {
    try {
      await post('/terms', { chamberId, number: Number(form.number), title: form.title, startDate: form.startDate, endDate: form.endDate || null, status: form.status });
      setOpen(false);
      void reload();
    } catch (e) {
      setErr(e as Error);
    }
  };
  const activate = async (id: string) => {
    if (!confirm('با فعال‌سازی این دوره، دوره فعال قبلی بسته و عضویت‌های آن (با حفظ سابقه) پایان می‌یابد. ادامه می‌دهید؟')) return;
    await patch(`/terms/${id}`, { status: 'active' });
    void reload();
  };
  return (
    <>
      <PageHeader title="دوره‌ها" subtitle="هر دوره، کمیسیون‌ها و عضویت‌های خود را دارد؛ سوابق دوره‌های قبل حفظ می‌شود." actions={<Button onClick={() => setOpen(true)}>دوره جدید</Button>} />
      <Card>
        <table className="table">
          <thead>
            <tr>
              <th>شماره</th>
              <th>عنوان</th>
              <th>شروع</th>
              <th>پایان</th>
              <th>وضعیت</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {data?.map((t) => (
              <tr key={t.id}>
                <td>{fa(t.number)}</td>
                <td>{t.title}</td>
                <td>{dateFa(t.start_date)}</td>
                <td>{dateFa(t.end_date)}</td>
                <td>
                  <Badge tone={t.status === 'active' ? 'success' : t.status === 'planned' ? 'info' : 'neutral'}>{TERM_STATUS_LABELS[t.status as TermStatus]}</Badge>
                </td>
                <td>
                  {t.status === 'planned' && (
                    <Button size="sm" variant="secondary" onClick={() => activate(t.id)}>
                      فعال‌سازی
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {data?.length === 0 && <Empty>دوره‌ای ثبت نشده است.</Empty>}
      </Card>
      {open && (
        <Modal title="دوره جدید" onClose={() => setOpen(false)} footer={<Button onClick={save}>ذخیره</Button>}>
          <ErrorBox error={err} />
          <div className="grid grid-2">
            <Field label="شماره دوره">
              <input className="input" type="number" value={form.number} onChange={(e) => setForm({ ...form, number: e.target.value })} />
            </Field>
            <Field label="عنوان">
              <input className="input" placeholder="دوره یازدهم" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
            </Field>
          </div>
          <Field label="تاریخ شروع">
            <JalaliDateInput value={form.startDate} onChange={(v) => setForm({ ...form, startDate: v })} />
          </Field>
          <Field label="تاریخ پایان (اختیاری)">
            <JalaliDateInput value={form.endDate} onChange={(v) => setForm({ ...form, endDate: v })} />
          </Field>
          <Field label="وضعیت">
            <select className="input" value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })}>
              <option value="planned">برنامه‌ریزی‌شده</option>
              <option value="active">فعال (دوره قبلی بسته می‌شود)</option>
            </select>
          </Field>
        </Modal>
      )}
    </>
  );
}

/** People */
export function PeoplePage() {
  const { chamberId, isAdmin } = useAuth();
  const [page, setPage] = useState(1);
  const [q, setQ] = useState('');
  const { data, reload } = useApi(chamberId ? `/people?chamberId=${chamberId}&page=${page}&q=${encodeURIComponent(q)}` : null);
  const [edit, setEdit] = useState<any | null>(null);
  return (
    <>
      <PageHeader title="اشخاص و کاربران" subtitle="اعضا، کارشناسان و مدعوین" actions={<Button onClick={() => setEdit({})}>شخص جدید</Button>} />
      <Card>
        <input className="input mb" placeholder="جستجو بر اساس نام، کد ملی، سازمان، موبایل یا ایمیل" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} />
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>نام</th>
                <th>سازمان</th>
                <th>موبایل</th>
                <th>ایمیل</th>
                <th>دسترسی</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data?.items.map((p: any) => (
                <tr key={p.id}>
                  <td>{p.full_name}</td>
                  <td>{p.organization}</td>
                  <td className="ltr">{p.mobile}</td>
                  <td className="ltr">{p.email}</td>
                  <td className="row gap-sm">
                    {!p.is_active && <Badge tone="danger">غیرفعال</Badge>}
                    {p.is_chamber_admin && <Badge tone="accent">مدیر اتاق</Badge>}
                    {p.identity_verified_at ? <Badge tone="success">هویت تأییدشده</Badge> : <Badge tone="warning">تأیید نشده</Badge>}
                    {p.can_login ? <Badge tone="info">ورود دارد</Badge> : <Badge>بدون حساب</Badge>}
                  </td>
                  <td>
                    {isAdmin && (
                      <Button size="sm" variant="ghost" onClick={() => setEdit(p)}>
                        ویرایش
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {data && <Pager page={page} pageSize={data.pageSize} total={data.total} onPage={setPage} />}
      </Card>
      {edit && <PersonModal person={edit} chamberId={chamberId!} canSetPassword={isAdmin} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); void reload(); }} />}
    </>
  );
}

/** National code + birth date → official name from the national registry (via the API). */
export function IdentityLookup({ chamberId, onResult }: { chamberId: string; onResult: (r: any | null) => void }) {
  const [nationalCode, setNationalCode] = useState('');
  const [birthDate, setBirthDate] = useState('');
  const [result, setResult] = useState<any | null>(null);
  const [err, setErr] = useState<Error | null>(null);
  const [busy, setBusy] = useState(false);
  const lookup = async () => {
    setBusy(true);
    setErr(null);
    try {
      const r = await post('/identity/inquiry', { chamberId, nationalCode, birthDate });
      setResult(r);
      onResult(r);
    } catch (e) {
      setResult(null);
      onResult(null);
      setErr(e as Error);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="card mb" style={{ background: 'var(--surface-2)' }}>
      <div className="grid grid-2">
        <Field label="کد ملی">
          <input className="input ltr" inputMode="numeric" maxLength={10} value={nationalCode} onChange={(e) => { setNationalCode(e.target.value); setResult(null); onResult(null); }} />
        </Field>
        <Field label="تاریخ تولد (شمسی)">
          <input className="input ltr" placeholder="1371/01/01" value={birthDate} onChange={(e) => { setBirthDate(e.target.value); setResult(null); onResult(null); }} />
        </Field>
      </div>
      <Button variant="secondary" busy={busy} disabled={nationalCode.length < 10 || birthDate.length < 8} onClick={lookup}>
        استعلام هویت
      </Button>
      <ErrorBox error={err} />
      {result && (
        <div className="alert alert-success mt">
          ✓ {result.fullName}
          {result.fatherName ? ` — نام پدر: ${result.fatherName}` : ''}
          {result.existingPerson && <div className="small">این شخص قبلاً با نام «{result.existingPerson.full_name}» در این اتاق ثبت شده است.</div>}
        </div>
      )}
    </div>
  );
}

export function PersonModal({ person, chamberId, canSetPassword, onClose, onSaved }: { person: any; chamberId: string; canSetPassword: boolean; onClose: () => void; onSaved: (p: any) => void }) {
  const [form, setForm] = useState({
    fullName: person.full_name ?? '',
    mobile: person.mobile ?? '',
    email: person.email ?? '',
    organization: person.organization ?? '',
    jobTitle: person.job_title ?? '',
    password: '',
    isActive: person.is_active ?? true,
  });
  const [identity, setIdentity] = useState<any | null>(null);
  const [manual, setManual] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [err, setErr] = useState<Error | null>(null);
  const save = async () => {
    const payload: any = {
      mobile: form.mobile || null,
      email: form.email || null,
      organization: form.organization || null,
      jobTitle: form.jobTitle || null,
    };
    if (form.password) payload.password = form.password;
    try {
      let r;
      if (person.id) r = await patch(`/people/${person.id}`, { ...payload, fullName: form.fullName, isActive: form.isActive });
      else if (identity) r = await post('/people', { ...payload, chamberId, nationalId: identity.nationalCode, birthDate: identity.birthDate });
      else r = await post('/people', { ...payload, chamberId, fullName: form.fullName });
      onSaved(r);
    } catch (e) {
      setErr(e as Error);
    }
  };
  const f = (k: keyof typeof form, label: string, ltr = false) => (
    <Field label={label}>
      <input className={`input ${ltr ? 'ltr' : ''}`} value={String(form[k])} onChange={(e) => setForm({ ...form, [k]: e.target.value })} />
    </Field>
  );
  const verified = !!person.identity_verified_at;
  return (
    <Modal
      title={person.id ? 'ویرایش شخص' : 'شخص جدید'}
      onClose={onClose}
      footer={<Button disabled={!person.id && !identity && !(manual && form.fullName.length >= 2)} onClick={save}>ذخیره</Button>}
    >
      <ErrorBox error={err} />
      {!person.id && !manual && (
        <>
          <IdentityLookup chamberId={chamberId} onResult={setIdentity} />
          <button className="btn btn-ghost btn-sm mb" onClick={() => setManual(true)}>
            ثبت دستی بدون استعلام (مثلاً مدعو خارجی)
          </button>
        </>
      )}
      {person.id && (
        <div className="row gap-sm mb">
          {verified ? <Badge tone="success">هویت تأییدشده</Badge> : <Badge tone="warning">هویت تأیید نشده</Badge>}
          {!verified && (
            <Button size="sm" variant="secondary" onClick={() => setVerifying(true)}>
              تأیید هویت
            </Button>
          )}
        </div>
      )}
      {(manual || (person.id && !verified)) && f('fullName', 'نام و نام خانوادگی')}
      {person.id && verified && (
        <p>
          <strong>{person.full_name}</strong> <span className="muted small ltr">{person.national_id}</span>
        </p>
      )}
      <div className="grid grid-2">
        {f('mobile', 'موبایل', true)}
        {f('email', 'ایمیل', true)}
        {f('organization', 'شرکت/سازمان')}
        {f('jobTitle', 'سمت سازمانی')}
      </div>
      {canSetPassword && (
        <Field label={person.id ? 'رمز عبور جدید (اختیاری)' : 'رمز عبور (برای امکان ورود)'} hint="حداقل ۸ کاراکتر">
          <input className="input ltr" type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
        </Field>
      )}
      {person.id && (
        <label className="check">
          <input type="checkbox" checked={form.isActive} onChange={(e) => setForm({ ...form, isActive: e.target.checked })} /> حساب فعال است
        </label>
      )}
      {verifying && <VerifyIdentityModal person={person} onClose={() => setVerifying(false)} onDone={(p) => { setVerifying(false); onSaved(p); }} />}
    </Modal>
  );
}

function VerifyIdentityModal({ person, onClose, onDone }: { person: any; onClose: () => void; onDone: (p: any) => void }) {
  const [nationalCode, setNationalCode] = useState(person.national_id ?? '');
  const [birthDate, setBirthDate] = useState('');
  const [err, setErr] = useState<Error | null>(null);
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    try {
      onDone(await post(`/people/${person.id}/verify-identity`, { nationalCode, birthDate }));
    } catch (e) {
      setErr(e as Error);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title={`تأیید هویت — ${person.full_name}`} onClose={onClose} footer={<Button busy={busy} onClick={go}>استعلام و ثبت</Button>}>
      <ErrorBox error={err} />
      <p className="muted small">نام شخص با نام رسمی ثبت احوال جایگزین می‌شود.</p>
      <Field label="کد ملی">
        <input className="input ltr" maxLength={10} value={nationalCode} onChange={(e) => setNationalCode(e.target.value)} />
      </Field>
      <Field label="تاریخ تولد (شمسی)">
        <input className="input ltr" placeholder="1371/01/01" value={birthDate} onChange={(e) => setBirthDate(e.target.value)} />
      </Field>
    </Modal>
  );
}
