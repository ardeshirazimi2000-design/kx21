import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  ACTION, CONFIDENTIALITY, ConfBadge, KIND, KindBadge, MEETING_STATUS, PRIORITY, Pill, REFERRAL_STATUS, RESOLUTION_STATUS, ROUTE_STATUS, SOURCE, STATUS,
  STEP_STATUS, STEP_TYPE, WF_STATUS,
} from '../components/labels';
import { PositionSelect, UserSelect } from '../components/pickers';
import { LetterBody } from '../components/letterPaper';
import { RelatedLetters } from './SmartSearch';
import { AuthImage } from '../components/signature';
import { Badge, Button, Card, Empty, ErrorBox, Field, JalaliDateTimeInput, Loading, Modal, PageHeader, dateFa, dateTimeFa, fa } from '../components/ui';
import { download, fetchText, openFile, patch, post, upload } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useAction, useApi } from '../lib/hooks';

const size = (n: number) => (n > 1048576 ? `${fa((n / 1048576).toFixed(1))} مگابایت` : `${fa(Math.ceil(n / 1024))} کیلوبایت`);

export function LetterDetailPage() {
  const { id } = useParams();
  const nav = useNavigate();
  const r = useApi<any>(`/letters/${id}`, [id]);
  const [modal, setModal] = useState<null | 'refer' | 'workflow' | 'meeting' | 'cancel' | 'send' | 'archive'>(null);
  const act = useAction();
  const [codes, setCodes] = useState<{ barcode: string; qr: string } | null>(null);
  useEffect(() => {
    if (!r.data?.number) return;
    void Promise.all([fetchText(`/letters/${id}/barcode.svg`), fetchText(`/letters/${id}/qr.svg`)]).then(([barcode, qr]) => setCodes({ barcode, qr }));
  }, [id, r.data?.number]);
  // Opening the letter marks my pending referrals as seen.
  useEffect(() => {
    const l = r.data;
    if (!l) return;
    const unseen = l.routing.filter((x: any) => l.my.routes.includes(x.id) && x.status === 'pending' && !x.workflow_step_id);
    if (unseen.length) void Promise.all(unseen.map((x: any) => patch(`/routes/${x.id}`, { status: 'seen' })));
  }, [r.data]);

  if (r.error) return <ErrorBox error={r.error} />;
  if (!r.data) return <Loading />;
  const l = r.data;
  const doAct = (fn: () => Promise<unknown>) => act.run(async () => {
    await fn();
    await r.reload();
  });
  const close = () => setModal(null);
  const done = async () => {
    setModal(null);
    await r.reload();
  };

  return (
    <>
      <PageHeader
        title={
          <span className="row gap-sm wrap">
            <KindBadge kind={l.kind} />
            <span className="letter-number">{l.number ? fa(l.number) : 'پیش‌نویس'}</span>
            <span>{l.subject}</span>
          </span>
        }
        subtitle={
          <span className="row gap-sm wrap">
            <Pill map={STATUS} value={l.status} />
            {l.priority !== 'normal' && <Pill map={PRIORITY} value={l.priority} />}
            <ConfBadge level={l.confidentiality} />
            {l.source !== 'manual' && <Badge tone="info">{SOURCE[l.source]}</Badge>}
            <span>کد رهگیری: <span className="mono">{l.tracking_code}</span></span>
            {l.lockReason && l.status !== 'cancelled' && <Badge>🔒 {l.lockReason}</Badge>}
          </span>
        }
        actions={
          <>
            {l.my.canEdit && <Link className="btn btn-secondary" to={`/letters/${l.id}/edit`}>ویرایش</Link>}
            {l.my.canRegister && <Button busy={act.busy} onClick={() => doAct(() => post(`/letters/${l.id}/register`))}>ثبت و شماره‌گذاری</Button>}
            {l.status !== 'draft' && l.status !== 'cancelled' && <Button variant="secondary" onClick={() => setModal('refer')}>ارجاع</Button>}
            {l.my.canStartWorkflow && <Button variant="secondary" onClick={() => setModal('workflow')}>شروع گردش کار</Button>}
            {l.my.canSign && <Button variant="success" busy={act.busy} onClick={() => confirm('نامه با امضای دیجیتال شما امضا شود؟ تصویر نمونه امضای شما زیر نامه قرار می‌گیرد و پس از آن متن نامه قابل ویرایش نیست.') && doAct(() => post(`/letters/${l.id}/sign`))}>امضا</Button>}
            {l.my.canSend && <Button onClick={() => setModal('send')}>ارسال</Button>}
            {l.my.canReferToMeeting && <Button variant="secondary" onClick={() => setModal('meeting')}>ارجاع به کمیسیون</Button>}
            {l.my.canArchive && <Button variant="secondary" onClick={() => setModal('archive')}>بایگانی</Button>}
            {l.kind === 'incoming' && l.number && <Link className="btn btn-ghost" to={`/letters/new?replyTo=${l.id}`}>پاسخ</Link>}
            {l.kind !== 'incoming' ? (
              <Link className="btn btn-ghost" to={`/letters/${l.id}/print`}>چاپ و PDF</Link>
            ) : (
              l.number && <Button variant="ghost" onClick={() => window.print()}>چاپ</Button>
            )}
            {l.my.canCancel && <Button variant="danger" onClick={() => setModal('cancel')}>ابطال</Button>}
          </>
        }
      />
      <ErrorBox error={act.error} />

      <div className="print-only">
        <div className="letterhead">
          <div>
            <strong>اتاق بازرگانی، صنایع، معادن و کشاورزی ایران</strong>
            <div>{l.owner_unit}</div>
          </div>
          <dl className="kv">
            <dt>شماره:</dt>
            <dd className="letter-number">{fa(l.number)}</dd>
            <dt>تاریخ:</dt>
            <dd>{dateFa(l.registered_at)}</dd>
            <dt>پیوست:</dt>
            <dd>{l.attachments.length ? 'دارد' : 'ندارد'}</dd>
          </dl>
        </div>
      </div>

      <MyWork letter={l} onDone={r.reload} />

      <div className="grid grid-2">
        <Card title="مشخصات نامه">
          <dl className="kv">
            <dt>نوع</dt>
            <dd>{KIND[l.kind]}</dd>
            <dt>تاریخ ثبت</dt>
            <dd>{l.registered_at ? `${dateTimeFa(l.registered_at)} — ${l.registered_by_name ?? ''}` : '—'}</dd>
            <dt>ایجادکننده</dt>
            <dd>{l.created_by_name ?? 'سامانه'}</dd>
            {l.signatory_name && (
              <>
                <dt>امضاکننده</dt>
                <dd>
                  {l.signatory_name}
                  {l.signatory_position ? ` (${l.signatory_position})` : ''}
                </dd>
              </>
            )}
            <dt>واحد صاحب نامه</dt>
            <dd>{l.owner_unit ?? '—'}</dd>
            {l.kind !== 'internal' && (
              <>
                <dt>{l.kind === 'incoming' ? 'فرستنده' : 'گیرنده'}</dt>
                <dd>{[l.external_org, l.external_party].filter(Boolean).join(' — ') || '—'}</dd>
              </>
            )}
            {l.kind === 'incoming' && (
              <>
                <dt>شماره/تاریخ فرستنده</dt>
                <dd>
                  {l.external_number ?? '—'} {l.external_date ? `مورخ ${dateFa(l.external_date)}` : ''}
                </dd>
              </>
            )}
            {l.recipients.length > 0 && (
              <>
                <dt>گیرندگان</dt>
                <dd>{l.recipients.map((x: any) => `${x.kind === 'cc' ? 'رونوشت: ' : ''}${x.user_name ?? x.position_title ?? x.unit_name}`).join('، ')}</dd>
              </>
            )}
            <dt>طبقه‌بندی</dt>
            <dd>{CONFIDENTIALITY[l.confidentiality]}</dd>
            {l.due_date && (
              <>
                <dt>مهلت</dt>
                <dd>{dateFa(l.due_date)}</dd>
              </>
            )}
            {l.reply_to_id && (
              <>
                <dt>در پاسخ به</dt>
                <dd>
                  <Link to={`/letters/${l.reply_to_id}`}>{l.reply_to_number ?? l.reply_to_subject}</Link>
                </dd>
              </>
            )}
            {l.sent_at && (
              <>
                <dt>ارسال</dt>
                <dd>
                  {dateTimeFa(l.sent_at)} {l.delivery_method ? `(${l.delivery_method})` : ''}
                </dd>
              </>
            )}
            {l.document && (
              <>
                <dt>بایگانی</dt>
                <dd>
                  <Link to={`/archive?doc=${l.document.id}`}>{l.document.title}</Link>
                </dd>
              </>
            )}
            {l.resolution && (
              <>
                <dt>مصوبه</dt>
                <dd>
                  <Link to={`/resolutions/${l.resolution.external_id}`}>
                    {l.resolution.number} — {l.resolution.commission_name}
                  </Link>{' '}
                  <Pill map={RESOLUTION_STATUS} value={l.resolution.status} /> {fa(l.resolution.progress)}٪
                </dd>
              </>
            )}
          </dl>
        </Card>
        <Card title="بارکد و کد QR" className="no-print-codes">
          {codes ? (
            <div className="codes">
              <div dangerouslySetInnerHTML={{ __html: codes.barcode }} />
              <div style={{ width: 120 }} dangerouslySetInnerHTML={{ __html: codes.qr }} />
            </div>
          ) : (
            <Empty>پس از ثبت نامه، بارکد و کد QR صحت‌سنجی ساخته می‌شود.</Empty>
          )}
          {l.number && (
            <p className="small muted">
              کد QR به صفحه عمومی صحت‌سنجی نامه اشاره می‌کند: <a href={`/verify/${l.tracking_code}`} target="_blank" rel="noreferrer">/verify/{l.tracking_code}</a>
            </p>
          )}
        </Card>
      </div>

      <Card title="متن نامه" className="mt">
        {l.summary && <p className="muted">خلاصه: {l.summary}</p>}
        <div className="letter-body">{l.body ? <LetterBody body={l.body} format={l.body_format} /> : '—'}</div>
        {l.signatures.length > 0 && (
          <div className="letter-signatures">
            {l.signatures.map((s: any) => (
              <div key={s.id} className="letter-signature">
                {s.has_image && s.valid && s.intact && <AuthImage path={`/letters/${l.id}/signatures/${s.id}/image`} alt={`امضای ${s.full_name}`} />}
                <strong>{s.full_name}</strong>
                {s.position_title && <div className="muted">{s.position_title}</div>}
                <div className="small muted no-print">{dateTimeFa(s.signed_at)}</div>
                <div className="no-print">
                  {s.valid && s.intact ? <Badge tone="success">امضای معتبر</Badge> : s.valid ? <Badge tone="danger">محتوا پس از امضا تغییر کرده است</Badge> : <Badge tone="danger">امضای نامعتبر</Badge>}
                </div>
              </div>
            ))}
          </div>
        )}
        <div className="print-only mt">
          {codes && (
            <div className="codes">
              <div dangerouslySetInnerHTML={{ __html: codes.barcode }} />
              <div style={{ width: 90 }} dangerouslySetInnerHTML={{ __html: codes.qr }} />
            </div>
          )}
        </div>
      </Card>

      <Attachments letter={l} onChange={r.reload} />
      <Card title="نامه‌های مرتبط" className="mt no-print" actions={<Link className="btn btn-ghost btn-sm" to={`/smart-search?q=${encodeURIComponent(l.subject)}`}>جستجوی هوشمند این موضوع</Link>}>
        <RelatedLetters letterId={l.id} />
      </Card>
      <Workflows letter={l} onChange={r.reload} />

      <Card title="سابقه ارجاعات" className="mt no-print">
        {!l.routing.length ? (
          <Empty>این نامه هنوز ارجاع نشده است.</Empty>
        ) : (
          <ul className="timeline">
            {l.routing.map((x: any) => (
              <li key={x.id} className={x.status === 'done' ? 'ok' : x.status === 'returned' ? 'bad' : ['pending', 'seen'].includes(x.status) ? 'active' : ''}>
                <div className="row gap-sm wrap">
                  <strong>{x.from_name ?? 'سامانه'}</strong>
                  <span>←</span>
                  <strong>{x.to_name ?? `${x.to_position} (${x.to_unit})`}</strong>
                  <span className="muted">{ACTION[x.action]}</span>
                  <Pill map={ROUTE_STATUS} value={x.status} />
                  {x.workflow_step_id && <Badge tone="accent">گردش کار</Badge>}
                  <span className="small muted">{dateTimeFa(x.created_at)}</span>
                </div>
                {x.instruction && <div>دستور: {x.instruction}</div>}
                {x.due_at && <div className="small muted">مهلت: {dateTimeFa(x.due_at)}</div>}
                {x.response && (
                  <div>
                    پاسخ{x.done_by_name ? ` ${x.done_by_name}` : ''}: {x.response} <span className="small muted">{dateTimeFa(x.done_at)}</span>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>

      {l.meetingRefs.length > 0 && (
        <Card title="ارجاع به کمیسیون‌ها" className="mt">
          <table className="table">
            <thead>
              <tr>
                <th>کمیسیون</th>
                <th>وضعیت در سامانه جلسات</th>
                <th>دستور جلسه</th>
                <th>تاریخ</th>
              </tr>
            </thead>
            <tbody>
              {l.meetingRefs.map((m: any) => (
                <tr key={m.id}>
                  <td>{m.commission_name}</td>
                  <td>{REFERRAL_STATUS[m.status] ?? m.status}</td>
                  <td>
                    {(m.data?.agenda ?? []).map((a: any) => (
                      <div key={a.id} className="small">
                        {a.meeting_title ?? ''} {a.meeting_status ? `(${MEETING_STATUS[a.meeting_status] ?? a.meeting_status})` : ''}
                      </div>
                    ))}
                    {(m.data?.resolutions ?? []).map((x: any) => (
                      <div key={x.id} className="small">
                        مصوبه {x.number}: {x.text?.slice(0, 80)}
                      </div>
                    ))}
                  </td>
                  <td className="small">{dateTimeFa(m.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      {modal === 'refer' && <ReferModal letter={l} onClose={close} onDone={done} />}
      {modal === 'workflow' && <StartWorkflowModal letter={l} onClose={close} onDone={done} />}
      {modal === 'meeting' && <MeetingReferralModal letter={l} onClose={close} onDone={done} />}
      {modal === 'cancel' && (
        <ReasonModal
          title="ابطال نامه"
          label="علت ابطال"
          danger
          onClose={close}
          onSubmit={async (reason) => {
            await post(`/letters/${l.id}/cancel`, { reason });
            await done();
          }}
        />
      )}
      {modal === 'send' && <SendModal letter={l} onClose={close} onDone={done} />}
      {modal === 'archive' && <ArchiveModal letter={l} onClose={close} onDone={async () => (await done(), nav(`/letters/${l.id}`))} />}
    </>
  );
}

/** Pending referrals and workflow steps for the current user. */
function MyWork({ letter: l, onDone }: { letter: any; onDone: () => Promise<void> }) {
  const routes = l.routing.filter((x: any) => l.my.routes.includes(x.id) && !x.workflow_step_id);
  const steps = l.workflows.flatMap((w: any) => w.steps.filter((s: any) => l.my.steps.includes(s.id)).map((s: any) => ({ ...s, wf: w })));
  const [text, setText] = useState('');
  const act = useAction();
  const [refer, setRefer] = useState(false);
  if (!routes.length && !steps.length) return null;
  return (
    <Card title="اقدام شما" className="mb no-print">
      <ErrorBox error={act.error} />
      {steps.map((s: any) => (
        <div key={s.id} className="mb">
          <div className="row gap-sm wrap mb">
            <Badge tone="accent">{s.wf.definition_name}</Badge>
            <strong>
              {STEP_TYPE[s.type]}: {s.name}
            </strong>
            {s.due_at && <span className="small muted">مهلت: {dateTimeFa(s.due_at)}</span>}
          </div>
          <Field label="توضیحات / نظر">
            <textarea className="input" rows={2} value={text} onChange={(e) => setText(e.target.value)} />
          </Field>
          <div className="row gap-sm">
            <Button variant="success" busy={act.busy} onClick={() => act.run(async () => (await post(`/workflow-steps/${s.id}/act`, { decision: 'approve', comment: text || null }), setText(''), await onDone()))}>
              {s.type === 'sign' ? 'تأیید و امضا' : s.type === 'archive' ? 'بایگانی' : 'تأیید'}
            </Button>
            <Button variant="danger" busy={act.busy} disabled={text.trim().length < 3} title="برای رد، توضیح لازم است" onClick={() => act.run(async () => (await post(`/workflow-steps/${s.id}/act`, { decision: 'reject', comment: text }), setText(''), await onDone()))}>
              رد / برگشت
            </Button>
          </div>
        </div>
      ))}
      {routes.map((x: any) => (
        <div key={x.id} className="mb">
          <div className="row gap-sm wrap mb">
            <strong>{x.from_name ?? 'سامانه'}</strong> <span className="muted">{ACTION[x.action]}</span>
            {x.instruction && <span>— {x.instruction}</span>}
          </div>
          <Field label="پاسخ / اقدام انجام‌شده">
            <textarea className="input" rows={2} value={text} onChange={(e) => setText(e.target.value)} />
          </Field>
          <div className="row gap-sm">
            <Button variant="success" busy={act.busy} onClick={() => act.run(async () => (await patch(`/routes/${x.id}`, { status: 'done', response: text || null }), setText(''), await onDone()))}>
              {x.action === 'info' ? 'رؤیت شد' : 'اقدام شد'}
            </Button>
            <Button variant="secondary" onClick={() => setRefer(true)}>
              ارجاع به دیگری
            </Button>
            <Button variant="danger" busy={act.busy} disabled={text.trim().length < 3} onClick={() => act.run(async () => (await patch(`/routes/${x.id}`, { status: 'returned', response: text }), setText(''), await onDone()))}>
              برگشت
            </Button>
          </div>
        </div>
      ))}
      {refer && <ReferModal letter={l} completeMine onClose={() => setRefer(false)} onDone={async () => (setRefer(false), await onDone())} />}
    </Card>
  );
}

function Attachments({ letter: l, onChange }: { letter: any; onChange: () => Promise<void> }) {
  const act = useAction();
  const groups = new Map<string, any[]>();
  for (const a of l.attachments) groups.set(a.group_id, [...(groups.get(a.group_id) ?? []), a]);
  const editable = !['cancelled', 'archived', 'sent'].includes(l.status);
  const add = (file: File | undefined, groupId?: string) =>
    file && act.run(async () => (await upload(`/letters/${l.id}/attachments`, { groupId }, file), await onChange()));
  return (
    <Card
      title="پیوست‌ها"
      className="mt no-print"
      actions={
        editable && (
          <label className="btn btn-secondary btn-sm">
            افزودن پیوست
            <input type="file" hidden onChange={(e) => void add(e.target.files?.[0])} />
          </label>
        )
      }
    >
      <ErrorBox error={act.error} />
      {!groups.size ? (
        <Empty>پیوستی ندارد.</Empty>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>فایل</th>
              <th>نسخه</th>
              <th>حجم</th>
              <th>بارگذاری</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {[...groups.values()].map((versions) => {
              const last = versions[versions.length - 1];
              return (
                <tr key={last.group_id}>
                  <td>
                    {last.title ?? last.file_name}
                    {versions.length > 1 && (
                      <details className="small">
                        <summary>نسخه‌های قبلی</summary>
                        {versions.slice(0, -1).map((v) => (
                          <div key={v.id}>
                            <button className="btn btn-ghost btn-sm" onClick={() => void download(`/letters/${l.id}/attachments/${v.id}/download`, v.file_name)}>
                              نسخه {fa(v.version)} — {dateTimeFa(v.created_at)}
                            </button>
                          </div>
                        ))}
                      </details>
                    )}
                  </td>
                  <td>{fa(last.version)}</td>
                  <td className="small">{size(Number(last.size_bytes))}</td>
                  <td className="small">
                    {last.uploaded_by_name} — {dateTimeFa(last.created_at)}
                  </td>
                  <td className="row gap-sm">
                    <Button variant="ghost" size="sm" onClick={() => void openFile(`/letters/${l.id}/attachments/${last.id}/download?inline=1`)}>
                      مشاهده
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => void download(`/letters/${l.id}/attachments/${last.id}/download`, last.file_name)}>
                      دریافت
                    </Button>
                    {editable && (
                      <label className="btn btn-ghost btn-sm">
                        نسخه جدید
                        <input type="file" hidden onChange={(e) => void add(e.target.files?.[0], last.group_id)} />
                      </label>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </Card>
  );
}

function Workflows({ letter: l, onChange }: { letter: any; onChange: () => Promise<void> }) {
  const { can, me } = useAuth();
  const [cancel, setCancel] = useState<string | null>(null);
  if (!l.workflows.length) return null;
  return (
    <Card title="گردش کار" className="mt no-print">
      {l.workflows.map((w: any) => (
        <div key={w.id} className="mb">
          <div className="row gap-sm wrap mb">
            <strong>{w.definition_name}</strong>
            <span className="small muted">نسخه {fa(w.definition_version)}</span>
            <Pill map={WF_STATUS} value={w.status} />
            <span className="small muted">آغاز: {dateTimeFa(w.started_at)}</span>
            {w.status === 'running' && (w.started_by === me!.id || can('workflow.manage')) && (
              <Button variant="ghost" size="sm" onClick={() => setCancel(w.id)}>
                لغو گردش
              </Button>
            )}
          </div>
          <ul className="timeline">
            {w.steps.map((s: any) => (
              <li key={s.id} className={s.status === 'active' ? 'active' : s.status === 'approved' ? 'ok' : s.status === 'rejected' ? 'bad' : ''}>
                <div className="row gap-sm wrap">
                  <strong>
                    {STEP_TYPE[s.type]}: {s.name}
                  </strong>
                  <Pill map={STEP_STATUS} value={s.status} />
                  <span className="muted">{s.assignee_name ?? s.assignee_position ?? ''}</span>
                  {s.escalated_at && <Badge tone="danger">ارتقا یافته</Badge>}
                </div>
                {s.due_at && s.status === 'active' && <div className="small muted">مهلت: {dateTimeFa(s.due_at)}</div>}
                {s.acted_at && (
                  <div className="small">
                    {s.acted_by_name}: {s.comment ?? ''} <span className="muted">{dateTimeFa(s.acted_at)}</span>
                  </div>
                )}
              </li>
            ))}
          </ul>
        </div>
      ))}
      {cancel && (
        <ReasonModal
          title="لغو گردش کار"
          label="علت لغو"
          danger
          onClose={() => setCancel(null)}
          onSubmit={async (reason) => {
            await post(`/workflow-instances/${cancel}/cancel`, { reason });
            setCancel(null);
            await onChange();
          }}
        />
      )}
    </Card>
  );
}

type Target = { userId?: string; positionId?: string; label: string; action: string; instruction: string; dueAt: string };

function ReferModal({ letter, onClose, onDone, completeMine }: { letter: any; onClose: () => void; onDone: () => Promise<void>; completeMine?: boolean }) {
  const [targets, setTargets] = useState<Target[]>([]);
  const [type, setType] = useState<'user' | 'position'>('user');
  const [value, setValue] = useState('');
  const [label, setLabel] = useState('');
  const [action, setAction] = useState('refer');
  const [instruction, setInstruction] = useState('');
  const [dueAt, setDueAt] = useState('');
  const [closeMine, setCloseMine] = useState(!!completeMine);
  const act = useAction();
  const add = () => {
    if (!value) return;
    setTargets([...targets, { [`${type}Id`]: value, label: label || 'سمت انتخاب‌شده', action, instruction, dueAt } as Target]);
    setValue('');
    setInstruction('');
  };
  return (
    <Modal
      title={`ارجاع نامه ${letter.number ?? ''}`}
      onClose={onClose}
      wide
      footer={
        <>
          <Button
            busy={act.busy}
            disabled={!targets.length}
            onClick={() =>
              act.run(async () => {
                await post(`/letters/${letter.id}/routes`, {
                  targets: targets.map((t) => ({ userId: t.userId, positionId: t.positionId, action: t.action, instruction: t.instruction || null, dueAt: t.dueAt || null })),
                  completeMine: closeMine,
                });
                await onDone();
              })
            }
          >
            ارجاع ({fa(targets.length)})
          </Button>
          <Button variant="ghost" onClick={onClose}>
            انصراف
          </Button>
        </>
      }
    >
      <ErrorBox error={act.error} />
      {targets.length > 0 && (
        <ul className="list mb">
          {targets.map((t, i) => (
            <li key={i} className="row between">
              <span>
                <strong>{t.label}</strong> — {ACTION[t.action]} {t.instruction && `: ${t.instruction}`}
              </span>
              <Button variant="ghost" size="sm" onClick={() => setTargets(targets.filter((_, j) => j !== i))}>
                حذف
              </Button>
            </li>
          ))}
        </ul>
      )}
      <div className="grid grid-2">
        <Field label="گیرنده">
          <select className="input" value={type} onChange={(e) => (setType(e.target.value as 'user' | 'position'), setValue(''))}>
            <option value="user">شخص</option>
            <option value="position">سمت سازمانی (همه متصدیان)</option>
          </select>
        </Field>
        <Field label="نوع اقدام">
          <select className="input" value={action} onChange={(e) => setAction(e.target.value)}>
            {Object.entries(ACTION).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </Field>
      </div>
      {type === 'user' ? (
        <UserSelect value={value} onChange={(v, u) => (setValue(v), setLabel(u?.full_name ?? ''))} />
      ) : (
        <PositionSelect value={value} onChange={(v) => (setValue(v), setLabel(''))} />
      )}
      <Field label="دستور / هامش">
        <input className="input" value={instruction} onChange={(e) => setInstruction(e.target.value)} placeholder="مثلاً: جهت بررسی و اعلام نظر" />
      </Field>
      <Field label="مهلت (اختیاری)">
        <JalaliDateTimeInput value={dueAt} onChange={setDueAt} />
      </Field>
      <div className="row between">
        <Button variant="secondary" onClick={add} disabled={!value}>
          افزودن به فهرست
        </Button>
        <label className="check">
          <input type="checkbox" checked={closeMine} onChange={(e) => setCloseMine(e.target.checked)} />
          ارجاع من بسته شود
        </label>
      </div>
    </Modal>
  );
}

function StartWorkflowModal({ letter, onClose, onDone }: { letter: any; onClose: () => void; onDone: () => Promise<void> }) {
  const w = useApi<any[]>('/workflows');
  const list = (w.data ?? []).filter((d) => d.is_active && d.applies_to.includes(letter.kind));
  const [key, setKey] = useState('');
  const act = useAction();
  const sel = list.find((d) => d.key === key);
  return (
    <Modal
      title="شروع گردش کار"
      onClose={onClose}
      footer={
        <Button busy={act.busy} disabled={!key} onClick={() => act.run(async () => (await post(`/letters/${letter.id}/workflow`, { definition: key }), await onDone()))}>
          شروع
        </Button>
      }
    >
      <ErrorBox error={act.error} />
      <Field label="فرایند">
        <select className="input" value={key} onChange={(e) => setKey(e.target.value)}>
          <option value="">انتخاب کنید…</option>
          {list.map((d) => (
            <option key={d.key} value={d.key}>
              {d.name}
            </option>
          ))}
        </select>
      </Field>
      {sel && (
        <ol>
          {sel.definition.steps.map((s: any) => (
            <li key={s.key}>
              {STEP_TYPE[s.type]}: {s.name} {s.slaHours ? `(مهلت ${fa(s.slaHours)} ساعت)` : ''}
            </li>
          ))}
        </ol>
      )}
    </Modal>
  );
}

function MeetingReferralModal({ letter, onClose, onDone }: { letter: any; onClose: () => void; onDone: () => Promise<void> }) {
  const commissions = useApi<any[]>('/commissions');
  const meetings = useApi<{ items: any[] }>('/meetings?upcoming=true&pageSize=50');
  const [commissionId, setCommissionId] = useState('');
  const [meetingId, setMeetingId] = useState('');
  const [note, setNote] = useState('');
  const [withFiles, setWithFiles] = useState(true);
  const act = useAction();
  const upcoming = (meetings.data?.items ?? []).filter((m) => m.commission_id === commissionId);
  return (
    <Modal
      title="ارجاع مکاتبه به کمیسیون (سامانه جلسات)"
      onClose={onClose}
      footer={
        <Button
          busy={act.busy}
          disabled={!commissionId}
          onClick={() =>
            act.run(async () => {
              await post(`/letters/${letter.id}/meeting-referrals`, { commissionId, requestedMeetingId: meetingId || null, note: note || null, includeAttachments: withFiles });
              await onDone();
            })
          }
        >
          ارسال به سامانه جلسات
        </Button>
      }
    >
      <ErrorBox error={act.error ?? commissions.error} />
      <p className="small muted">نامه به‌عنوان موضوع پیشنهادی دستور جلسه در کمیسیون ثبت می‌شود و تغییر وضعیت آن به شما اطلاع داده می‌شود.</p>
      <Field label="کمیسیون">
        <select className="input" value={commissionId} onChange={(e) => (setCommissionId(e.target.value), setMeetingId(''))}>
          <option value="">انتخاب کنید…</option>
          {(commissions.data ?? []).map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </Field>
      {upcoming.length > 0 && (
        <Field label="جلسه پیشنهادی (اختیاری)">
          <select className="input" value={meetingId} onChange={(e) => setMeetingId(e.target.value)}>
            <option value="">به تشخیص دبیر کمیسیون</option>
            {upcoming.map((m) => (
              <option key={m.id} value={m.id}>
                {m.title} — {dateTimeFa(m.scheduled_at)}
              </option>
            ))}
          </select>
        </Field>
      )}
      <Field label="توضیح برای دبیرخانه کمیسیون">
        <textarea className="input" rows={3} value={note} onChange={(e) => setNote(e.target.value)} />
      </Field>
      <label className="check">
        <input type="checkbox" checked={withFiles} onChange={(e) => setWithFiles(e.target.checked)} />
        پیوست‌های نامه هم ارسال شود
      </label>
    </Modal>
  );
}

function SendModal({ letter, onClose, onDone }: { letter: any; onClose: () => void; onDone: () => Promise<void> }) {
  const [method, setMethod] = useState(letter.delivery_method ?? 'پست');
  const act = useAction();
  return (
    <Modal title="ارسال نامه صادره" onClose={onClose} footer={<Button busy={act.busy} onClick={() => act.run(async () => (await post(`/letters/${letter.id}/send`, { deliveryMethod: method }), await onDone()))}>ثبت ارسال</Button>}>
      <ErrorBox error={act.error} />
      <Field label="روش ارسال">
        <select className="input" value={method} onChange={(e) => setMethod(e.target.value)}>
          {['پست', 'پیک', 'ایمیل', 'دورنگار', 'تحویل حضوری', 'سامانه دولت الکترونیک'].map((m) => (
            <option key={m}>{m}</option>
          ))}
        </select>
      </Field>
    </Modal>
  );
}

function ArchiveModal({ letter, onClose, onDone }: { letter: any; onClose: () => void; onDone: () => Promise<void> }) {
  const folders = useApi<any[]>('/archive/folders');
  const [folderId, setFolderId] = useState('');
  const act = useAction();
  return (
    <Modal title="بایگانی نامه" onClose={onClose} footer={<Button busy={act.busy} onClick={() => act.run(async () => (await post(`/letters/${letter.id}/archive`, { folderId: folderId || null }), await onDone()))}>بایگانی</Button>}>
      <ErrorBox error={act.error} />
      <Field label="پرونده" hint="در صورت انتخاب نکردن، در پرونده «مکاتبات» واحد صاحب نامه بایگانی می‌شود">
        <select className="input" value={folderId} onChange={(e) => setFolderId(e.target.value)}>
          <option value="">پیش‌فرض واحد</option>
          {(folders.data ?? []).map((f) => (
            <option key={f.id} value={f.id}>
              {f.name} {f.unit_name ? `(${f.unit_name})` : ''}
            </option>
          ))}
        </select>
      </Field>
    </Modal>
  );
}

export function ReasonModal({ title, label, onClose, onSubmit, danger }: { title: string; label: string; onClose: () => void; onSubmit: (reason: string) => Promise<void>; danger?: boolean }) {
  const [reason, setReason] = useState('');
  const act = useAction();
  return (
    <Modal
      title={title}
      onClose={onClose}
      footer={
        <Button variant={danger ? 'danger' : 'primary'} busy={act.busy} disabled={reason.trim().length < 3} onClick={() => act.run(() => onSubmit(reason.trim()))}>
          تأیید
        </Button>
      }
    >
      <ErrorBox error={act.error} />
      <Field label={label}>
        <textarea className="input" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} autoFocus />
      </Field>
    </Modal>
  );
}

