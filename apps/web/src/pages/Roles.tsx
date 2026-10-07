import { Fragment, useEffect, useMemo, useState } from 'react';
import { Badge, Button, Card, ErrorBox, Field, Loading, Modal, PageHeader } from '../components/ui';
import { api, post } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useApi } from '../lib/hooks';

interface Role {
  key: string;
  title: string;
  builtin: boolean;
  kind: 'chamber' | 'commission' | 'meeting';
  has_vote: boolean;
  capabilities: string[];
  customized: boolean;
  defaults: string[];
  description?: string | null;
}

const KIND_LABEL: Record<Role['kind'], string> = { chamber: 'سطح اتاق', commission: 'کمیسیون', meeting: 'فقط جلسه' };

/** Roles & permissions matrix of the chamber in focus (chamber admins and the super admin). */
export function RolesPage() {
  const { chamberId, isAdmin } = useAuth();
  const { data, error, reload, setData } = useApi<{ roles: Role[]; capabilities: { key: string; title: string; group: string }[] }>(
    chamberId && isAdmin ? `/roles?chamberId=${chamberId}` : null,
  );
  const [draft, setDraft] = useState<Record<string, string[]>>({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<Error | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    if (data) setDraft(Object.fromEntries(data.roles.map((r) => [r.key, [...r.capabilities]])));
  }, [data]);

  const groups = useMemo(() => {
    const g = new Map<string, { key: string; title: string }[]>();
    for (const c of data?.capabilities ?? []) g.set(c.group, [...(g.get(c.group) ?? []), c]);
    return [...g.entries()];
  }, [data]);

  if (!isAdmin) return <ErrorBox error={new Error('این بخش فقط برای مدیر اتاق است')} />;
  if (error) return <ErrorBox error={error} />;
  if (!data) return <Loading />;

  const changed = data.roles.filter((r) => [...(draft[r.key] ?? [])].sort().join() !== [...r.capabilities].sort().join());
  const toggle = (role: string, cap: string) =>
    setDraft((d) => ({ ...d, [role]: d[role]?.includes(cap) ? d[role].filter((c) => c !== cap) : [...(d[role] ?? []), cap] }));

  const run = async (fn: () => Promise<any>, ok: string) => {
    setBusy(true);
    setErr(null);
    setMsg(null);
    try {
      const r = await fn();
      if (r?.roles) setData((d) => d && { ...d, roles: r.roles });
      else if (Array.isArray(r)) setData((d) => d && { ...d, roles: r });
      else await reload();
      setMsg(ok);
    } catch (e) {
      setErr(e as Error);
    } finally {
      setBusy(false);
    }
  };

  const saveAll = () =>
    run(async () => {
      let last: any;
      for (const r of changed) last = await api(`/roles/${r.key}`, { method: 'PUT', json: { chamberId, capabilities: draft[r.key] } });
      return last;
    }, 'دسترسی‌ها ذخیره شد');

  return (
    <>
      <PageHeader
        title="نقش‌ها و دسترسی‌ها"
        subtitle="دسترسی هر نقش در این اتاق را تعیین کنید یا نقش جدید تعریف کنید. نقش‌های جدید در «اعضا و سمت‌ها» و دعوت جلسه قابل انتخاب‌اند."
        actions={
          <>
            <Button variant="secondary" onClick={() => setAdding(true)}>
              نقش جدید
            </Button>
            <Button busy={busy} disabled={!changed.length} onClick={saveAll}>
              ذخیره تغییرات{changed.length ? ` (${changed.length})` : ''}
            </Button>
          </>
        }
      />
      <ErrorBox error={err} />
      {msg && <div className="alert alert-success">{msg}</div>}
      <div className="alert alert-info small">
        حق رأی، اعلام حضور و ثبت نظر فقط برای کسی اعمال می‌شود که به جلسه دعوت شده باشد. مدیر اتاق همیشه تعریف ساختار (دوره، کمیسیون، اعضا)، گزارش‌های کلان و
        رویدادنگاری را دارد تا دسترسی مدیریت اتاق از دست نرود. همه تغییرات در رویدادنگاری ثبت می‌شود.
      </div>
      <Card>
        <div className="table-wrap">
          <table className="table roles-table">
            <thead>
              <tr>
                <th style={{ minWidth: 260 }}>دسترسی</th>
                {data.roles.map((r) => (
                  <th key={r.key} style={{ textAlign: 'center', minWidth: 96 }}>
                    <div>{r.title}</div>
                    <div className="row gap-sm" style={{ justifyContent: 'center', flexWrap: 'wrap' }}>
                      <Badge tone={r.builtin ? 'neutral' : 'accent'}>{r.builtin ? KIND_LABEL[r.kind] : 'نقش جدید'}</Badge>
                    </div>
                    {r.builtin && r.customized && (
                      <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => run(() => post(`/roles/${r.key}/reset`, { chamberId }), `پیش‌فرض «${r.title}» بازگردانی شد`)}>
                        پیش‌فرض
                      </button>
                    )}
                    {!r.builtin && (
                      <button
                        className="btn btn-ghost btn-sm"
                        disabled={busy}
                        onClick={() =>
                          confirm(`نقش «${r.title}» حذف شود؟`) &&
                          run(() => api(`/roles/${r.key}?chamberId=${chamberId}`, { method: 'DELETE' }), `نقش «${r.title}» حذف شد`)
                        }
                      >
                        حذف
                      </button>
                    )}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {groups.map(([group, caps]) => (
                <Fragment key={group}>
                  <tr>
                    <td colSpan={data.roles.length + 1} style={{ background: 'var(--surface-2)', fontWeight: 600 }}>
                      {group}
                    </td>
                  </tr>
                  {caps.map((c) => (
                    <tr key={c.key}>
                      <td className="small">{c.title}</td>
                      {data.roles.map((r) => {
                        const on = draft[r.key]?.includes(c.key) ?? false;
                        const isDefault = r.builtin && r.defaults.includes(c.key);
                        // Meeting-participation rights need an invitation; the chamber admin role is never invited.
                        const notApplicable = r.key === 'chamber_admin' && ['attendance.self', 'comment.create', 'vote.cast'].includes(c.key);
                        return (
                          <td key={r.key} style={{ textAlign: 'center' }}>
                            <input
                              type="checkbox"
                              aria-label={`${c.title} — ${r.title}`}
                              checked={on && !notApplicable}
                              disabled={notApplicable}
                              onChange={() => toggle(r.key, c.key)}
                              title={r.builtin ? (isDefault ? 'در پیش‌فرض فعال است' : 'در پیش‌فرض غیرفعال است') : ''}
                            />
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
      {adding && (
        <NewRoleModal
          roles={data.roles}
          chamberId={chamberId!}
          onClose={() => setAdding(false)}
          onSaved={(roles) => {
            setAdding(false);
            setData((d) => d && { ...d, roles });
            setMsg('نقش جدید تعریف شد');
          }}
        />
      )}
    </>
  );
}

function NewRoleModal({ roles, chamberId, onClose, onSaved }: { roles: Role[]; chamberId: string; onClose: () => void; onSaved: (roles: Role[]) => void }) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [hasVote, setHasVote] = useState(false);
  const [copyFrom, setCopyFrom] = useState('member');
  const [err, setErr] = useState<Error | null>(null);
  const save = async () => {
    try {
      const base = roles.find((r) => r.key === copyFrom);
      const r = await post('/roles', { chamberId, title, description: description || null, hasVote, capabilities: base?.capabilities ?? [] });
      onSaved(r.roles);
    } catch (e) {
      setErr(e as Error);
    }
  };
  return (
    <Modal title="تعریف نقش جدید" onClose={onClose} footer={<Button disabled={title.trim().length < 2} onClick={save}>ایجاد</Button>}>
      <ErrorBox error={err} />
      <Field label="عنوان نقش" hint="مثلاً: مشاور، دبیر اجرایی، نماینده تشکل">
        <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} />
      </Field>
      <Field label="شرح (اختیاری)">
        <input className="input" value={description} onChange={(e) => setDescription(e.target.value)} />
      </Field>
      <Field label="دسترسی‌های اولیه را از این نقش کپی کن">
        <select className="input" value={copyFrom} onChange={(e) => setCopyFrom(e.target.value)}>
          <option value="">هیچ (بدون دسترسی)</option>
          {roles
            .filter((r) => r.key !== 'chamber_admin')
            .map((r) => (
              <option key={r.key} value={r.key}>
                {r.title}
              </option>
            ))}
        </select>
      </Field>
      <label className="check">
        <input type="checkbox" checked={hasVote} onChange={(e) => setHasVote(e.target.checked)} /> اعضای این نقش به‌طور پیش‌فرض حق رأی دارند
      </label>
      <p className="muted small">پس از ایجاد، دسترسی‌ها را در جدول تنظیم کنید.</p>
    </Modal>
  );
}
