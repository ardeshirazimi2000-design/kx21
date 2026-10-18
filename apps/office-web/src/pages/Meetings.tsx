import { roleLabel } from '@kx/shared';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { MEETING_STATUS, Pill, RESOLUTION_STATUS, REFERRAL_STATUS, STATUS } from '../components/labels';
import { Button, Card, Empty, ErrorBox, Field, Loading, Modal, PageHeader, Pager, Tabs, dateFa, dateTimeFa, fa } from '../components/ui';
import { useAuth } from '../lib/auth';
import { useAction, useApi } from '../lib/hooks';
import { api, download, post } from '../lib/api';

export function MeetingsPage() {
  const [tab, setTab] = useState<'upcoming' | 'all'>('upcoming');
  const [page, setPage] = useState(1);
  const [q, setQ] = useState('');
  const nav = useNavigate();
  const qs = `upcoming=${tab === 'upcoming'}&page=${page}${q ? `&q=${encodeURIComponent(q)}` : ''}`;
  const r = useApi<{ items: any[]; total: number; page: number; pageSize: number }>(`/meetings?${qs}`, [qs]);
  return (
    <>
      <PageHeader title="جلسات کمیسیون‌ها" subtitle="اطلاعات جلسات از سامانه جلسات کمیسیون‌های اتاق دریافت و به‌روز می‌شود" />
      <Card>
        <div className="row between wrap mb">
          <Tabs
            value={tab}
            onChange={(t) => (setTab(t), setPage(1))}
            tabs={[
              { id: 'upcoming', label: 'پیش رو' },
              { id: 'all', label: 'همه' },
            ]}
          />
          <input className="input" style={{ maxWidth: 300 }} placeholder="جستجوی عنوان یا کمیسیون…" onKeyDown={(e) => e.key === 'Enter' && setQ((e.target as HTMLInputElement).value.trim())} />
        </div>
        <ErrorBox error={r.error} />
        {r.loading && !r.data ? (
          <Loading />
        ) : !r.data?.items.length ? (
          <Empty>جلسه‌ای دریافت نشده است. اتصال در بخش یکپارچه‌سازی تنظیم می‌شود.</Empty>
        ) : (
          <>
            <table className="table">
              <thead>
                <tr>
                  <th>کمیسیون</th>
                  <th>جلسه</th>
                  <th>زمان</th>
                  <th>مکان</th>
                  <th>وضعیت</th>
                  <th>مصوبات</th>
                </tr>
              </thead>
              <tbody>
                {r.data.items.map((m) => (
                  <tr key={m.id} className="clickable" onClick={() => nav(`/meetings/${m.id}`)}>
                    <td>{m.commission_name}</td>
                    <td>
                      {m.title} {m.number ? `(شماره ${fa(m.number)})` : ''}
                    </td>
                    <td className="small">{dateTimeFa(m.scheduled_at)}</td>
                    <td className="small">{m.location ?? '—'}</td>
                    <td>{MEETING_STATUS[m.status] ?? m.status}</td>
                    <td>{fa(m.resolution_count)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <Pager page={r.data.page} pageSize={r.data.pageSize} total={Number(r.data.total)} onPage={setPage} />
          </>
        )}
      </Card>
    </>
  );
}

export function MeetingDetailPage() {
  const { id } = useParams();
  const r = useApi<any>(`/meetings/${id}`, [id]);
  const act = useAction();
  const { can } = useAuth();
  const [inviting, setInviting] = useState(false);
  if (r.error) return <ErrorBox error={r.error} />;
  if (!r.data) return <Loading />;
  const m = r.data;
  const d = m.data ?? {};
  return (
    <>
      <PageHeader
        title={`${m.title}${m.number ? ` (جلسه ${fa(m.number)})` : ''}`}
        subtitle={`${m.commission_name} — ${dateTimeFa(m.scheduled_at)} — ${m.location ?? ''}`}
        actions={
          <Button variant="secondary" busy={act.busy} onClick={() => act.run(async () => (await api(`/meetings/${id}?refresh=1`), await r.reload()))}>
            به‌روزرسانی از سامانه جلسات
          </Button>
        }
      />
      <ErrorBox error={act.error} />
      <div className="grid grid-2">
        <Card title="دستور جلسه">
          {!(d.agenda ?? []).length ? (
            <Empty>دستور جلسه‌ای ثبت نشده است.</Empty>
          ) : (
            <ol>
              {d.agenda.map((a: any) => (
                <li key={a.id}>
                  {a.title}
                  {a.description && <div className="small muted">{a.description}</div>}
                </li>
              ))}
            </ol>
          )}
        </Card>
        <Card title="حاضران و دعوت‌شدگان">
          <ul className="list">
            {(d.participants ?? []).map((p: any) => (
              <li key={p.id} className="row between">
                <span>
                  {p.full_name} <span className="small muted">{roleLabel(p.role)}</span>
                </span>
                <span className="small muted">{p.local_user_id ? 'کاربر اتوماسیون' : ''} {p.attendance === 'present' || p.attendance === 'online' ? '· حاضر' : p.attendance ? '· غایب' : ''}</span>
              </li>
            ))}
          </ul>
        </Card>
      </div>
      <Card title="مصوبات" className="mt">
        {!m.resolutions.length ? (
          <Empty>مصوبه‌ای دریافت نشده است.</Empty>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>شماره</th>
                <th>متن</th>
                <th>مسئول</th>
                <th>مهلت</th>
                <th>وضعیت</th>
                <th>نامه ابلاغ</th>
              </tr>
            </thead>
            <tbody>
              {m.resolutions.map((x: any) => (
                <tr key={x.external_id}>
                  <td>
                    <Link to={`/resolutions/${x.external_id}`}>{x.number}</Link>
                  </td>
                  <td>{x.text}</td>
                  <td>{x.owner_name}</td>
                  <td className="small">{dateFa(x.due_date)}</td>
                  <td>
                    <Pill map={RESOLUTION_STATUS} value={x.status} /> {fa(x.progress)}٪
                  </td>
                  <td>{x.letter_id ? <Link to={`/letters/${x.letter_id}`}>{x.letter_number}</Link> : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
      <Card
        title="نامه‌های دعوت"
        className="mt"
        actions={
          can('letter.register_outgoing') && (d.participants ?? []).length > 0 && (
            <Button size="sm" variant="secondary" onClick={() => setInviting(true)}>
              ساخت نامه دعوت
            </Button>
          )
        }
      >
        {!m.invitations.length ? (
          <Empty>برای این جلسه نامه دعوتی ساخته نشده است. دبیر کمیسیون می‌تواند از صفحه مدعوین جلسه در سامانه جلسات آن را درخواست کند.</Empty>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>مدعو</th>
                <th>نامه</th>
                <th>وضعیت</th>
                <th>درخواست‌کننده</th>
              </tr>
            </thead>
            <tbody>
              {m.invitations.map((x: any) => (
                <tr key={x.letter_id}>
                  <td>{x.invitee_name}</td>
                  <td>
                    <Link to={`/letters/${x.letter_id}`}>{x.letter_number ? fa(x.letter_number) : 'پیش‌نویس'}</Link>
                  </td>
                  <td>
                    <Pill map={STATUS} value={x.letter_status} />
                  </td>
                  <td className="small">
                    {x.requested_by ?? '—'} <span className="muted">{dateTimeFa(x.created_at)}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
      {inviting && (
        <InvitationLettersModal
          meetingId={m.id}
          participants={d.participants ?? []}
          already={m.invitations.filter((x: any) => x.letter_status !== 'cancelled').map((x: any) => x.invitee_external_id)}
          onClose={() => setInviting(false)}
          onDone={async () => (setInviting(false), await r.reload())}
        />
      )}
      {(d.documents ?? []).length > 0 && (
        <Card title="مستندات جلسه" className="mt">
          <ul className="list">
            {d.documents.map((doc: any) => (
              <li key={doc.id} className="row between">
                <span>{doc.title ?? doc.file_name}</span>
                <Button variant="ghost" size="sm" onClick={() => void download(`/meetings/${id}/documents/${doc.id}`, doc.file_name)}>
                  دریافت
                </Button>
              </li>
            ))}
          </ul>
        </Card>
      )}
      {d.minutes && (
        <Card title={`صورتجلسه ${d.minutes.minutes_number ?? ''}`} className="mt">
          <div className="letter-body">{d.minutes.body}</div>
        </Card>
      )}
      {m.referrals.length > 0 && (
        <Card title="مکاتبات ارجاع‌شده به این جلسه" className="mt">
          <ul className="list">
            {m.referrals.map((x: any) => (
              <li key={x.id}>
                <Link to={`/letters/${x.letter_id}`}>
                  {x.letter_number} — {x.subject}
                </Link>{' '}
                <span className="small muted">{REFERRAL_STATUS[x.status] ?? x.status}</span>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </>
  );
}

function InvitationLettersModal({
  meetingId,
  participants,
  already,
  onClose,
  onDone,
}: {
  meetingId: string;
  participants: any[];
  already: string[];
  onClose: () => void;
  onDone: () => void;
}) {
  const open = participants.filter((p) => !already.includes(p.id));
  const [selected, setSelected] = useState<Set<string>>(() => new Set(open.map((p) => p.id)));
  const [note, setNote] = useState('');
  const act = useAction();
  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  return (
    <Modal
      title="ساخت پیش‌نویس نامه دعوت"
      onClose={onClose}
      wide
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            انصراف
          </Button>
          <Button
            busy={act.busy}
            disabled={!selected.size}
            onClick={() =>
              act.run(async () => {
                await post(`/meetings/${meetingId}/invitation-letters`, { inviteeIds: [...selected], note: note.trim() || null });
                onDone();
              })
            }
          >
            ساخت {fa(selected.size)} نامه
          </Button>
        </>
      }
    >
      <ErrorBox error={act.error} />
      {!open.length ? (
        <Empty>برای همه مدعوین نامه دعوت ساخته شده است.</Empty>
      ) : (
        <table className="table">
          <tbody>
            {open.map((p) => (
              <tr key={p.id}>
                <td style={{ width: 32 }}>
                  <input type="checkbox" checked={selected.has(p.id)} onChange={() => toggle(p.id)} aria-label={p.full_name} />
                </td>
                <td>{p.full_name}</td>
                <td className="muted">{p.organization}</td>
                <td>{roleLabel(p.role)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <Field label="توضیح اضافه در متن نامه (اختیاری)">
        <textarea className="input" rows={3} value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000} />
      </Field>
    </Modal>
  );
}
