import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { roleLabel } from '@kx/shared';
import { post } from '../lib/api';
import { useAuth } from '../lib/auth';
import { ChamberField } from './Structure';
import { useApi } from '../lib/hooks';
import { Badge, Button, Card, Empty, ErrorBox, Field, fa, Loading, Modal, PageHeader, Pager } from '../components/ui';

export function CommissionsPage() {
  const { chamberId, isAdmin, me } = useAuth();
  const nav = useNavigate();
  const [page, setPage] = useState(1);
  const [q, setQ] = useState('');
  // The super admin can list the commissions of every chamber at once.
  const superAdmin = !!me?.is_super_admin;
  const [allChambers, setAllChambers] = useState(superAdmin);
  const scoped = isAdmin && chamberId && !(superAdmin && allChambers);
  const { data, loading, reload } = useApi(`/commissions?page=${page}&q=${encodeURIComponent(q)}${scoped ? `&chamberId=${chamberId}` : ''}`);
  const chambers = useApi<any[]>(isAdmin ? '/chambers' : null);
  const currentChamber = chambers.data?.find((c) => c.id === chamberId)?.name;
  const showChamber = superAdmin && allChambers;
  const [open, setOpen] = useState(false);
  return (
    <>
      <PageHeader
        title="کمیسیون‌ها"
        subtitle={showChamber ? 'کمیسیون‌های همه اتاق‌ها' : isAdmin && currentChamber ? `کمیسیون‌های ${currentChamber} — دوره جاری و دوره‌های گذشته` : 'کمیسیون‌های تخصصی دوره جاری و دوره‌های گذشته'}
        actions={isAdmin && <Button onClick={() => setOpen(true)}>{currentChamber ? `کمیسیون جدید در ${currentChamber}` : 'کمیسیون جدید'}</Button>}
      />
      <Card>
        {superAdmin && (
          <div className="row gap-sm mb" role="group" aria-label="دامنه نمایش">
            <Button size="sm" variant={allChambers ? 'primary' : 'ghost'} onClick={() => { setAllChambers(true); setPage(1); }}>
              همه اتاق‌ها
            </Button>
            <Button size="sm" variant={allChambers ? 'ghost' : 'primary'} onClick={() => { setAllChambers(false); setPage(1); }}>
              فقط {currentChamber ?? 'اتاق انتخاب‌شده'}
            </Button>
          </div>
        )}
        <input className="input mb" placeholder="جستجوی نام، کد یا حوزه تخصصی" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} />
        {loading && !data ? (
          <Loading />
        ) : data.items.length === 0 ? (
          <Empty>کمیسیونی یافت نشد.</Empty>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>نام</th>
                  {showChamber && <th>اتاق</th>}
                  <th>کد</th>
                  <th>دوره</th>
                  <th>رئیس</th>
                  <th>دبیر</th>
                  <th>اعضا</th>
                  <th>سمت من</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((c: any) => (
                  <tr key={c.id} className="clickable" onClick={() => nav(`/commissions/${c.id}`)}>
                    <td>
                      <strong>{c.name}</strong>
                      <div className="muted small">{c.domain}</div>
                    </td>
                    {showChamber && <td className="small">{c.chamber_name}</td>}
                    <td className="ltr">{c.code}</td>
                    <td>{c.term_title}</td>
                    <td>{c.chair_name ?? '—'}</td>
                    <td>{c.secretary_name ?? <Badge tone="warning">دبیر تعیین نشده</Badge>}</td>
                    <td>{fa(c.member_count)}</td>
                    <td>{c.my_position ? <Badge tone="info">{roleLabel(c.my_position, c.my_position_title)}</Badge> : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {data && <Pager page={page} pageSize={data.pageSize} total={data.total} onPage={setPage} />}
      </Card>
      {open && chamberId && <NewCommissionModal chamberId={chamberId} chambers={(chambers.data ?? []).filter((c) => superAdmin || me?.adminChambers.includes(c.id))} onClose={() => setOpen(false)} onSaved={(id) => { setOpen(false); void reload(); nav(`/commissions/${id}`); }} />}
    </>
  );
}

/** A commission belongs to one chamber and one of that chamber's terms (دوره). */
function NewCommissionModal({ chamberId: initialChamber, chambers, onClose, onSaved }: { chamberId: string; chambers: any[]; onClose: () => void; onSaved: (id: string) => void }) {
  const [chamberId, setChamberId] = useState(initialChamber);
  const terms = useApi<any[]>(`/terms?chamberId=${chamberId}`);
  const [form, setForm] = useState({ termId: '', name: '', code: '', domain: '', description: '' });
  const [err, setErr] = useState<Error | null>(null);
  const termId = form.termId || terms.data?.find((t) => t.status === 'active')?.id || '';
  const save = async () => {
    try {
      const r = await post('/commissions', { chamberId, ...form, termId });
      onSaved(r.id);
    } catch (e) {
      setErr(e as Error);
    }
  };
  return (
    <Modal title="کمیسیون جدید" onClose={onClose} footer={<Button onClick={save}>ایجاد</Button>}>
      <ErrorBox error={err} />
      <ChamberField
        chambers={chambers}
        value={chamberId}
        onChange={(id) => { setChamberId(id); setForm({ ...form, termId: '' }); }}
        hint="کمیسیون در این اتاق ثبت می‌شود و فقط مدیران همین اتاق و اعضای خود کمیسیون آن را می‌بینند"
      />
      {terms.data && terms.data.length === 0 && (
        <p className="alert alert-warning small">برای این اتاق هنوز دوره‌ای تعریف نشده است؛ ابتدا مدیر اتاق باید از منوی «دوره‌ها» دوره را تعریف کند.</p>
      )}
      <Field label="دوره">
        <select className="input" value={termId} onChange={(e) => setForm({ ...form, termId: e.target.value })}>
          <option value="">انتخاب کنید</option>
          {terms.data?.map((t) => (
            <option key={t.id} value={t.id}>
              {t.title}
              {t.status === 'active' ? ' (جاری)' : ''}
            </option>
          ))}
        </select>
      </Field>
      <Field label="نام کمیسیون">
        <input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
      </Field>
      <div className="grid grid-2">
        <Field label="کد" hint="در شماره‌گذاری مصوبات و صورتجلسات استفاده می‌شود">
          <input className="input ltr" value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value.toUpperCase() })} />
        </Field>
        <Field label="حوزه تخصصی">
          <input className="input" value={form.domain} onChange={(e) => setForm({ ...form, domain: e.target.value })} />
        </Field>
      </div>
      <Field label="شرح">
        <textarea className="input" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
      </Field>
      <p className="muted small">تنظیمات نصاب و رأی‌گیری با مقادیر پیش‌فرض ایجاد می‌شود و در صفحه کمیسیون قابل تغییر است.</p>
    </Modal>
  );
}
