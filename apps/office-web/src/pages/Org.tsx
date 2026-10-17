import { useState } from 'react';
import { useOrg, type Unit } from '../components/pickers';
import { Badge, Button, Card, Empty, ErrorBox, Field, Loading, Modal, PageHeader, Tabs, fa } from '../components/ui';
import { patch, post } from '../lib/api';
import { useAction } from '../lib/hooks';

const UNIT_KIND: Record<string, string> = { presidency: 'ریاست', deputy: 'معاونت', department: 'اداره کل / مدیریت', office: 'اداره', secretariat: 'دبیرخانه', committee: 'کمیته' };

export function OrgPage() {
  const org = useOrg();
  const [sel, setSel] = useState<string>('');
  const [view, setView] = useState<'tree' | 'chart'>('tree');
  const [showPositions, setShowPositions] = useState(true);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [unitModal, setUnitModal] = useState<Partial<Unit> | null>(null);
  const [posModal, setPosModal] = useState<any | null>(null);
  if (org.loading && !org.data) return <Loading />;
  const unit = org.units.find((u) => u.id === sel);
  const positions = org.positions.filter((p) => p.unit_id === sel);
  const children = (parent: string | null) => org.units.filter((u) => u.parent_id === parent);
  const toggle = (id: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const unitPositions = (id: string) => org.positions.filter((p) => p.unit_id === id).sort((a, b) => Number(b.is_manager) - Number(a.is_manager));

  const renderTree = (parent: string | null) => {
    const list = children(parent);
    if (!list.length) return null;
    return (
      <ul>
        {list.map((u) => {
          const kids = children(u.id);
          const pos = showPositions ? unitPositions(u.id) : [];
          const hasKids = kids.length > 0 || pos.length > 0;
          const open = !collapsed.has(u.id);
          return (
            <li key={u.id}>
              <div className={`org-node ${sel === u.id ? 'active' : ''} ${u.is_active ? '' : 'inactive'}`}>
                <button type="button" className="org-toggle" onClick={() => toggle(u.id)} disabled={!hasKids} aria-label={open ? 'بستن' : 'باز کردن'}>
                  {hasKids ? (open ? '▾' : '◂') : '•'}
                </button>
                <button type="button" className="org-label" onClick={() => setSel(u.id)}>
                  <strong>{u.name}</strong> <span className="small muted">{UNIT_KIND[u.kind]}</span> {!u.is_active && <Badge>غیرفعال</Badge>}
                </button>
              </div>
              {open && hasKids && (
                <>
                  {pos.length > 0 && (
                    <ul className="org-positions">
                      {pos.map((p) => (
                        <li key={p.id}>
                          <span className="org-pos">
                            {p.title} {p.is_manager && <Badge tone="accent">مدیر</Badge>}
                            <span className="small muted"> {p.holders?.map((h) => h.full_name).join('، ') || 'خالی'}</span>
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                  {renderTree(u.id)}
                </>
              )}
            </li>
          );
        })}
      </ul>
    );
  };

  /** Top-down chart: each unit is a box with its manager and the people in it. */
  const renderChart = (parent: string | null) => {
    const list = children(parent);
    if (!list.length) return null;
    return (
      <ul>
        {list.map((u) => {
          const pos = unitPositions(u.id);
          const manager = pos.find((p) => p.is_manager);
          return (
            <li key={u.id}>
              <button type="button" className={`org-box ${sel === u.id ? 'active' : ''} ${u.is_active ? '' : 'inactive'}`} onClick={() => setSel(u.id)}>
                <strong>{u.name}</strong>
                {manager && (
                  <span className="small">
                    {manager.title}: {manager.holders?.map((h) => h.full_name).join('، ') || 'خالی'}
                  </span>
                )}
                {showPositions && pos.length > (manager ? 1 : 0) && <span className="small muted">{fa(pos.length - (manager ? 1 : 0))} سمت دیگر</span>}
              </button>
              {renderChart(u.id)}
            </li>
          );
        })}
      </ul>
    );
  };

  return (
    <>
      <PageHeader
        title="ساختار سازمانی"
        subtitle="واحدها و سمت‌ها؛ ارجاع به سمت، مدیر واحد در گردش کار و دامنه دسترسی‌ها از این ساختار خوانده می‌شود"
        actions={<Button onClick={() => setUnitModal({ parent_id: sel || null })}>{sel ? 'زیرواحد جدید' : 'واحد جدید'}</Button>}
      />
      <Card>
        <div className="row between wrap mb">
          <Tabs
            value={view}
            onChange={setView}
            tabs={[
              { id: 'tree', label: 'نمای درختی' },
              { id: 'chart', label: 'نمودار سازمانی' },
            ]}
          />
          <div className="row gap wrap">
            <label className="check">
              <input type="checkbox" checked={showPositions} onChange={(e) => setShowPositions(e.target.checked)} />
              نمایش سمت‌ها و افراد
            </label>
            {view === 'tree' && (
              <>
                <Button size="sm" variant="ghost" onClick={() => setCollapsed(new Set())}>
                  باز کردن همه
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setCollapsed(new Set(org.units.map((u) => u.id)))}>
                  بستن همه
                </Button>
              </>
            )}
          </div>
        </div>
        {!org.units.length ? <Empty>واحدی تعریف نشده است.</Empty> : view === 'tree' ? <div className="org-tree">{renderTree(null)}</div> : <div className="org-chart">{renderChart(null)}</div>}
      </Card>
      {unit && (
        <Card
          className="mt"
          title={`${unit.name} (${unit.code})`}
          actions={
            <>
              <Button variant="secondary" size="sm" onClick={() => setUnitModal(unit)}>
                ویرایش واحد
              </Button>
              <Button variant="secondary" size="sm" onClick={() => setUnitModal({ parent_id: unit.id })}>
                زیرواحد جدید
              </Button>
              <Button size="sm" onClick={() => setPosModal({ unitId: unit.id, title: '', isManager: !positions.some((p) => p.is_manager) })}>
                سمت جدید
              </Button>
            </>
          }
        >
          <p className="muted">
            نوع: {UNIT_KIND[unit.kind]} · واحد بالادستی: {unit.parent_id ? org.unitName(unit.parent_id) : '—'} · زیرواحدها: {fa(children(unit.id).length)}
          </p>
          {!positions.length ? (
            <Empty>سمتی تعریف نشده است.</Empty>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>سمت</th>
                  <th>متصدی</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {positions.map((p) => (
                  <tr key={p.id}>
                    <td>
                      {p.title} {p.is_manager && <Badge tone="accent">مدیر واحد</Badge>}
                    </td>
                    <td>{p.holders?.map((h) => h.full_name).join('، ') || <span className="muted">خالی</span>}</td>
                    <td>
                      <Button variant="ghost" size="sm" onClick={() => setPosModal({ id: p.id, unitId: p.unit_id, title: p.title, isManager: p.is_manager })}>
                        ویرایش
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <p className="small muted mt">انتصاب افراد به سمت‌ها در صفحه کاربران انجام می‌شود.</p>
        </Card>
      )}
      {unitModal && <UnitModal unit={unitModal} units={org.tree} onClose={() => setUnitModal(null)} onDone={async () => (setUnitModal(null), await org.reload())} />}
      {posModal && <PositionModal value={posModal} onClose={() => setPosModal(null)} onDone={async () => (setPosModal(null), await org.reload())} />}
    </>
  );
}

function UnitModal({ unit, units, onClose, onDone }: { unit: Partial<Unit>; units: (Unit & { depth: number })[]; onClose: () => void; onDone: () => Promise<void> }) {
  // A unit can't move under itself or one of its own descendants.
  const blocked = new Set<string>(unit.id ? [unit.id] : []);
  for (const u of units) if (u.parent_id && blocked.has(u.parent_id)) blocked.add(u.id);
  const [f, setF] = useState({ name: unit.name ?? '', code: unit.code ?? '', parentId: unit.parent_id ?? '', kind: unit.kind ?? 'department', isActive: unit.is_active ?? true });
  const act = useAction();
  return (
    <Modal
      title={unit.id ? 'ویرایش واحد' : 'واحد جدید'}
      onClose={onClose}
      footer={
        <Button
          busy={act.busy}
          onClick={() =>
            act.run(async () => {
              const body = { ...f, parentId: f.parentId || null };
              if (unit.id) await patch(`/org/units/${unit.id}`, body);
              else await post('/org/units', body);
              await onDone();
            })
          }
        >
          ذخیره
        </Button>
      }
    >
      <ErrorBox error={act.error} />
      <Field label="نام">
        <input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
      </Field>
      <Field label="کد">
        <input className="input ltr" value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} />
      </Field>
      <Field label="نوع">
        <select className="input" value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>
          {Object.entries(UNIT_KIND).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
      </Field>
      <Field label="واحد بالادستی">
        <select className="input" value={f.parentId} onChange={(e) => setF({ ...f, parentId: e.target.value })}>
          <option value="">— (ریشه)</option>
          {units
            .filter((u) => !blocked.has(u.id))
            .map((u) => (
              <option key={u.id} value={u.id}>
                {'\u00a0\u00a0'.repeat(u.depth)}
                {u.name}
              </option>
            ))}
        </select>
      </Field>
      {unit.id && (
        <label className="check">
          <input type="checkbox" checked={f.isActive} onChange={(e) => setF({ ...f, isActive: e.target.checked })} />
          فعال
        </label>
      )}
    </Modal>
  );
}

function PositionModal({ value, onClose, onDone }: { value: any; onClose: () => void; onDone: () => Promise<void> }) {
  const [f, setF] = useState(value);
  const act = useAction();
  return (
    <Modal
      title={f.id ? 'ویرایش سمت' : 'سمت جدید'}
      onClose={onClose}
      footer={
        <Button
          busy={act.busy}
          onClick={() =>
            act.run(async () => {
              const body = { unitId: f.unitId, title: f.title, isManager: f.isManager };
              if (f.id) await patch(`/org/positions/${f.id}`, body);
              else await post('/org/positions', body);
              await onDone();
            })
          }
        >
          ذخیره
        </Button>
      }
    >
      <ErrorBox error={act.error} />
      <Field label="عنوان سمت">
        <input className="input" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} />
      </Field>
      <label className="check">
        <input type="checkbox" checked={f.isManager} onChange={(e) => setF({ ...f, isManager: e.target.checked })} />
        مدیر واحد (گیرنده گام‌های «مدیر واحد» و ارتقای مهلت)
      </label>
    </Modal>
  );
}
