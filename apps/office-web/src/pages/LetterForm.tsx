import { useEffect, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { LetterEditor } from '../components/editor';
import { AttachmentPicker, PickedList, type PickedFile } from '../components/capture';
import { ContactPicker, useContacts } from '../components/contacts';
import { CONFIDENTIALITY, KIND, PRIORITY } from '../components/labels';
import { LetterPaper, type LetterTemplate } from '../components/letterPaper';
import { PositionSelect, UnitSelect, UserSelect, useOrg } from '../components/pickers';
import { Button, Card, ErrorBox, Field, JalaliDateInput, Loading, PageHeader, Tabs } from '../components/ui';
import { get, patch, post, upload } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useAction, useApi } from '../lib/hooks';

type Recipient = { userId?: string; positionId?: string; unitId?: string; kind: 'to' | 'cc'; label: string; note?: string };
type ExternalCopy = { contactId?: string; label: string; note?: string };

/** Usual lines after a name in a copy list. */
const NOTES = ['جهت اطلاع', 'جهت استحضار', 'جهت اقدام', 'جهت بررسی و اعلام نظر', 'جهت پیگیری', 'جهت درج در پرونده'];
const NEW_KINDS = [
  { id: 'internal', label: 'نامه داخلی' },
  { id: 'outgoing', label: 'نامه صادره' },
  { id: 'incoming', label: 'ثبت نامه وارده' },
] as const;

const empty = {
  kind: 'internal' as 'incoming' | 'outgoing' | 'internal',
  subject: '',
  body: '',
  summary: '',
  externalOrg: '',
  externalParty: '',
  contactId: '',
  externalNumber: '',
  externalDate: '',
  deliveryMethod: '',
  priority: 'normal',
  confidentiality: 0,
  ownerUnitId: '',
  dueDate: '',
  source: 'manual',
};

const escapeHtml = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
/** A plain-text body moved into the editor keeps its lines as paragraphs. */
const textToHtml = (t: string) => (t ? t.split('\n').map((line) => `<p>${escapeHtml(line)}</p>`).join('') : '');

export function LetterFormPage() {
  const { id } = useParams();
  const [sp] = useSearchParams();
  const nav = useNavigate();
  const { me, can } = useAuth();
  const org = useOrg();
  const contacts = useContacts();
  const [loadedContact, setLoadedContact] = useState('');
  const workflows = useApi<any[]>(can('workflow.start') ? '/workflows' : null);
  const [f, setF] = useState({ ...empty, kind: (sp.get('kind') as typeof empty.kind) ?? (sp.get('to') || !can('letter.register_incoming') ? 'internal' : 'incoming') });
  const [recipients, setRecipients] = useState<Recipient[]>(() => {
    // From the org chart: «نامه به این شخص / واحد».
    const [type, value] = (sp.get('to') ?? '').split(':');
    if (!value || !['user', 'position', 'unit'].includes(type)) return [];
    return [{ [`${type}Id`]: value, kind: 'to', label: sp.get('toLabel') ?? '' } as Recipient];
  });
  const [copies, setCopies] = useState<ExternalCopy[]>([]);
  const [files, setFiles] = useState<PickedFile[]>([]);
  const [register, setRegister] = useState(false);
  const [workflow, setWorkflow] = useState('');
  const [replyTo, setReplyTo] = useState<any>(null);
  const [loaded, setLoaded] = useState(!id);
  const templates = useApi<LetterTemplate[]>('/letter-templates');
  const [templateId, setTemplateId] = useState<string | null>(null);
  const [signer, setSigner] = useState<{ mode: 'me' | 'other' | 'none'; id: string; name: string; position?: string | null }>(() =>
    can('letter.sign') ? { mode: 'me', id: me!.id, name: me!.full_name, position: me!.positions[0]?.title } : { mode: 'other', id: '', name: '' },
  );
  const [registeredNumber, setRegisteredNumber] = useState<{ number: string | null; date: string | null }>({ number: null, date: null });
  const act = useAction();
  const set = (k: keyof typeof empty, v: any) => setF((x) => ({ ...x, [k]: v }));
  // Only an internal letter has «گیرنده» inside the organisation; on other kinds they become copies.
  const setKind = (k: typeof empty.kind) => {
    set('kind', k);
    if (k !== 'internal') setRecipients((rs) => rs.map((r) => ({ ...r, kind: 'cc' })));
  };

  useEffect(() => {
    if (!id) return;
    void get(`/letters/${id}`).then((l) => {
      const html = l.kind !== 'incoming';
      setF({
        kind: l.kind, subject: l.subject, body: html && l.body_format !== 'html' ? textToHtml(l.body ?? '') : l.body ?? '', summary: l.summary ?? '', externalOrg: l.external_org ?? '', externalParty: l.external_party ?? '',
        contactId: l.contact_id ?? '', externalNumber: l.external_number ?? '', externalDate: l.external_date?.slice(0, 10) ?? '', deliveryMethod: l.delivery_method ?? '', priority: l.priority,
        confidentiality: l.confidentiality, ownerUnitId: l.owner_unit_id ?? '', dueDate: l.due_date?.slice(0, 10) ?? '', source: l.source,
      });
      setRecipients(
        l.recipients.map((r: any) => ({
          userId: r.user_id ?? undefined, positionId: r.position_id ?? undefined, unitId: r.unit_id ?? undefined, kind: r.kind, note: r.note ?? '',
          label: r.user_name ?? (r.position_title ? `${r.position_title} — ${r.position_unit}` : r.unit_name),
        })),
      );
      setCopies((l.externalCopies ?? []).map((x: any) => ({ contactId: x.contact_id ?? undefined, label: x.label, note: x.note ?? '' })));
      setLoadedContact(l.contact_id ?? '');
      setTemplateId(l.template_id ?? '');
      setRegisteredNumber({ number: l.number, date: l.registered_at });
      if (l.signatory_id) setSigner({ mode: l.signatory_id === me!.id ? 'me' : 'other', id: l.signatory_id, name: l.signatory_name, position: l.signatory_position });
      else setSigner({ mode: 'none', id: '', name: '' });
      setLoaded(true);
    });
  }, [id, me]);

  // A new letter starts on the default letterhead for its kind, with the template's opening text.
  const usable = (templates.data ?? []).filter((t) => t.kinds.includes(f.kind) && (!t.unit_id || !f.ownerUnitId || t.unit_id === f.ownerUnitId));
  useEffect(() => {
    if (id || templateId !== null || !templates.data) return;
    const t = usable.find((x) => x.is_default) ?? usable[0];
    setTemplateId(t?.id ?? '');
    if (t?.body_html) setF((x) => (x.body ? x : { ...x, body: t.body_html! }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [templates.data, id, templateId]);
  // Another kind or unit may rule the chosen letterhead out.
  useEffect(() => {
    if (!templateId || !templates.data || usable.some((t) => t.id === templateId)) return;
    setTemplateId((usable.find((x) => x.is_default) ?? usable[0])?.id ?? '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [f.kind, f.ownerUnitId, templates.data]);

  useEffect(() => {
    const rt = sp.get('replyTo');
    if (!rt || id) return;
    void get(`/letters/${rt}`).then((l) => {
      setReplyTo(l);
      setF((x) => ({
        ...x,
        kind: l.kind === 'incoming' ? 'outgoing' : 'internal',
        subject: `پاسخ: ${l.subject}`.slice(0, 500),
        externalOrg: l.external_org ?? '',
        externalParty: l.external_party ?? '',
        contactId: l.contact_id ?? '',
        ownerUnitId: l.owner_unit_id ?? '',
      }));
    });
  }, [sp, id]);

  const [rType, setRType] = useState<'user' | 'position' | 'unit'>('user');
  const [rValue, setRValue] = useState('');
  const [rLabel, setRLabel] = useState('');
  const [rKind, setRKind] = useState<'to' | 'cc'>('to');
  const [rNote, setRNote] = useState('');
  const [xContact, setXContact] = useState('');
  const [xLabel, setXLabel] = useState('');
  const [xNote, setXNote] = useState('');

  if (!loaded) return <Loading />;
  const external = f.kind !== 'internal';
  // The sender / recipient as the letter will name it (the server composes the same texts from the contact).
  const picked = f.contactId ? contacts.ancestors(f.contactId) : [];
  const pickedSelf = picked[picked.length - 1];
  const party =
    pickedSelf
      ? { org: picked.filter((c) => c.kind !== 'position').map((c) => c.name).join(' — '), person: pickedSelf.kind === 'position' ? [pickedSelf.person_name, pickedSelf.name].filter(Boolean).join(' — ') : '' }
      : { org: f.externalOrg, person: f.externalParty };
  const legacyText = !f.contactId && (f.externalOrg || f.externalParty) ? [f.externalParty, f.externalOrg].filter(Boolean).join(' — ') : '';
  const rich = f.kind !== 'incoming';
  const template = usable.find((t) => t.id === templateId) ?? (templates.data ?? []).find((t) => t.id === templateId) ?? null;
  const chooseTemplate = (tid: string) => {
    const prev = template;
    const next = usable.find((t) => t.id === tid);
    setTemplateId(tid);
    // Swap the opening text only while the body is still the previous template's untouched text.
    if (next?.body_html && (!f.body || f.body === prev?.body_html)) set('body', next.body_html);
  };
  const canRegister = f.kind === 'incoming' ? can('letter.register_incoming') : f.kind === 'outgoing' ? can('letter.register_outgoing') : can('letter.create');
  const wfOptions = (workflows.data ?? []).filter((w) => w.is_active && w.applies_to.includes(f.kind) && w.key !== 'resolution-followup');

  const addRecipient = () => {
    if (!rValue) return;
    const label =
      rType === 'user'
        ? rLabel
        : rType === 'position'
          ? (() => {
              const p = org.positions.find((x) => x.id === rValue);
              return p ? `${p.title} — ${org.unitName(p.unit_id)}` : '';
            })()
          : org.unitName(rValue);
    const kind = f.kind === 'internal' ? rKind : 'cc';
    if (recipients.some((r) => r.kind === kind && (r.userId ?? r.positionId ?? r.unitId) === rValue)) return setRValue('');
    setRecipients([...recipients, { [`${rType}Id`]: rValue, kind, label, note: rNote } as Recipient]);
    setRValue('');
  };
  const addCopy = () => {
    const label = xContact ? contacts.pathLabel(xContact) : xLabel.trim();
    if (!label) return;
    setCopies([...copies, { contactId: xContact || undefined, label, note: xNote }]);
    setXContact('');
    setXLabel('');
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    void act.run(async () => {
      if (rich && signer.mode === 'other' && !signer.id) throw new Error('امضاکننده نامه را انتخاب کنید');
      if (external && !f.contactId && !legacyText) throw new Error(f.kind === 'incoming' ? 'فرستنده نامه را از مخاطبین انتخاب کنید' : 'گیرنده نامه را از مخاطبین انتخاب کنید');
      const payload = {
        subject: f.subject,
        body: f.body || null,
        ...(rich
          ? { bodyFormat: 'html', templateId: templateId || null, signatoryId: signer.mode === 'none' ? null : signer.id || null }
          : { bodyFormat: 'text' }),
        summary: f.summary || null,
        // A picked contact is sent as such; a letter typed before the directory keeps its text until a contact is picked.
        ...(external && f.contactId
          ? f.contactId !== loadedContact ? { contactId: f.contactId } : {}
          : {
              externalOrg: external ? f.externalOrg || null : null,
              externalParty: external ? f.externalParty || null : null,
              ...(loadedContact && !f.contactId ? { contactId: null } : {}),
            }),
        externalNumber: f.kind === 'incoming' ? f.externalNumber || null : null,
        externalDate: f.kind === 'incoming' ? f.externalDate || null : null,
        deliveryMethod: f.deliveryMethod || null,
        priority: f.priority,
        confidentiality: Number(f.confidentiality),
        ownerUnitId: f.ownerUnitId || null,
        dueDate: f.dueDate || null,
        recipients: recipients.map(({ label: _l, note, ...r }) => ({ ...r, kind: f.kind === 'internal' ? r.kind : 'cc', note: note || null })),
        ...(f.kind === 'outgoing' ? { externalCopies: copies.map((x) => ({ contactId: x.contactId ?? null, label: x.contactId ? null : x.label, note: x.note || null })) } : {}),
      };
      let letterId = id;
      if (id) await patch(`/letters/${id}`, payload);
      else {
        const l = await post('/letters', { ...payload, kind: f.kind, source: f.source, replyToId: replyTo?.id ?? null, register, workflow: workflow || null });
        letterId = l.id;
      }
      for (const x of files) await upload(`/letters/${letterId}/attachments`, { source: x.source === 'scan' || f.source === 'scan' ? 'scan' : 'upload' }, x.file);
      nav(`/letters/${letterId}`);
    });
  };

  return (
    <>
      <PageHeader title={id ? 'ویرایش نامه' : 'نامه جدید'} subtitle={replyTo ? `در پاسخ به نامه ${replyTo.number ?? ''} — ${replyTo.subject}` : undefined} />
      <form onSubmit={submit}>
        {!id && (
          <div className="kind-tabs">
            <Tabs value={f.kind} onChange={setKind} tabs={NEW_KINDS.filter((k) => k.id !== 'incoming' || can('letter.register_incoming')).map((k) => ({ ...k }))} />
          </div>
        )}
        <Card>
          <ErrorBox error={act.error} />
          <div className="grid grid-4">
            {id && (
              <Field label="نوع نامه">
                <select className="input" value={f.kind} disabled>
                  {Object.entries(KIND).map(([k, l]) => (
                    <option key={k} value={k}>
                      {l}
                    </option>
                  ))}
                </select>
              </Field>
            )}
            <Field label="اولویت">
              <select className="input" value={f.priority} onChange={(e) => set('priority', e.target.value)}>
                {Object.entries(PRIORITY).map(([k, [l]]) => (
                  <option key={k} value={k}>
                    {l}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="طبقه‌بندی" hint="سطح دسترسی مورد نیاز برای مشاهده">
              <select className="input" value={f.confidentiality} onChange={(e) => set('confidentiality', Number(e.target.value))}>
                {CONFIDENTIALITY.map((l, i) => (
                  <option key={i} value={i} disabled={i > me!.clearance}>
                    {l}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="واحد صاحب نامه">
              <UnitSelect value={f.ownerUnitId} onChange={(v) => set('ownerUnitId', v)} emptyLabel="واحد سازمانی من" />
            </Field>
          </div>
          <Field label="موضوع">
            <input className="input" value={f.subject} onChange={(e) => set('subject', e.target.value)} required minLength={3} maxLength={500} />
          </Field>
          {external && (
            <div className="grid grid-4">
              <div className="field span-2">
                <span className="field-label">{f.kind === 'incoming' ? 'فرستنده (سازمان، واحد یا سمت)' : 'گیرنده (سازمان، واحد یا سمت)'}</span>
                <ContactPicker value={f.contactId} onChange={(v) => set('contactId', v)} />
                {legacyText ? (
                  <span className="field-hint">ثبت‌شده به‌صورت متنی: «{legacyText}»؛ با انتخاب از مخاطبین جایگزین می‌شود.</span>
                ) : (
                  <span className="field-hint">از ساختار مخاطبین بیرونی انتخاب کنید؛ ساختار در «مکاتبات ← مخاطبین بیرونی» نگهداری می‌شود.</span>
                )}
              </div>
              {f.kind === 'incoming' && (
                <>
                  <Field label="شماره نامه فرستنده">
                    <input className="input" value={f.externalNumber} onChange={(e) => set('externalNumber', e.target.value)} />
                  </Field>
                  <Field label="تاریخ نامه فرستنده">
                    <JalaliDateInput value={f.externalDate} onChange={(v) => set('externalDate', v)} />
                  </Field>
                </>
              )}
              {f.kind === 'outgoing' && (
                <Field label="روش ارسال">
                  <select className="input" value={f.deliveryMethod} onChange={(e) => set('deliveryMethod', e.target.value)}>
                    <option value="">—</option>
                    {['پست', 'پیک', 'ایمیل', 'دورنگار', 'تحویل حضوری', 'سامانه دولت الکترونیک'].map((m) => (
                      <option key={m}>{m}</option>
                    ))}
                  </select>
                </Field>
              )}
            </div>
          )}
          {f.kind === 'incoming' && !id && (
            <Field label="روش دریافت">
              <select className="input" style={{ maxWidth: 240 }} value={f.source} onChange={(e) => set('source', e.target.value)}>
                <option value="manual">ثبت دستی</option>
                <option value="scan">اسکن</option>
                <option value="email">ایمیل</option>
              </select>
            </Field>
          )}
          {!rich && (
            <Field label="متن نامه">
              <textarea className="input" rows={12} value={f.body} onChange={(e) => set('body', e.target.value)} />
            </Field>
          )}
          {rich && (
            <div className="grid grid-2">
              <Field label="قالب و سربرگ" hint={can('templates.manage') ? 'قالب‌ها در «مکاتبات ← قالب‌های نامه» تعریف می‌شوند' : undefined}>
                <select className="input" value={templateId ?? ''} onChange={(e) => chooseTemplate(e.target.value)}>
                  <option value="">بدون سربرگ</option>
                  {usable.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                      {t.is_default ? ' (پیش‌فرض)' : ''}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="امضاکننده نامه" hint="فقط امضاکننده تعیین‌شده می‌تواند نامه را امضا کند">
                <div className="row gap wrap">
                  {can('letter.sign') && (
                    <label className="check">
                      <input type="radio" checked={signer.mode === 'me'} onChange={() => setSigner({ mode: 'me', id: me!.id, name: me!.full_name, position: me!.positions[0]?.title })} />
                      خودم امضا می‌کنم
                    </label>
                  )}
                  <label className="check">
                    <input type="radio" checked={signer.mode === 'other'} onChange={() => setSigner({ mode: 'other', id: '', name: '' })} />
                    {can('letter.sign') ? 'شخص دیگر' : 'تعیین امضاکننده'}
                  </label>
                  <label className="check">
                    <input type="radio" checked={signer.mode === 'none'} onChange={() => setSigner({ mode: 'none', id: '', name: '' })} />
                    بعداً در گردش کار
                  </label>
                </div>
                {signer.mode === 'other' && (
                  <UserSelect
                    value={signer.id}
                    placeholder="انتخاب امضاکننده…"
                    onChange={(v, u) => setSigner({ mode: 'other', id: v, name: u?.full_name ?? '', position: u?.positions?.split('،')[0]?.split(' — ')[0] ?? null })}
                  />
                )}
              </Field>
            </div>
          )}
          <div className="grid grid-2">
            <Field label="خلاصه / چکیده">
              <textarea className="input" rows={2} value={f.summary} onChange={(e) => set('summary', e.target.value)} />
            </Field>
            <Field label="مهلت پاسخ">
              <JalaliDateInput value={f.dueDate} onChange={(v) => set('dueDate', v)} />
            </Field>
          </div>
        </Card>

        {rich && (
          <Card title="متن نامه روی سربرگ" className="mt">
            <LetterEditor
              value={f.body}
              onChange={(v) => set('body', v)}
              frame={(content) => (
                <div className="paper-wrap">
                  <LetterPaper
                    editing
                    template={template}
                    letter={{
                      kind: f.kind,
                      number: registeredNumber.number,
                      date: registeredNumber.date,
                      hasAttachments: files.length > 0,
                      subject: f.subject,
                      to:
                        f.kind === 'internal'
                          ? recipients.some((r) => r.kind === 'to')
                            ? [`به: ${recipients.filter((r) => r.kind === 'to').map((r) => r.label).join('، ')}`]
                            : []
                          : [party.person, party.org].filter(Boolean),
                      cc: [
                        ...recipients.filter((r) => r.kind === 'cc').map((r) => (r.note ? `${r.label} ${r.note}` : r.label)),
                        ...(f.kind === 'outgoing' ? copies.map((x) => (x.note ? `${x.label} ${x.note}` : x.label)) : []),
                      ],
                      signatures: signer.name ? [{ key: 'signer', name: signer.name, position: signer.position }] : [],
                      watermark: 'پیش‌نویس',
                    }}
                  >
                    {content}
                  </LetterPaper>
                </div>
              )}
            />
            <p className="small muted mt">
              نامه همان‌طور که اینجا دیده می‌شود چاپ می‌شود. پس از امضا، تصویر نمونه امضای امضاکننده جای نام او قرار می‌گیرد و پس از امضا یا شماره شدن، نامه دیگر قابل ویرایش نیست.
            </p>
          </Card>
        )}

        <Card
          title={f.kind === 'internal' ? 'گیرندگان و رونوشت‌ها' : 'رونوشت داخلی'}
          className="mt"
        >
          {f.kind !== 'internal' && (
            <p className="small muted mb">
              {f.kind === 'outgoing'
                ? 'واحدها یا افرادی که رونوشت نامه را می‌گیرند؛ پس از ارسال نامه، رونوشت «جهت اطلاع» در کارتابل آن‌ها قرار می‌گیرد.'
                : 'واحدها یا افرادی که از نامه رسیده باخبر می‌شوند؛ پس از ثبت، رونوشت «جهت اطلاع» در کارتابل آن‌ها قرار می‌گیرد. برای اقدام از «ارجاع» استفاده کنید.'}
            </p>
          )}
          {recipients.length > 0 && (
            <ul className="recipients mb">
              {recipients.map((r, i) => (
                <li key={i}>
                  <span className={`rcpt-kind ${r.kind}`}>{r.kind === 'cc' ? 'رونوشت' : 'گیرنده'}</span>
                  <span className="grow">
                    <strong>{r.label || '—'}</strong>
                    {r.note && <span className="muted"> {r.note}</span>}
                  </span>
                  <Button type="button" variant="ghost" size="sm" onClick={() => setRecipients(recipients.filter((_, j) => j !== i))}>
                    حذف
                  </Button>
                </li>
              ))}
            </ul>
          )}
          <div className="rcpt-add">
            <Field label="از">
              <select className="input" value={rType} onChange={(e) => (setRType(e.target.value as typeof rType), setRValue(''))}>
                <option value="user">شخص</option>
                <option value="position">سمت</option>
                <option value="unit">واحد (مدیر واحد)</option>
              </select>
            </Field>
            <div className="rcpt-target">
              <span className="field-label">{rType === 'user' ? 'نام شخص' : rType === 'position' ? 'سمت' : 'واحد'}</span>
              {rType === 'user' && <UserSelect value={rValue} onChange={(v, u) => (setRValue(v), setRLabel(u?.full_name ?? ''))} />}
              {rType === 'position' && <PositionSelect value={rValue} onChange={setRValue} />}
              {rType === 'unit' && <UnitSelect value={rValue} onChange={setRValue} emptyLabel="انتخاب واحد…" />}
            </div>
            {f.kind === 'internal' && (
              <Field label="به‌عنوان">
                <select className="input" value={rKind} onChange={(e) => setRKind(e.target.value as 'to' | 'cc')}>
                  <option value="to">گیرنده</option>
                  <option value="cc">رونوشت</option>
                </select>
              </Field>
            )}
            {(f.kind !== 'internal' || rKind === 'cc') && (
              <Field label="شرح رونوشت">
                <input className="input" list="cc-notes" value={rNote} onChange={(e) => setRNote(e.target.value)} placeholder="جهت اطلاع" maxLength={200} />
              </Field>
            )}
            <Button type="button" variant="secondary" onClick={addRecipient} disabled={!rValue}>
              افزودن
            </Button>
          </div>
          <datalist id="cc-notes">
            {NOTES.map((n) => (
              <option key={n} value={n} />
            ))}
          </datalist>
        </Card>

        {f.kind === 'outgoing' && (
          <Card title="رونوشت بیرونی" className="mt">
            <p className="small muted mb">سازمان‌های دیگری که رونوشت این نامه را می‌گیرند؛ زیر نامه در بخش «رونوشت» چاپ می‌شوند.</p>
            {copies.length > 0 && (
              <ul className="recipients mb">
                {copies.map((x, i) => (
                  <li key={i}>
                    <span className="rcpt-kind cc">رونوشت</span>
                    <span className="grow">
                      <strong>{x.label}</strong>
                      {x.note && <span className="muted"> {x.note}</span>}
                    </span>
                    <Button type="button" variant="ghost" size="sm" onClick={() => setCopies(copies.filter((_, j) => j !== i))}>
                      حذف
                    </Button>
                  </li>
                ))}
              </ul>
            )}
            <div className="rcpt-add">
              <div className="rcpt-target">
                <span className="field-label">از مخاطبین بیرونی</span>
                <ContactPicker value={xContact} onChange={(v) => (setXContact(v), setXLabel(''))} />
              </div>
              <Field label="یا نام سازمان">
                <input className="input" value={xLabel} disabled={!!xContact} onChange={(e) => setXLabel(e.target.value)} placeholder="مثلاً: سازمان برنامه و بودجه استان" maxLength={300} />
              </Field>
              <Field label="شرح رونوشت">
                <input className="input" list="cc-notes" value={xNote} onChange={(e) => setXNote(e.target.value)} placeholder="جهت اطلاع" maxLength={200} />
              </Field>
              <Button type="button" variant="secondary" onClick={addCopy} disabled={!xContact && !xLabel.trim()}>
                افزودن
              </Button>
            </div>
          </Card>
        )}

        <Card title="پیوست‌ها" className="mt">
          <AttachmentPicker onAdd={(more) => setFiles((x) => [...x, ...more])} />
          <PickedList files={files} onRemove={(i) => setFiles(files.filter((_, j) => j !== i))} />
          <p className="small muted">پیوست‌ها رمزنگاری‌شده ذخیره می‌شوند؛ نسخه‌های بعدی را در صفحه نامه بارگذاری کنید.</p>
        </Card>

        {!id && (
          <Card title="ثبت و گردش" className="mt">
            <div className="row gap wrap">
              {canRegister && (
                <label className="check">
                  <input type="checkbox" checked={register} onChange={(e) => setRegister(e.target.checked)} />
                  ثبت و شماره‌گذاری فوری {f.kind === 'outgoing' && '(دبیرخانه)'}
                </label>
              )}
              {wfOptions.length > 0 && (
                <Field label="شروع گردش کار">
                  <select className="input" value={workflow} onChange={(e) => setWorkflow(e.target.value)}>
                    <option value="">بدون گردش کار</option>
                    {wfOptions.map((w) => (
                      <option key={w.key} value={w.key}>
                        {w.name} (نسخه {w.version.toLocaleString('fa')})
                      </option>
                    ))}
                  </select>
                </Field>
              )}
            </div>
          </Card>
        )}
        <div className="row gap mt">
          <Button type="submit" busy={act.busy}>
            {id ? 'ذخیره تغییرات' : register ? 'ثبت نامه' : 'ذخیره پیش‌نویس'}
          </Button>
          <Button type="button" variant="ghost" onClick={() => nav(-1)}>
            انصراف
          </Button>
        </div>
      </form>
    </>
  );
}
