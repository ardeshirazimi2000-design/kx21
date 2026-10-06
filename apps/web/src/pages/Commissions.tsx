import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ROLE_LABELS, type Position } from '@kx/shared';
import { post } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useApi } from '../lib/hooks';
import { Badge, Button, Card, Empty, ErrorBox, Field, fa, Loading, Modal, PageHeader, Pager } from '../components/ui';

export function CommissionsPage() {
  const { chamberId, isAdmin } = useAuth();
  const nav = useNavigate();
  const [page, setPage] = useState(1);
  const [q, setQ] = useState('');
  const { data, loading, reload } = useApi(`/commissions?page=${page}&q=${encodeURIComponent(q)}`);
  const [open, setOpen] = useState(false);
  return (
    <>
      <PageHeader title="کمیسیون‌ها" subtitle="کمیسیون‌های تخصصی دوره جاری و دوره‌های گذشته" actions={isAdmin && <Button onClick={() => setOpen(true)}>کمیسیون جدید</Button>} />
      <Card>
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
                    <td className="ltr">{c.code}</td>
                    <td>{c.term_title}</td>
                    <td>{c.chair_name ?? '—'}</td>
                    <td>{c.secretary_name ?? '—'}</td>
                    <td>{fa(c.member_count)}</td>
                    <td>{c.my_position ? <Badge tone="info">{ROLE_LABELS[c.my_position as Position]}</Badge> : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {data && <Pager page={page} pageSize={data.pageSize} total={data.total} onPage={setPage} />}
      </Card>
      {open && chamberId && <NewCommissionModal chamberId={chamberId} onClose={() => setOpen(false)} onSaved={(id) => { setOpen(false); void reload(); nav(`/commissions/${id}`); }} />}
    </>
  );
}

function NewCommissionModal({ chamberId, onClose, onSaved }: { chamberId: string; onClose: () => void; onSaved: (id: string) => void }) {
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
      <Field label="دوره">
        <select className="input" value={termId} onChange={(e) => setForm({ ...form, termId: e.target.value })}>
          <option value="">انتخاب کنید</option>
          {terms.data?.map((t) => (
            <option key={t.id} value={t.id}>
              {t.title}
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
