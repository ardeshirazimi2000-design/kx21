import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { CONFIDENTIALITY } from '../components/labels';
import { UnitSelect } from '../components/pickers';
import { Badge, Button, Card, Empty, ErrorBox, Field, Loading, Modal, PageHeader, Pager, Tabs, dateFa, dateTimeFa, fa } from '../components/ui';
import { download, patch, post, upload } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useAction, useApi } from '../lib/hooks';
import { ReasonModal } from './LetterDetail';

const POLICY_ACTION: Record<string, string> = { destroy: 'امحا', review: 'بازبینی', permanent: 'دائمی' };

interface Folder {
  id: string;
  parent_id: string | null;
  name: string;
  code: string | null;
  unit_name: string | null;
  policy_name: string | null;
  document_count: string;
}

function FolderTree({ folders, parent, value, onPick }: { folders: Folder[]; parent: string | null; value: string; onPick: (id: string) => void }) {
  const kids = folders.filter((f) => f.parent_id === parent);
  if (!kids.length) return null;
  return (
    <ul className="tree">
      {kids.map((f) => (
        <li key={f.id}>
          <button className={value === f.id ? 'active' : ''} onClick={() => onPick(f.id)}>
            📁 {f.name} {Number(f.document_count) ? <span className="small muted">({fa(f.document_count)})</span> : null}
          </button>
          <FolderTree folders={folders} parent={f.id} value={value} onPick={onPick} />
        </li>
      ))}
    </ul>
  );
}

export function ArchivePage() {
  const { can } = useAuth();
  const [sp, setSp] = useSearchParams();
  const [tab, setTab] = useState<'docs' | 'due' | 'policies'>('docs');
  const folders = useApi<Folder[]>('/archive/folders');
  const [folderId, setFolderId] = useState('');
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const docId = sp.get('doc');
  const qs = new URLSearchParams({ page: String(page), ...(folderId ? { folderId } : {}), ...(q ? { q } : {}), ...(tab === 'due' ? { due: 'true' } : {}) }).toString();
  const docs = useApi<{ items: any[]; total: number; page: number; pageSize: number }>(tab === 'policies' ? null : `/archive/documents?${qs}`, [qs]);
  const [modal, setModal] = useState<null | 'folder' | 'doc'>(null);
  const folder = folders.data?.find((f) => f.id === folderId);
  return (
    <>
      <PageHeader
        title="بایگانی الکترونیکی"
        subtitle="ساختار درختی پرونده‌ها، نسخه‌بندی اسناد، امضای دیجیتال و سیاست‌های نگهداری و امحا"
        actions={
          can('archive.manage') && (
            <>
              <Button variant="secondary" onClick={() => setModal('folder')}>
                پرونده جدید
              </Button>
              <Button onClick={() => setModal('doc')}>سند جدید</Button>
            </>
          )
        }
      />
      <Tabs
        value={tab}
        onChange={(t) => (setTab(t), setPage(1))}
        tabs={[
          { id: 'docs', label: 'اسناد' },
          { id: 'due', label: 'موعد نگهداری گذشته' },
          { id: 'policies', label: 'سیاست‌های نگهداری' },
        ]}
      />
      {tab === 'policies' ? (
        <Policies />
      ) : (
        <div className="grid" style={{ gridTemplateColumns: 'minmax(220px, 1fr) 3fr' }}>
          <Card title="پرونده‌ها">
            <ul className="tree">
              <li>
                <button className={!folderId ? 'active' : ''} onClick={() => setFolderId('')}>
                  همه پرونده‌ها
                </button>
              </li>
            </ul>
            {folders.data && <FolderTree folders={folders.data} parent={null} value={folderId} onPick={(id) => (setFolderId(id), setPage(1))} />}
          </Card>
          <Card title={folder ? `${folder.name}${folder.policy_name ? ` — سیاست: ${folder.policy_name}` : ''}` : 'اسناد'}>
            <input className="input mb" placeholder="جستجوی عنوان، توضیح یا شماره نامه…" onKeyDown={(e) => e.key === 'Enter' && (setQ((e.target as HTMLInputElement).value.trim()), setPage(1))} />
            {docs.loading && !docs.data ? (
              <Loading />
            ) : !docs.data?.items.length ? (
              <Empty>سندی یافت نشد.</Empty>
            ) : (
              <>
                <table className="table">
                  <thead>
                    <tr>
                      <th>عنوان</th>
                      <th>پرونده</th>
                      <th>نسخه‌ها</th>
                      <th>نگهداری تا</th>
                      <th>وضعیت</th>
                    </tr>
                  </thead>
                  <tbody>
                    {docs.data.items.map((d) => (
                      <tr key={d.id} className="clickable" onClick={() => setSp({ doc: d.id })}>
                        <td>
                          {d.title}
                          {d.letter_number && <div className="small muted">نامه {d.letter_number}</div>}
                        </td>
                        <td className="small">{d.folder_name}</td>
                        <td>{fa(d.version_count)}</td>
                        <td className="small">
                          {d.retention_until ? dateFa(d.retention_until) : 'دائمی'} {d.policy_action && <span className="muted">({POLICY_ACTION[d.policy_action]})</span>}
                        </td>
                        <td>
                          {d.status === 'disposed' ? <Badge tone="neutral">امحاشده</Badge> : d.legal_hold ? <Badge tone="danger">توقیف قانونی</Badge> : <Badge tone="success">فعال</Badge>}
                          {d.confidentiality > 0 && <Badge tone="danger">{CONFIDENTIALITY[d.confidentiality]}</Badge>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <Pager page={docs.data.page} pageSize={docs.data.pageSize} total={Number(docs.data.total)} onPage={setPage} />
              </>
            )}
          </Card>
        </div>
      )}
      {docId && <DocumentModal id={docId} onClose={() => (setSp({}), void docs.reload())} />}
      {modal === 'folder' && <FolderModal folders={folders.data ?? []} parentId={folderId} onClose={() => setModal(null)} onDone={async () => (setModal(null), await folders.reload())} />}
      {modal === 'doc' && <NewDocumentModal folders={folders.data ?? []} folderId={folderId} onClose={() => setModal(null)} onDone={async (id) => (setModal(null), await docs.reload(), setSp({ doc: id }))} />}
    </>
  );
}

function Policies() {
  const { can } = useAuth();
  const r = useApi<any[]>('/archive/policies');
  const [f, setF] = useState({ name: '', retainYears: 5, action: 'destroy', description: '' });
  const act = useAction();
  return (
    <Card title="سیاست‌های نگهداری و امحا">
      <ErrorBox error={act.error} />
      <table className="table">
        <thead>
          <tr>
            <th>عنوان</th>
            <th>مدت نگهداری</th>
            <th>اقدام پس از موعد</th>
            <th>توضیح</th>
          </tr>
        </thead>
        <tbody>
          {(r.data ?? []).map((p) => (
            <tr key={p.id}>
              <td>{p.name}</td>
              <td>{p.action === 'permanent' ? 'دائمی' : `${fa(p.retain_years)} سال`}</td>
              <td>{POLICY_ACTION[p.action]}</td>
              <td className="small">{p.description}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {can('archive.dispose') && (
        <div className="row gap wrap mt" style={{ alignItems: 'flex-end' }}>
          <Field label="عنوان">
            <input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
          </Field>
          <Field label="سال">
            <input className="input" type="number" min={0} value={f.retainYears} onChange={(e) => setF({ ...f, retainYears: Number(e.target.value) })} />
          </Field>
          <Field label="اقدام">
            <select className="input" value={f.action} onChange={(e) => setF({ ...f, action: e.target.value })}>
              {Object.entries(POLICY_ACTION).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
          </Field>
          <Button busy={act.busy} onClick={() => act.run(async () => (await post('/archive/policies', { ...f, description: f.description || null }), await r.reload()))}>
            افزودن سیاست
          </Button>
        </div>
      )}
    </Card>
  );
}

function FolderModal({ folders, parentId, onClose, onDone }: { folders: Folder[]; parentId: string; onClose: () => void; onDone: () => Promise<void> }) {
  const policies = useApi<any[]>('/archive/policies');
  const [f, setF] = useState({ name: '', code: '', parentId, unitId: '', retentionPolicyId: '' });
  const act = useAction();
  return (
    <Modal
      title="پرونده جدید"
      onClose={onClose}
      footer={
        <Button
          busy={act.busy}
          onClick={() =>
            act.run(async () => {
              await post('/archive/folders', { name: f.name, code: f.code || null, parentId: f.parentId || null, unitId: f.unitId || null, retentionPolicyId: f.retentionPolicyId || null });
              await onDone();
            })
          }
        >
          ایجاد
        </Button>
      }
    >
      <ErrorBox error={act.error} />
      <Field label="نام پرونده">
        <input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
      </Field>
      <Field label="کد بایگانی">
        <input className="input ltr" value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} />
      </Field>
      <Field label="زیرمجموعه">
        <select className="input" value={f.parentId} onChange={(e) => setF({ ...f, parentId: e.target.value })}>
          <option value="">ریشه</option>
          {folders.map((x) => (
            <option key={x.id} value={x.id}>
              {x.name}
            </option>
          ))}
        </select>
      </Field>
      <Field label="واحد مالک" hint="دسترسی خواندن بر اساس واحد اعمال می‌شود">
        <UnitSelect value={f.unitId} onChange={(v) => setF({ ...f, unitId: v })} />
      </Field>
      <Field label="سیاست نگهداری" hint="در صورت خالی بودن از پرونده بالادستی گرفته می‌شود">
        <select className="input" value={f.retentionPolicyId} onChange={(e) => setF({ ...f, retentionPolicyId: e.target.value })}>
          <option value="">ارث‌بری</option>
          {(policies.data ?? []).map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </Field>
    </Modal>
  );
}

function NewDocumentModal({ folders, folderId, onClose, onDone }: { folders: Folder[]; folderId: string; onClose: () => void; onDone: (id: string) => Promise<void> }) {
  const { me } = useAuth();
  const [f, setF] = useState({ folderId, title: '', description: '', docType: 'general', confidentiality: '0' });
  const [file, setFile] = useState<File | null>(null);
  const act = useAction();
  return (
    <Modal
      title="سند جدید"
      onClose={onClose}
      footer={
        <Button busy={act.busy} disabled={!f.folderId || f.title.length < 2} onClick={() => act.run(async () => onDone((await upload('/archive/documents', f, file)).id))}>
          ذخیره
        </Button>
      }
    >
      <ErrorBox error={act.error} />
      <Field label="پرونده">
        <select className="input" value={f.folderId} onChange={(e) => setF({ ...f, folderId: e.target.value })}>
          <option value="">انتخاب کنید…</option>
          {folders.map((x) => (
            <option key={x.id} value={x.id}>
              {x.name}
            </option>
          ))}
        </select>
      </Field>
      <Field label="عنوان">
        <input className="input" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} />
      </Field>
      <Field label="نوع سند">
        <select className="input" value={f.docType} onChange={(e) => setF({ ...f, docType: e.target.value })}>
          {[['general', 'عمومی'], ['contract', 'قرارداد'], ['minutes', 'صورتجلسه'], ['report', 'گزارش'], ['letter', 'مکاتبه'], ['financial', 'مالی']].map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
      </Field>
      <Field label="طبقه‌بندی">
        <select className="input" value={f.confidentiality} onChange={(e) => setF({ ...f, confidentiality: e.target.value })}>
          {CONFIDENTIALITY.map((l, i) => (
            <option key={i} value={i} disabled={i > me!.clearance}>
              {l}
            </option>
          ))}
        </select>
      </Field>
      <Field label="توضیح">
        <textarea className="input" rows={2} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} />
      </Field>
      <Field label="فایل">
        <input type="file" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
      </Field>
    </Modal>
  );
}

function DocumentModal({ id, onClose }: { id: string; onClose: () => void }) {
  const r = useApi<any>(`/archive/documents/${id}`, [id]);
  const act = useAction();
  const [dispose, setDispose] = useState(false);
  const [note, setNote] = useState('');
  useEffect(() => setNote(''), [id]);
  const d = r.data;
  return (
    <Modal title={d?.title ?? 'سند'} onClose={onClose} wide>
      {!d ? (
        <Loading />
      ) : (
        <>
          <ErrorBox error={act.error} />
          <dl className="kv mb">
            <dt>وضعیت</dt>
            <dd>{d.status === 'disposed' ? `امحاشده در ${dateTimeFa(d.disposed_at)} — ${d.disposal_reason ?? ''}` : d.legal_hold ? 'توقیف قانونی (غیرقابل امحا)' : 'فعال'}</dd>
            <dt>سیاست نگهداری</dt>
            <dd>
              {d.policy?.name ?? '—'} {d.retention_until && `— تا ${dateFa(d.retention_until)}`}
            </dd>
            {d.letter && (
              <>
                <dt>نامه</dt>
                <dd>
                  <Link to={`/letters/${d.letter.id}`}>
                    {d.letter.number} — {d.letter.subject}
                  </Link>
                </dd>
              </>
            )}
            {d.description && (
              <>
                <dt>توضیح</dt>
                <dd>{d.description}</dd>
              </>
            )}
          </dl>
          <h3>نسخه‌ها</h3>
          {!d.versions.length ? (
            <Empty>فایلی ندارد.</Empty>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>نسخه</th>
                  <th>فایل</th>
                  <th>ثبت</th>
                  <th>امضا</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {d.versions.map((v: any) => {
                  const sigs = d.signatures.filter((s: any) => s.version === v.version);
                  return (
                    <tr key={v.id}>
                      <td>{fa(v.version)}</td>
                      <td>
                        {v.file_name}
                        {v.note && <div className="small muted">{v.note}</div>}
                      </td>
                      <td className="small">
                        {v.created_by_name} — {dateTimeFa(v.created_at)}
                      </td>
                      <td>
                        {sigs.map((s: any) => (
                          <div key={s.id} className="small">
                            {s.full_name} {s.valid && s.intact ? <Badge tone="success">معتبر</Badge> : <Badge tone="danger">نامعتبر</Badge>}
                          </div>
                        ))}
                      </td>
                      <td className="row gap-sm">
                        {v.available && (
                          <Button variant="ghost" size="sm" onClick={() => void download(`/archive/versions/${v.id}/download`, v.file_name)}>
                            دریافت
                          </Button>
                        )}
                        {v.available && d.status === 'active' && (
                          <Button variant="ghost" size="sm" busy={act.busy} onClick={() => act.run(async () => (await post(`/archive/versions/${v.id}/sign`), await r.reload()))}>
                            امضا
                          </Button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
          {d.status === 'active' && d.canManage && (
            <div className="row gap wrap mt" style={{ alignItems: 'flex-end' }}>
              <Field label="یادداشت نسخه جدید">
                <input className="input" value={note} onChange={(e) => setNote(e.target.value)} />
              </Field>
              <label className="btn btn-secondary">
                بارگذاری نسخه جدید
                <input type="file" hidden onChange={(e) => e.target.files?.[0] && act.run(async () => (await upload(`/archive/documents/${id}/versions`, { note }, e.target.files![0]), setNote(''), await r.reload()))} />
              </label>
              {d.canDispose && (
                <>
                  <Button variant="secondary" busy={act.busy} onClick={() => act.run(async () => (await patch(`/archive/documents/${id}`, { legalHold: !d.legal_hold }), await r.reload()))}>
                    {d.legal_hold ? 'رفع توقیف قانونی' : 'توقیف قانونی'}
                  </Button>
                  <Button variant="danger" disabled={d.legal_hold} onClick={() => setDispose(true)}>
                    امحا
                  </Button>
                </>
              )}
            </div>
          )}
          {dispose && (
            <ReasonModal
              title="امحای سند"
              label="علت و مستند امحا (صورتجلسه کمیسیون امحا)"
              danger
              onClose={() => setDispose(false)}
              onSubmit={async (reason) => {
                const due = !d.retention_until || new Date(d.retention_until) <= new Date();
                const force = !due && confirm('موعد نگهداری این سند نرسیده است. امحای پیش از موعد ثبت شود؟');
                if (!due && !force) return;
                await post(`/archive/documents/${id}/dispose`, { reason, force });
                setDispose(false);
                await r.reload();
              }}
            />
          )}
        </>
      )}
    </Modal>
  );
}

