import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { patch, post } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useAction, useApi } from '../lib/hooks';
import { Button, ErrorBox, Field, Modal } from './ui';

export type ContactKind = 'organization' | 'unit' | 'position';
export interface Contact {
  id: string;
  parent_id: string | null;
  kind: ContactKind;
  name: string;
  person_name: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  notes: string | null;
  is_active: boolean;
  letter_count: number;
}

export const CONTACT_KIND: Record<ContactKind, string> = { organization: 'سازمان', unit: 'واحد', position: 'سمت / شخص' };

const norm = (t: string) => t.replace(/[يى]/g, 'ی').replace(/ك/g, 'ک').replace(/‌/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();

/** Display name of one node: a position shows its holder too. */
export const contactName = (c: Pick<Contact, 'kind' | 'name' | 'person_name'>) =>
  c.kind === 'position' && c.person_name ? `${c.person_name} — ${c.name}` : c.name;

/** External contacts directory as a tree (organisations → units → positions). */
export function useContacts(all = false) {
  const r = useApi<Contact[]>(all ? '/contacts?all=1' : '/contacts');
  const derived = useMemo(() => {
    const list = r.data ?? [];
    const byId = new Map(list.map((c) => [c.id, c]));
    const children = (parent: string | null) =>
      list
        .filter((c) => c.parent_id === parent)
        .sort((a, b) => Number(a.kind === 'position') - Number(b.kind === 'position') || a.name.localeCompare(b.name, 'fa'));
    const ancestors = (id: string) => {
      const out: Contact[] = [];
      for (let c = byId.get(id); c; c = c.parent_id ? byId.get(c.parent_id) : undefined) out.unshift(c);
      return out;
    };
    /** «سازمان — واحد — شخص — سمت», the way the letter will name it. */
    const pathLabel = (id: string) => ancestors(id).map(contactName).join(' — ');
    const tree: (Contact & { depth: number })[] = [];
    const walk = (parent: string | null, depth: number) => {
      for (const c of children(parent)) {
        tree.push({ ...c, depth });
        walk(c.id, depth + 1);
      }
    };
    walk(null, 0);
    return { list, byId, children, ancestors, pathLabel, tree };
  }, [r.data]);
  return { ...r, ...derived };
}

/**
 * Picks the sender / recipient of an external letter from the contacts tree, with search; those who maintain the
 * directory can add a missing organisation, unit or position on the spot.
 */
export function ContactPicker({
  value,
  onChange,
  placeholder = 'انتخاب از مخاطبین…',
}: {
  value: string;
  onChange: (id: string) => void;
  placeholder?: string;
}) {
  const { can } = useAuth();
  const contacts = useContacts();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [adding, setAdding] = useState<Partial<Contact> | null>(null);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [open]);
  // Open the branch of the current choice.
  useEffect(() => {
    if (open && value) setExpanded((prev) => new Set([...prev, ...contacts.ancestors(value).map((c) => c.id)]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const pick = (id: string) => {
    onChange(id);
    setOpen(false);
    setQ('');
  };
  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const nq = norm(q);
  const matches = nq
    ? contacts.list.filter((c) => norm(`${c.name} ${c.person_name ?? ''}`).includes(nq) || norm(contacts.pathLabel(c.id)).includes(nq)).slice(0, 60)
    : [];

  const renderTree = (parent: string | null) => {
    const list = contacts.children(parent);
    if (!list.length) return null;
    return (
      <ul>
        {list.map((c) => {
          const hasKids = contacts.list.some((x) => x.parent_id === c.id);
          const isOpen = expanded.has(c.id);
          return (
            <li key={c.id}>
              <div className={`org-node ${value === c.id ? 'active' : ''}`}>
                <button type="button" className="org-toggle" onClick={() => toggle(c.id)} disabled={!hasKids} aria-label={isOpen ? 'بستن' : 'باز کردن'}>
                  {hasKids ? (isOpen ? '▾' : '◂') : '•'}
                </button>
                <button type="button" className="org-label" onClick={() => pick(c.id)}>
                  {c.kind === 'position' ? contactName(c) : <strong>{c.name}</strong>} <span className="small muted">{CONTACT_KIND[c.kind]}</span>
                </button>
              </div>
              {isOpen && renderTree(c.id)}
            </li>
          );
        })}
      </ul>
    );
  };

  const selected = value ? contacts.byId.get(value) : undefined;
  const addParent = selected ? (selected.kind === 'position' ? selected.parent_id : selected.id) : null;
  return (
    <div className="contact-picker" ref={box}>
      <button type="button" className="input contact-picker-value" onClick={() => setOpen(!open)} aria-expanded={open}>
        {selected ? contacts.pathLabel(selected.id) : <span className="muted">{value && contacts.loading ? '…' : placeholder}</span>}
        <span className="muted">▾</span>
      </button>
      {open && (
        <div className="contact-picker-panel">
          <input className="input" autoFocus placeholder="جستجوی سازمان، واحد، سمت یا نام شخص…" value={q} onChange={(e) => setQ(e.target.value)} />
          <div className="contact-picker-list org-tree">
            {nq ? (
              matches.length ? (
                <ul>
                  {matches.map((c) => (
                    <li key={c.id}>
                      <button type="button" className="org-label" onClick={() => pick(c.id)}>
                        {contacts.pathLabel(c.id)} <span className="small muted">{CONTACT_KIND[c.kind]}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="small muted">موردی یافت نشد.</p>
              )
            ) : contacts.list.length ? (
              renderTree(null)
            ) : (
              <p className="small muted">هنوز مخاطبی تعریف نشده است.</p>
            )}
          </div>
          <div className="row between gap wrap">
            {value ? (
              <Button type="button" size="sm" variant="ghost" onClick={() => pick('')}>
                پاک کردن انتخاب
              </Button>
            ) : (
              <span />
            )}
            {can('contacts.manage') ? (
              <Button
                type="button"
                size="sm"
                variant="secondary"
                onClick={() => setAdding(addParent ? { parent_id: addParent, kind: 'position', name: q } : { parent_id: null, kind: 'organization', name: q })}
              >
                + مخاطب جدید
              </Button>
            ) : (
              <span className="small muted">مخاطب جدید را دبیرخانه تعریف می‌کند.</span>
            )}
          </div>
        </div>
      )}
      {adding &&
        createPortal(
          <ContactModal
            contact={adding}
            contacts={contacts}
            onClose={() => setAdding(null)}
            onDone={async (c) => {
              setAdding(null);
              await contacts.reload();
              pick(c.id);
            }}
          />,
          document.body,
        )}
    </div>
  );
}

/** Create or edit one contact; the parent list follows the kind rules (organisations at the root, positions as leaves). */
export function ContactModal({
  contact,
  contacts,
  onClose,
  onDone,
}: {
  contact: Partial<Contact>;
  contacts: ReturnType<typeof useContacts>;
  onClose: () => void;
  onDone: (c: Contact) => Promise<void>;
}) {
  const [f, setF] = useState({
    kind: (contact.kind ?? 'organization') as ContactKind,
    parentId: contact.parent_id ?? '',
    name: contact.name ?? '',
    personName: contact.person_name ?? '',
    phone: contact.phone ?? '',
    email: contact.email ?? '',
    address: contact.address ?? '',
    notes: contact.notes ?? '',
    isActive: contact.is_active ?? true,
  });
  const act = useAction();
  // Not under itself or its own subtree.
  const blocked = new Set<string>(contact.id ? [contact.id] : []);
  for (const c of contacts.tree) if (c.parent_id && blocked.has(c.parent_id)) blocked.add(c.id);
  const parents = contacts.tree.filter((c) => c.kind !== 'position' && !blocked.has(c.id));
  const save = () =>
    act.run(async () => {
      const body = { ...f, parentId: f.kind === 'organization' ? null : f.parentId || null, personName: f.kind === 'position' ? f.personName : null };
      const { kind: _kind, ...rest } = body;
      const saved = contact.id ? await patch<Contact>(`/contacts/${contact.id}`, rest) : await post<Contact>('/contacts', body);
      await onDone(saved);
    });
  return (
    <Modal
      title={contact.id ? 'ویرایش مخاطب' : 'مخاطب جدید'}
      onClose={onClose}
      footer={
        <Button type="button" busy={act.busy} onClick={save}>
          ذخیره
        </Button>
      }
    >
      <ErrorBox error={act.error} />
      <Field label="نوع">
        <select className="input" value={f.kind} disabled={!!contact.id} onChange={(e) => setF({ ...f, kind: e.target.value as ContactKind })}>
          {Object.entries(CONTACT_KIND).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
      </Field>
      {f.kind !== 'organization' && (
        <Field label="زیرمجموعه">
          <select className="input" value={f.parentId} onChange={(e) => setF({ ...f, parentId: e.target.value })}>
            <option value="">انتخاب سازمان یا واحد…</option>
            {parents.map((c) => (
              <option key={c.id} value={c.id}>
                {'  '.repeat(c.depth)}
                {c.name}
              </option>
            ))}
          </select>
        </Field>
      )}
      <Field
        label={f.kind === 'position' ? 'عنوان سمت' : f.kind === 'unit' ? 'نام واحد' : 'نام سازمان'}
        hint={f.kind === 'position' ? 'مثلاً «مدیرکل محترم دفتر امور فنی»' : undefined}
      >
        <input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} autoFocus />
      </Field>
      {f.kind === 'position' && (
        <Field label="نام شخص (اختیاری)" hint="مثلاً «جناب آقای …»؛ با تغییر متصدی فقط همین را ویرایش کنید">
          <input className="input" value={f.personName} onChange={(e) => setF({ ...f, personName: e.target.value })} />
        </Field>
      )}
      <div className="grid grid-2">
        <Field label="تلفن">
          <input className="input ltr" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} />
        </Field>
        <Field label="ایمیل">
          <input className="input ltr" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} />
        </Field>
      </div>
      <Field label="نشانی">
        <input className="input" value={f.address} onChange={(e) => setF({ ...f, address: e.target.value })} />
      </Field>
      <Field label="یادداشت">
        <textarea className="input" rows={2} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} />
      </Field>
      {contact.id && (
        <label className="check">
          <input type="checkbox" checked={f.isActive} onChange={(e) => setF({ ...f, isActive: e.target.checked })} />
          فعال (مخاطب غیرفعال در انتخاب نامه‌ها نمی‌آید)
        </label>
      )}
    </Modal>
  );
}
