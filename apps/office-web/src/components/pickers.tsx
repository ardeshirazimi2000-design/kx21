import { useState } from 'react';
import { useApi } from '../lib/hooks';

export interface Unit {
  id: string;
  parent_id: string | null;
  name: string;
  code: string;
  kind: string;
  is_active: boolean;
}
export interface Position {
  id: string;
  unit_id: string;
  title: string;
  is_manager: boolean;
  holders: { id: string; full_name: string }[] | null;
}

/** Org chart (units + positions) shared by pickers. */
export function useOrg() {
  const r = useApi<{ units: Unit[]; positions: Position[] }>('/org/units');
  const units = r.data?.units ?? [];
  const positions = r.data?.positions ?? [];
  const unitName = (id: string | null | undefined) => units.find((u) => u.id === id)?.name ?? '—';
  /** Units in tree order with their depth. */
  const tree: (Unit & { depth: number })[] = [];
  const walk = (parent: string | null, depth: number) => {
    for (const u of units.filter((x) => x.parent_id === parent)) {
      tree.push({ ...u, depth });
      walk(u.id, depth + 1);
    }
  };
  walk(null, 0);
  return { ...r, units, positions, unitName, tree };
}

export function UnitSelect({ value, onChange, allowEmpty = true, emptyLabel = '—' }: { value: string; onChange: (v: string) => void; allowEmpty?: boolean; emptyLabel?: string }) {
  const { tree } = useOrg();
  return (
    <select className="input" value={value} onChange={(e) => onChange(e.target.value)}>
      {allowEmpty && <option value="">{emptyLabel}</option>}
      {tree.map((u) => (
        <option key={u.id} value={u.id}>
          {'  '.repeat(u.depth)}
          {u.name}
        </option>
      ))}
    </select>
  );
}

export function PositionSelect({ value, onChange, emptyLabel = 'انتخاب سمت…' }: { value: string; onChange: (v: string) => void; emptyLabel?: string }) {
  const { tree, positions } = useOrg();
  return (
    <select className="input" value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">{emptyLabel}</option>
      {tree.map((u) => (
        <optgroup key={u.id} label={u.name}>
          {positions
            .filter((p) => p.unit_id === u.id)
            .map((p) => (
              <option key={p.id} value={p.id}>
                {p.title}
                {p.holders?.length ? ` (${p.holders.map((h) => h.full_name).join('، ')})` : ' (خالی)'}
              </option>
            ))}
        </optgroup>
      ))}
    </select>
  );
}

export interface DirUser {
  id: string;
  full_name: string;
  positions: string | null;
}

/** Searchable user picker from the directory. */
export function UserSelect({ value, onChange, placeholder = 'انتخاب کاربر…' }: { value: string; onChange: (v: string, user?: DirUser) => void; placeholder?: string }) {
  const [q, setQ] = useState('');
  const dir = useApi<DirUser[]>(`/users/directory?q=${encodeURIComponent(q)}`, [q]);
  const list = dir.data ?? [];
  return (
    <div className="col gap-sm">
      <input className="input" placeholder="جستجوی نام…" value={q} onChange={(e) => setQ(e.target.value)} />
      <select className="input" value={value} onChange={(e) => onChange(e.target.value, list.find((u) => u.id === e.target.value))}>
        <option value="">{placeholder}</option>
        {list.map((u) => (
          <option key={u.id} value={u.id}>
            {u.full_name}
            {u.positions ? ` — ${u.positions}` : ''}
          </option>
        ))}
      </select>
    </div>
  );
}
