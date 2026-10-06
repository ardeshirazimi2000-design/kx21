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
  const [form, setForm] = useState({ fullName: '', mobile: '', email: '', password: '' });
  const [q, setQ] = useState('');
  const [userId, setUserId] = useState<string | null>(null);
  const people = useApi(mode === 'existing' && q.length >= 2 ? `/people?chamberId=${chamber.id}&q=${encodeURIComponent(q)}&pageSize=8` : null);
  const [err, setErr] = useState<Error | null>(null);
  const save = async () => {
    try {
      if (mode === 'existing') await post(`/chambers/${chamber.id}/admins`, { userId });
      else
        await post(`/chambers/${chamber.id}/admins`, {
          person: { fullName: form.fullName, mobile: form.mobile || null, email: form.email || null, password: form.password },
        });
      onSaved();
    } catch (e) {
      setErr(e as Error);
    }
  };
  return (
    <Modal title={`تعیین مدیر — ${chamber.name}`} onClose={onClose} footer={<Button disabled={mode === 'existing' && !userId} onClick={save}>ثبت</Button>}>
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
          <Field label="نام و نام خانوادگی">
            <input className="input" value={form.fullName} onChange={(e) => setForm({ ...form, fullName: e.target.value })} />
          </Field>
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
        <input className="input mb" placeholder="جستجو بر اساس نام، سازمان، موبایل یا ایمیل" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} />
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
                    {p.can_login ? <Badge tone="success">ورود دارد</Badge> : <Badge>بدون حساب</Badge>}
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

export function PersonModal({ person, chamberId, canSetPassword, onClose, onSaved }: { person: any; chamberId: string; canSetPassword: boolean; onClose: () => void; onSaved: (p: any) => void }) {
  const [form, setForm] = useState({
    fullName: person.full_name ?? '',
    mobile: person.mobile ?? '',
    email: person.email ?? '',
    organization: person.organization ?? '',
    jobTitle: person.job_title ?? '',
    nationalId: person.national_id ?? '',
    password: '',
    isActive: person.is_active ?? true,
  });
  const [err, setErr] = useState<Error | null>(null);
  const save = async () => {
    const payload: any = {
      fullName: form.fullName,
      mobile: form.mobile || null,
      email: form.email || null,
      organization: form.organization || null,
      jobTitle: form.jobTitle || null,
      nationalId: form.nationalId || null,
    };
    if (form.password) payload.password = form.password;
    try {
      const r = person.id ? await patch(`/people/${person.id}`, { ...payload, isActive: form.isActive }) : await post('/people', { ...payload, chamberId });
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
  return (
    <Modal title={person.id ? 'ویرایش شخص' : 'شخص جدید'} onClose={onClose} footer={<Button onClick={save}>ذخیره</Button>}>
      <ErrorBox error={err} />
      {f('fullName', 'نام و نام خانوادگی')}
      <div className="grid grid-2">
        {f('mobile', 'موبایل', true)}
        {f('email', 'ایمیل', true)}
        {f('organization', 'شرکت/سازمان')}
        {f('jobTitle', 'سمت سازمانی')}
        {f('nationalId', 'کد ملی', true)}
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
    </Modal>
  );
}
