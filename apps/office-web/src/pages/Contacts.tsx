import { useState } from 'react';
import { Link } from 'react-router-dom';
import { CONTACT_KIND, ContactModal, contactName, useContacts, type Contact } from '../components/contacts';
import { Badge, Button, Card, Empty, ErrorBox, Loading, PageHeader, fa } from '../components/ui';
import { del } from '../lib/api';
import { useAction } from '../lib/hooks';

const norm = (t: string) => t.replace(/[يى]/g, 'ی').replace(/ك/g, 'ک').replace(/‌/g, ' ').trim().toLowerCase();

/** «مخاطبین بیرونی»: organisations, their units and positions that letters are received from and sent to. */
export function ContactsPage() {
  const contacts = useContacts(true);
  const [sel, setSel] = useState('');
  const [q, setQ] = useState('');
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [modal, setModal] = useState<Partial<Contact> | null>(null);
  const act = useAction();
  if (contacts.loading && !contacts.data) return <Loading />;
  const c = contacts.byId.get(sel);
  const nq = norm(q);
  // While searching, show the matches with the branches that lead to them.
  const visible = new Set<string>();
  if (nq) for (const x of contacts.list) if (norm(`${x.name} ${x.person_name ?? ''}`).includes(nq)) for (const a of contacts.ancestors(x.id)) visible.add(a.id);
  const toggle = (id: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const renderTree = (parent: string | null) => {
    const list = contacts.children(parent).filter((x) => !nq || visible.has(x.id));
    if (!list.length) return null;
    return (
      <ul>
        {list.map((x) => {
          const hasKids = contacts.list.some((k) => k.parent_id === x.id);
          const open = nq ? true : !collapsed.has(x.id);
          return (
            <li key={x.id}>
              <div className={`org-node ${sel === x.id ? 'active' : ''} ${x.is_active ? '' : 'inactive'}`}>
                <button type="button" className="org-toggle" onClick={() => toggle(x.id)} disabled={!hasKids} aria-label={open ? 'بستن' : 'باز کردن'}>
                  {hasKids ? (open ? '▾' : '◂') : '•'}
                </button>
                <button type="button" className="org-label" onClick={() => setSel(x.id)}>
                  {x.kind === 'position' ? contactName(x) : <strong>{x.name}</strong>} <span className="small muted">{CONTACT_KIND[x.kind]}</span>{' '}
                  {!x.is_active && <Badge>غیرفعال</Badge>}
                </button>
              </div>
              {open && renderTree(x.id)}
            </li>
          );
        })}
      </ul>
    );
  };

  const done = async (saved: Contact) => {
    setModal(null);
    await contacts.reload();
    setSel(saved.id);
  };
  const remove = (x: Contact) =>
    act.run(async () => {
      if (!confirm(`«${contactName(x)}» حذف شود؟`)) return;
      await del(`/contacts/${x.id}`);
      setSel('');
      await contacts.reload();
    });

  return (
    <>
      <PageHeader
        title="مخاطبین بیرونی"
        subtitle="سازمان‌ها، واحدها و سمت‌هایی که نامه وارده از آن‌ها می‌رسد و نامه صادره به آن‌ها فرستاده می‌شود"
        actions={<Button onClick={() => setModal({ kind: 'organization', parent_id: null })}>سازمان جدید</Button>}
      />
      <Card>
        <div className="row between wrap gap mb">
          <input
            className="input grow"
            style={{ maxWidth: 420 }}
            placeholder="جستجوی سازمان، واحد، سمت یا نام شخص…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <div className="row gap">
            <Button size="sm" variant="ghost" onClick={() => setCollapsed(new Set())}>
              باز کردن همه
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setCollapsed(new Set(contacts.list.map((x) => x.id)))}>
              بستن همه
            </Button>
          </div>
        </div>
        {!contacts.list.length ? (
          <Empty>هنوز مخاطبی تعریف نشده است.</Empty>
        ) : nq && !visible.size ? (
          <Empty>موردی یافت نشد.</Empty>
        ) : (
          <div className="org-tree">{renderTree(null)}</div>
        )}
      </Card>
      {c && (
        <Card
          className="mt"
          title={contacts.pathLabel(c.id)}
          actions={
            <>
              <Button variant="secondary" size="sm" onClick={() => setModal(c)}>
                ویرایش
              </Button>
              {c.kind !== 'position' && (
                <>
                  <Button variant="secondary" size="sm" onClick={() => setModal({ kind: 'unit', parent_id: c.id })}>
                    زیرواحد جدید
                  </Button>
                  <Button size="sm" onClick={() => setModal({ kind: 'position', parent_id: c.id })}>
                    سمت / شخص جدید
                  </Button>
                </>
              )}
            </>
          }
        >
          <ErrorBox error={act.error} />
          <p className="muted">
            نوع: {CONTACT_KIND[c.kind]} · {c.is_active ? 'فعال' : 'غیرفعال'} · نامه‌های ثبت‌شده با همین مخاطب: {fa(c.letter_count)}
          </p>
          <table className="table">
            <tbody>
              {c.kind === 'position' && (
                <tr>
                  <th>نام شخص</th>
                  <td>{c.person_name ?? '—'}</td>
                </tr>
              )}
              <tr>
                <th>تلفن</th>
                <td className="ltr">{c.phone ?? '—'}</td>
              </tr>
              <tr>
                <th>ایمیل</th>
                <td className="ltr">{c.email ?? '—'}</td>
              </tr>
              <tr>
                <th>نشانی</th>
                <td>{c.address ?? '—'}</td>
              </tr>
              {c.notes && (
                <tr>
                  <th>یادداشت</th>
                  <td>{c.notes}</td>
                </tr>
              )}
            </tbody>
          </table>
          <div className="row gap mt">
            <Link className="btn btn-ghost btn-sm" to={`/letters?contactId=${c.id}`}>
              نامه‌های این مخاطب {c.kind !== 'position' && 'و زیرمجموعه‌ها'}
            </Link>
            <Button variant="danger" size="sm" busy={act.busy} onClick={() => remove(c)}>
              حذف
            </Button>
          </div>
          <p className="small muted mt">مخاطبی که در نامه‌ها استفاده شده حذف نمی‌شود؛ آن را غیرفعال کنید تا در انتخاب نامه‌های جدید نیاید.</p>
        </Card>
      )}
      {modal && <ContactModal contact={modal} contacts={contacts} onClose={() => setModal(null)} onDone={done} />}
    </>
  );
}
