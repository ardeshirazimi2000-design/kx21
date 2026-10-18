import { useState } from 'react';
import { CONFIDENTIALITY } from '../components/labels';
import { PositionSelect, UnitSelect, useOrg } from '../components/pickers';
import { Badge, Button, Card, Empty, ErrorBox, Field, Loading, Modal, PageHeader, Pager, dateTimeFa } from '../components/ui';
import { patch, post } from '../lib/api';
import { useAction, useApi } from '../lib/hooks';

export function UsersPage() {
  const [page, setPage] = useState(1);
  const [q, setQ] = useState('');
  const qs = `page=${page}${q ? `&q=${encodeURIComponent(q)}` : ''}`;
  const r = useApi<{ items: any[]; total: number; page: number; pageSize: number }>(`/users?${qs}`, [qs]);
  const [edit, setEdit] = useState<any | null>(null);
  return (
    <>
      <PageHeader title="کاربران" actions={<Button onClick={() => setEdit({})}>کاربر جدید</Button>} />
      <Card>
        <input className="input mb" placeholder="جستجوی نام، نام کاربری یا کد ملی…" onKeyDown={(e) => e.key === 'Enter' && (setQ((e.target as HTMLInputElement).value.trim()), setPage(1))} />
        {r.loading && !r.data ? (
          <Loading />
        ) : !r.data?.items.length ? (
          <Empty>کاربری یافت نشد.</Empty>
        ) : (
          <>
            <table className="table">
              <thead>
                <tr>
                  <th>نام</th>
                  <th>نام کاربری</th>
                  <th>سمت‌ها</th>
                  <th>نقش‌ها</th>
                  <th>امنیت</th>
                  <th>آخرین ورود</th>
                </tr>
              </thead>
              <tbody>
                {r.data.items.map((u) => (
                  <tr key={u.id} className="clickable" onClick={() => setEdit(u)}>
                    <td>
                      {u.full_name} {!u.is_active && <Badge tone="danger">غیرفعال</Badge>}
                    </td>
                    <td className="mono">{u.username}</td>
                    <td className="small">{(u.positions ?? []).map((p: any) => `${p.title} — ${p.unit}`).join('، ') || '—'}</td>
                    <td className="small">{(u.roles ?? []).map((x: any) => (x.scopeUnit ? `${x.name} (${x.scopeUnit})` : x.name)).join('، ') || '—'}</td>
                    <td>
                      {u.mfa_enabled ? <Badge tone="success">دومرحله‌ای</Badge> : <Badge>رمز عبور</Badge>} {u.clearance > 0 && <Badge tone="danger">{CONFIDENTIALITY[u.clearance]}</Badge>}
                    </td>
                    <td className="small">{u.last_login_at ? dateTimeFa(u.last_login_at) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <Pager page={r.data.page} pageSize={r.data.pageSize} total={Number(r.data.total)} onPage={setPage} />
          </>
        )}
      </Card>
      {edit && <UserModal user={edit} onClose={() => setEdit(null)} onDone={async () => (setEdit(null), await r.reload())} />}
    </>
  );
}

function UserModal({ user, onClose, onDone }: { user: any; onClose: () => void; onDone: () => Promise<void> }) {
  const roles = useApi<{ roles: any[] }>('/roles');
  const org = useOrg();
  const isNew = !user.id;
  const [f, setF] = useState({
    username: user.username ?? '',
    fullName: user.full_name ?? '',
    nationalId: user.national_id ?? '',
    email: user.email ?? '',
    mobile: user.mobile ?? '',
    password: '',
    clearance: user.clearance ?? 0,
    isActive: user.is_active ?? true,
  });
  const [positions, setPositions] = useState<{ positionId: string; isPrimary: boolean }[]>((user.positions ?? []).map((p: any) => ({ positionId: p.positionId, isPrimary: p.isPrimary })));
  const [userRoles, setUserRoles] = useState<{ roleId: string; scopeUnitId: string }[]>((user.roles ?? []).map((x: any) => ({ roleId: x.roleId, scopeUnitId: x.scopeUnitId ?? '' })));
  const [newPos, setNewPos] = useState('');
  const act = useAction();
  const posLabel = (id: string) => {
    const p = org.positions.find((x) => x.id === id);
    return p ? `${p.title} — ${org.unitName(p.unit_id)}` : id;
  };
  return (
    <Modal
      wide
      title={isNew ? 'کاربر جدید' : user.full_name}
      onClose={onClose}
      footer={
        <>
          <Button
            busy={act.busy}
            onClick={() =>
              act.run(async () => {
                const body = {
                  ...f,
                  nationalId: f.nationalId || null,
                  email: f.email || null,
                  mobile: f.mobile || null,
                  password: f.password || undefined,
                  positions,
                  roles: userRoles.filter((x) => x.roleId).map((x) => ({ roleId: x.roleId, scopeUnitId: x.scopeUnitId || null })),
                };
                if (isNew) await post('/users', body);
                else await patch(`/users/${user.id}`, { ...body, username: undefined });
                await onDone();
              })
            }
          >
            ذخیره
          </Button>
          {!isNew && user.mfa_enabled && (
            <Button variant="ghost" onClick={() => act.run(async () => (await patch(`/users/${user.id}`, { resetMfa: true }), await onDone()))}>
              بازنشانی ورود دومرحله‌ای
            </Button>
          )}
        </>
      }
    >
      <ErrorBox error={act.error} />
      <div className="grid grid-3">
        <Field label="نام کاربری">
          <input className="input ltr" value={f.username} disabled={!isNew} onChange={(e) => setF({ ...f, username: e.target.value })} />
        </Field>
        <Field label="نام و نام خانوادگی">
          <input className="input" value={f.fullName} onChange={(e) => setF({ ...f, fullName: e.target.value })} />
        </Field>
        <Field label="کد ملی" hint="برای تطبیق با سامانه جلسات">
          <input className="input ltr" value={f.nationalId} onChange={(e) => setF({ ...f, nationalId: e.target.value })} />
        </Field>
        <Field label="ایمیل">
          <input className="input ltr" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} />
        </Field>
        <Field label="موبایل">
          <input className="input ltr" value={f.mobile} onChange={(e) => setF({ ...f, mobile: e.target.value })} />
        </Field>
        <Field label={isNew ? 'رمز عبور' : 'رمز عبور جدید (اختیاری)'} hint="حداقل ۸ نویسه شامل حرف و عدد">
          <input className="input ltr" type="password" autoComplete="new-password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} />
        </Field>
        <Field label="سطح دسترسی به اسناد طبقه‌بندی‌شده">
          <select className="input" value={f.clearance} onChange={(e) => setF({ ...f, clearance: Number(e.target.value) })}>
            {CONFIDENTIALITY.map((l, i) => (
              <option key={i} value={i}>
                {l}
              </option>
            ))}
          </select>
        </Field>
        {!isNew && (
          <label className="check">
            <input type="checkbox" checked={f.isActive} onChange={(e) => setF({ ...f, isActive: e.target.checked })} />
            فعال
          </label>
        )}
      </div>
      <h3>سمت‌ها</h3>
      <ul className="list">
        {positions.map((p) => (
          <li key={p.positionId} className="row between">
            <span>
              {posLabel(p.positionId)} {p.isPrimary && <Badge tone="info">اصلی</Badge>}
            </span>
            <span className="row gap-sm">
              {!p.isPrimary && (
                <Button variant="ghost" size="sm" onClick={() => setPositions(positions.map((x) => ({ ...x, isPrimary: x.positionId === p.positionId })))}>
                  سمت اصلی
                </Button>
              )}
              <Button variant="ghost" size="sm" onClick={() => setPositions(positions.filter((x) => x.positionId !== p.positionId))}>
                حذف
              </Button>
            </span>
          </li>
        ))}
      </ul>
      <div className="row gap">
        <div className="grow">
          <PositionSelect value={newPos} onChange={setNewPos} />
        </div>
        <Button
          variant="secondary"
          disabled={!newPos || positions.some((p) => p.positionId === newPos)}
          onClick={() => (setPositions([...positions, { positionId: newPos, isPrimary: !positions.length }]), setNewPos(''))}
        >
          افزودن سمت
        </Button>
      </div>
      <h3 className="mt">نقش‌ها</h3>
      <p className="small muted">دامنه خالی یعنی کل سازمان؛ با انتخاب واحد، مجوزهای نقش فقط در آن واحد و زیرمجموعه‌هایش معتبر است.</p>
      {userRoles.map((x, i) => (
        <div key={i} className="row gap mb">
          <select className="input" value={x.roleId} onChange={(e) => setUserRoles(userRoles.map((y, j) => (j === i ? { ...y, roleId: e.target.value } : y)))}>
            <option value="">انتخاب نقش…</option>
            {(roles.data?.roles ?? []).map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
          <UnitSelect value={x.scopeUnitId} onChange={(v) => setUserRoles(userRoles.map((y, j) => (j === i ? { ...y, scopeUnitId: v } : y)))} emptyLabel="کل سازمان" />
          <Button variant="ghost" onClick={() => setUserRoles(userRoles.filter((_, j) => j !== i))}>
            حذف
          </Button>
        </div>
      ))}
      <Button variant="secondary" onClick={() => setUserRoles([...userRoles, { roleId: '', scopeUnitId: '' }])}>
        افزودن نقش
      </Button>
    </Modal>
  );
}
