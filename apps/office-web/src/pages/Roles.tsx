import { Fragment, useEffect, useState } from 'react';
import { Badge, Button, Card, ErrorBox, Field, Loading, Modal, PageHeader, fa } from '../components/ui';
import { patch, post } from '../lib/api';
import { useAction, useApi } from '../lib/hooks';

export function RolesPage() {
  const r = useApi<{ roles: any[]; permissions: { key: string; name: string; module: string }[] }>('/roles');
  const [matrix, setMatrix] = useState<Record<string, string[]>>({});
  const [newRole, setNewRole] = useState(false);
  const act = useAction();
  useEffect(() => {
    if (r.data) setMatrix(Object.fromEntries(r.data.roles.map((x) => [x.id, x.permissions])));
  }, [r.data]);
  if (!r.data) return <Loading />;
  const modules = [...new Set(r.data.permissions.map((p) => p.module))];
  const dirty = r.data.roles.filter((x) => JSON.stringify([...x.permissions].sort()) !== JSON.stringify([...(matrix[x.id] ?? [])].sort()));
  const toggle = (roleId: string, key: string) =>
    setMatrix((m) => ({ ...m, [roleId]: m[roleId]?.includes(key) ? m[roleId].filter((k) => k !== key) : [...(m[roleId] ?? []), key] }));
  return (
    <>
      <PageHeader
        title="نقش‌ها و مجوزها"
        subtitle="کنترل دسترسی مبتنی بر نقش (RBAC) با دامنه واحد سازمانی و سطح طبقه‌بندی کاربر (ABAC)"
        actions={
          <>
            <Button variant="secondary" onClick={() => setNewRole(true)}>
              نقش جدید
            </Button>
            <Button
              disabled={!dirty.length}
              busy={act.busy}
              onClick={() =>
                act.run(async () => {
                  for (const x of dirty) await patch(`/roles/${x.id}`, { permissions: matrix[x.id] });
                  await r.reload();
                })
              }
            >
              ذخیره تغییرات {dirty.length ? `(${fa(dirty.length)})` : ''}
            </Button>
          </>
        }
      />
      <ErrorBox error={act.error} />
      <Card>
        <div className="table-wrap">
          <table className="table perm-matrix">
            <thead>
              <tr>
                <th>مجوز</th>
                {r.data.roles.map((x) => (
                  <th key={x.id}>
                    {x.name}
                    <div className="small muted">{fa(x.user_count)} کاربر</div>
                    {x.is_system && <Badge>سیستمی</Badge>}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {modules.map((m) => (
                <Fragment key={m}>
                  <tr>
                    <td colSpan={r.data!.roles.length + 1}>
                      <strong>{m}</strong>
                    </td>
                  </tr>
                  {r.data!.permissions
                    .filter((p) => p.module === m)
                    .map((p) => (
                      <tr key={p.key}>
                        <td>
                          {p.name} <span className="small muted mono">{p.key}</span>
                        </td>
                        {r.data!.roles.map((x) => (
                          <td key={x.id}>
                            <input type="checkbox" aria-label={`${x.name}: ${p.name}`} checked={!!matrix[x.id]?.includes(p.key)} onChange={() => toggle(x.id, p.key)} />
                          </td>
                        ))}
                      </tr>
                    ))}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
      {newRole && <NewRoleModal onClose={() => setNewRole(false)} onDone={async () => (setNewRole(false), await r.reload())} />}
    </>
  );
}

function NewRoleModal({ onClose, onDone }: { onClose: () => void; onDone: () => Promise<void> }) {
  const [f, setF] = useState({ key: '', name: '', description: '' });
  const act = useAction();
  return (
    <Modal title="نقش جدید" onClose={onClose} footer={<Button busy={act.busy} onClick={() => act.run(async () => (await post('/roles', { ...f, description: f.description || null, permissions: [] }), await onDone()))}>ایجاد</Button>}>
      <ErrorBox error={act.error} />
      <Field label="کلید (لاتین)">
        <input className="input ltr" value={f.key} onChange={(e) => setF({ ...f, key: e.target.value })} />
      </Field>
      <Field label="عنوان">
        <input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
      </Field>
      <Field label="توضیح">
        <input className="input" value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} />
      </Field>
    </Modal>
  );
}
