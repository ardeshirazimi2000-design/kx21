import { TERM_STATUS_LABELS, type TermStatus } from '@kx/shared';
import { useState } from 'react';
import { patch, post } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useApi } from '../lib/hooks';
import { Badge, Button, Card, dateFa, Empty, ErrorBox, Field, fa, JalaliDateInput, Loading, Modal, PageHeader, Pager } from '../components/ui';

/** Chambers (super admin) */
export function ChambersPage() {
  const { data, reload, loading } = useApi<any[]>('/chambers');
  const [open, setOpen] = useState(false);
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
  return (
    <>
      <PageHeader title="اتاق‌ها" subtitle="مدیریت اتاق‌های استانی (Multi-tenant)" actions={<Button onClick={() => setOpen(true)}>اتاق جدید</Button>} />
      <Card>
        {loading && !data ? (
          <Loading />
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>نام</th>
                <th>استان</th>
                <th>تلفن</th>
                <th>ایمیل</th>
              </tr>
            </thead>
            <tbody>
              {data?.map((c) => (
                <tr key={c.id}>
                  <td>{c.name}</td>
                  <td>{c.province}</td>
                  <td className="ltr">{c.phone}</td>
                  <td className="ltr">{c.email}</td>
                </tr>
              ))}
            </tbody>
          </table>
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
        </Modal>
      )}
    </>
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
