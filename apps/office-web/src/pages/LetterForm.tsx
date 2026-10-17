import { useEffect, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { CONFIDENTIALITY, KIND, PRIORITY } from '../components/labels';
import { PositionSelect, UnitSelect, UserSelect, useOrg } from '../components/pickers';
import { Button, Card, ErrorBox, Field, JalaliDateInput, Loading, PageHeader } from '../components/ui';
import { get, patch, post, upload } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useAction, useApi } from '../lib/hooks';

type Recipient = { userId?: string; positionId?: string; unitId?: string; kind: 'to' | 'cc'; label: string };

const empty = {
  kind: 'internal' as 'incoming' | 'outgoing' | 'internal',
  subject: '',
  body: '',
  summary: '',
  externalOrg: '',
  externalParty: '',
  externalNumber: '',
  externalDate: '',
  deliveryMethod: '',
  priority: 'normal',
  confidentiality: 0,
  ownerUnitId: '',
  dueDate: '',
  source: 'manual',
};

export function LetterFormPage() {
  const { id } = useParams();
  const [sp] = useSearchParams();
  const nav = useNavigate();
  const { me, can } = useAuth();
  const org = useOrg();
  const workflows = useApi<any[]>(can('workflow.start') ? '/workflows' : null);
  const [f, setF] = useState({ ...empty, kind: (sp.get('kind') as typeof empty.kind) ?? (can('letter.register_incoming') ? 'incoming' : 'internal') });
  const [recipients, setRecipients] = useState<Recipient[]>([]);
  const [files, setFiles] = useState<File[]>([]);
  const [register, setRegister] = useState(false);
  const [workflow, setWorkflow] = useState('');
  const [replyTo, setReplyTo] = useState<any>(null);
  const [loaded, setLoaded] = useState(!id);
  const act = useAction();
  const set = (k: keyof typeof empty, v: any) => setF((x) => ({ ...x, [k]: v }));

  useEffect(() => {
    if (!id) return;
    void get(`/letters/${id}`).then((l) => {
      setF({
        kind: l.kind, subject: l.subject, body: l.body ?? '', summary: l.summary ?? '', externalOrg: l.external_org ?? '', externalParty: l.external_party ?? '',
        externalNumber: l.external_number ?? '', externalDate: l.external_date?.slice(0, 10) ?? '', deliveryMethod: l.delivery_method ?? '', priority: l.priority,
        confidentiality: l.confidentiality, ownerUnitId: l.owner_unit_id ?? '', dueDate: l.due_date?.slice(0, 10) ?? '', source: l.source,
      });
      setRecipients(
        l.recipients.map((r: any) => ({
          userId: r.user_id ?? undefined, positionId: r.position_id ?? undefined, unitId: r.unit_id ?? undefined, kind: r.kind,
          label: r.user_name ?? (r.position_title ? `${r.position_title} — ${r.position_unit}` : r.unit_name),
        })),
      );
      setLoaded(true);
    });
  }, [id]);

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
        ownerUnitId: l.owner_unit_id ?? '',
      }));
    });
  }, [sp, id]);

  const [rType, setRType] = useState<'user' | 'position' | 'unit'>('user');
  const [rValue, setRValue] = useState('');
  const [rLabel, setRLabel] = useState('');
  const [rKind, setRKind] = useState<'to' | 'cc'>('to');

  if (!loaded) return <Loading />;
  const external = f.kind !== 'internal';
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
    setRecipients([...recipients, { [`${rType}Id`]: rValue, kind: rKind, label } as Recipient]);
    setRValue('');
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    void act.run(async () => {
      const payload = {
        subject: f.subject,
        body: f.body || null,
        summary: f.summary || null,
        externalOrg: external ? f.externalOrg || null : null,
        externalParty: external ? f.externalParty || null : null,
        externalNumber: f.kind === 'incoming' ? f.externalNumber || null : null,
        externalDate: f.kind === 'incoming' ? f.externalDate || null : null,
        deliveryMethod: f.deliveryMethod || null,
        priority: f.priority,
        confidentiality: Number(f.confidentiality),
        ownerUnitId: f.ownerUnitId || null,
        dueDate: f.dueDate || null,
        recipients: recipients.map(({ label: _l, ...r }) => r),
      };
      let letterId = id;
      if (id) await patch(`/letters/${id}`, payload);
      else {
        const l = await post('/letters', { ...payload, kind: f.kind, source: f.source, replyToId: replyTo?.id ?? null, register, workflow: workflow || null });
        letterId = l.id;
      }
      for (const file of files) await upload(`/letters/${letterId}/attachments`, { source: f.source === 'scan' ? 'scan' : 'upload' }, file);
      nav(`/letters/${letterId}`);
    });
  };

  return (
    <>
      <PageHeader title={id ? 'ویرایش نامه' : 'نامه جدید'} subtitle={replyTo ? `در پاسخ به نامه ${replyTo.number ?? ''} — ${replyTo.subject}` : undefined} />
      <form onSubmit={submit}>
        <Card>
          <ErrorBox error={act.error} />
          <div className="grid grid-4">
            <Field label="نوع نامه">
              <select className="input" value={f.kind} disabled={!!id} onChange={(e) => set('kind', e.target.value)}>
                {Object.entries(KIND)
                  .filter(([k]) => k !== 'incoming' || can('letter.register_incoming'))
                  .map(([k, l]) => (
                    <option key={k} value={k}>
                      {l}
                    </option>
                  ))}
              </select>
            </Field>
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
              <Field label={f.kind === 'incoming' ? 'سازمان فرستنده' : 'سازمان گیرنده'}>
                <input className="input" value={f.externalOrg} onChange={(e) => set('externalOrg', e.target.value)} />
              </Field>
              <Field label={f.kind === 'incoming' ? 'شخص فرستنده' : 'مخاطب'}>
                <input className="input" value={f.externalParty} onChange={(e) => set('externalParty', e.target.value)} />
              </Field>
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
          <Field label="متن نامه">
            <textarea className="input" rows={12} value={f.body} onChange={(e) => set('body', e.target.value)} />
          </Field>
          <div className="grid grid-2">
            <Field label="خلاصه / چکیده">
              <textarea className="input" rows={2} value={f.summary} onChange={(e) => set('summary', e.target.value)} />
            </Field>
            <Field label="مهلت پاسخ">
              <JalaliDateInput value={f.dueDate} onChange={(v) => set('dueDate', v)} />
            </Field>
          </div>
        </Card>

        {f.kind === 'internal' && (
          <Card title="گیرندگان داخلی" className="mt">
            {recipients.length > 0 && (
              <ul className="list mb">
                {recipients.map((r, i) => (
                  <li key={i} className="row between">
                    <span>
                      {r.kind === 'cc' ? 'رونوشت: ' : 'گیرنده: '}
                      {r.label}
                    </span>
                    <Button type="button" variant="ghost" size="sm" onClick={() => setRecipients(recipients.filter((_, j) => j !== i))}>
                      حذف
                    </Button>
                  </li>
                ))}
              </ul>
            )}
            <div className="row gap wrap" style={{ alignItems: 'flex-end' }}>
              <Field label="نوع">
                <select className="input" value={rType} onChange={(e) => (setRType(e.target.value as typeof rType), setRValue(''))}>
                  <option value="user">کاربر</option>
                  <option value="position">سمت</option>
                  <option value="unit">واحد (مدیر واحد)</option>
                </select>
              </Field>
              <div className="grow">
                {rType === 'user' && <UserSelect value={rValue} onChange={(v, u) => (setRValue(v), setRLabel(u?.full_name ?? ''))} />}
                {rType === 'position' && <PositionSelect value={rValue} onChange={setRValue} />}
                {rType === 'unit' && <UnitSelect value={rValue} onChange={setRValue} emptyLabel="انتخاب واحد…" />}
              </div>
              <Field label="گیرنده/رونوشت">
                <select className="input" value={rKind} onChange={(e) => setRKind(e.target.value as 'to' | 'cc')}>
                  <option value="to">گیرنده</option>
                  <option value="cc">رونوشت</option>
                </select>
              </Field>
              <Button type="button" variant="secondary" onClick={addRecipient} disabled={!rValue}>
                افزودن
              </Button>
            </div>
          </Card>
        )}

        <Card title="پیوست‌ها" className="mt">
          <input type="file" multiple accept=".pdf,.doc,.docx,.xls,.xlsx,.png,.jpg,.jpeg,.tif,.tiff,.zip,.txt" onChange={(e) => setFiles([...(e.target.files ?? [])])} />
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
