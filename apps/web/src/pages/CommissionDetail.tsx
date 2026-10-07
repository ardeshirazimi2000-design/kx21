import { ISSUE_STATUS_LABELS, roleLabel, type CommissionSettings, type IssueStatus } from '@kx/shared';
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { MeetingStatusBadge } from '../components/status';
import { Badge, Button, Card, dateFa, dateTimeFa, Empty, ErrorBox, Field, fa, JalaliDateInput, Loading, Modal, PageHeader, Tabs } from '../components/ui';
import { patch, post } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useApi, useRoles } from '../lib/hooks';
import { ActivityReport, CommissionArchive } from './CommissionArchive';
import { CommissionDashboard } from './Home';
import { NewMeetingModal } from './Meetings';
import { PersonModal } from './Structure';

type Tab = 'overview' | 'members' | 'meetings' | 'archive' | 'report' | 'issues' | 'settings';

export function CommissionDetailPage() {
  const { id } = useParams();
  const { data: c, error, reload } = useApi(`/commissions/${id}`);
  const [tab, setTab] = useState<Tab>('overview');
  if (error) return <ErrorBox error={error} />;
  if (!c) return <Loading />;
  const caps: string[] = c.capabilities;
  const tabs: { id: Tab; label: string }[] = [
    { id: 'overview', label: 'داشبورد' },
    { id: 'members', label: 'اعضا و سمت‌ها' },
    { id: 'meetings', label: 'جلسات' },
  ];
  if (caps.includes('commission.browse')) tabs.push({ id: 'archive', label: 'آرشیو اسناد' });
  if (caps.includes('report.commission')) tabs.push({ id: 'report', label: 'گزارش دوره‌ای' });
  if (c.myPosition !== 'expert') tabs.push({ id: 'issues', label: 'مسائل و کارشناسی' });
  tabs.push({ id: 'settings', label: 'تنظیمات نصاب و رأی' });
  return (
    <>
      <PageHeader
        title={c.name}
        subtitle={
          <>
            {c.term?.title} — کد <span className="ltr">{c.code}</span>
            {c.domain ? ` — ${c.domain}` : ''}
          </>
        }
        actions={c.officers.map((o: any) => (
          <Badge key={o.position} tone="info">
            {roleLabel(o.position)}: {o.full_name}
          </Badge>
        ))}
      />
      <Tabs tabs={tabs} value={tab} onChange={setTab} />
      {tab === 'overview' && (caps.includes('report.commission') ? <CommissionDashboard commissionId={c.id} /> : <Empty>دسترسی به داشبورد ندارید.</Empty>)}
      {tab === 'members' && <Members commission={c} />}
      {tab === 'meetings' && <Meetings commission={c} />}
      {tab === 'archive' && <CommissionArchive commission={c} />}
      {tab === 'report' && <ActivityReport commission={c} />}
      {tab === 'issues' && <Issues commission={c} />}
      {tab === 'settings' && <Settings commission={c} onSaved={reload} />}
    </>
  );
}

function Members({ commission }: { commission: any }) {
  const { isAdmin, chamberId } = useAuth();
  const [showEnded, setShowEnded] = useState(false);
  const { data, reload } = useApi<any[]>(`/commissions/${commission.id}/members?includeEnded=${showEnded}`);
  const [adding, setAdding] = useState(false);
  const [changing, setChanging] = useState<any | null>(null);
  const end = async (m: any) => {
    const reason = prompt(`پایان عضویت ${m.full_name} — دلیل:`);
    if (reason === null) return;
    await post(`/memberships/${m.id}/end`, { reason });
    void reload();
  };
  return (
    <Card
      title="اعضا و سمت‌ها"
      actions={
        <>
          <label className="check" style={{ margin: 0 }}>
            <input type="checkbox" checked={showEnded} onChange={(e) => setShowEnded(e.target.checked)} /> نمایش سوابق
          </label>
          {isAdmin && <Button onClick={() => setAdding(true)}>افزودن عضو</Button>}
        </>
      }
    >
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>نام</th>
              <th>سازمان</th>
              <th>سمت</th>
              <th>حق رأی</th>
              <th>از</th>
              <th>تا</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {data?.map((m) => (
              <tr key={m.id} style={{ opacity: m.status === 'ended' ? 0.55 : 1 }}>
                <td>{m.full_name}</td>
                <td>{m.organization}</td>
                <td>
                  <Badge tone={['chair', 'vice_chair', 'secretary'].includes(m.position) ? 'accent' : 'neutral'}>{roleLabel(m.position, m.role_title)}</Badge>
                  {m.status === 'ended' && <span className="muted small"> (پایان‌یافته{m.note ? `: ${m.note}` : ''})</span>}
                </td>
                <td>{m.has_vote ? '✓' : '—'}</td>
                <td>{dateFa(m.start_date)}</td>
                <td>{dateFa(m.end_date)}</td>
                <td className="row gap-sm">
                  {isAdmin && m.status === 'active' && (
                    <>
                      <Button size="sm" variant="ghost" onClick={() => setChanging(m)}>
                        تغییر سمت
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => end(m)}>
                        پایان عضویت
                      </Button>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {adding && chamberId && <AddMemberModal commission={commission} chamberId={chamberId} onClose={() => setAdding(false)} onSaved={() => { setAdding(false); void reload(); }} />}
      {changing && <ChangePositionModal m={changing} onClose={() => setChanging(null)} onSaved={() => { setChanging(null); void reload(); }} />}
    </Card>
  );
}

function AddMemberModal({ commission, chamberId, onClose, onSaved }: { commission: any; chamberId: string; onClose: () => void; onSaved: () => void }) {
  const [q, setQ] = useState('');
  const people = useApi(q.length >= 2 ? `/people?chamberId=${chamberId}&q=${encodeURIComponent(q)}&pageSize=8` : null);
  const [userId, setUserId] = useState<string | null>(null);
  const [position, setPosition] = useState<string>('member');
  const roles = useRoles(chamberId);
  const [startDate, setStartDate] = useState('');
  const [replace, setReplace] = useState(false);
  const [creating, setCreating] = useState(false);
  const [err, setErr] = useState<any>(null);
  const save = async () => {
    try {
      await post(`/commissions/${commission.id}/members`, { userId, position, startDate: startDate || undefined, replaceExisting: replace });
      onSaved();
    } catch (e: any) {
      setErr(e);
    }
  };
  return (
    <Modal title="افزودن عضو" onClose={onClose} footer={<Button disabled={!userId} onClick={save}>افزودن</Button>}>
      <ErrorBox error={err} />
      {err?.code === 'position_taken' && (
        <label className="check">
          <input type="checkbox" checked={replace} onChange={(e) => setReplace(e.target.checked)} /> متصدی فعلی این سمت با حفظ سابقه پایان یابد
        </label>
      )}
      <Field label="جستجوی شخص">
        <input className="input" value={q} onChange={(e) => { setQ(e.target.value); setUserId(null); }} placeholder="حداقل ۲ حرف" />
      </Field>
      <ul className="list">
        {people.data?.items.map((p: any) => (
          <li key={p.id}>
            <label className="check" style={{ margin: 0 }}>
              <input type="radio" name="p" checked={userId === p.id} onChange={() => setUserId(p.id)} /> {p.full_name} <span className="muted small">{p.organization}</span>
            </label>
          </li>
        ))}
      </ul>
      <Button variant="ghost" size="sm" onClick={() => setCreating(true)}>
        + ثبت شخص جدید
      </Button>
      <div className="grid grid-2 mt">
        <Field label="سمت">
          <select className="input" value={position} onChange={(e) => setPosition(e.target.value)}>
            {roles.positions.map((p) => (
              <option key={p.key} value={p.key}>
                {p.title}
              </option>
            ))}
          </select>
        </Field>
        <Field label="تاریخ شروع">
          <JalaliDateInput value={startDate} onChange={setStartDate} />
        </Field>
      </div>
      {creating && (
        <PersonModal
          person={{}}
          chamberId={chamberId}
          canSetPassword
          onClose={() => setCreating(false)}
          onSaved={(p) => {
            setCreating(false);
            setQ(p.full_name);
            setUserId(p.id);
          }}
        />
      )}
    </Modal>
  );
}

function ChangePositionModal({ m, onClose, onSaved }: { m: any; onClose: () => void; onSaved: () => void }) {
  const [position, setPosition] = useState<string>(m.position);
  const roles = useRoles(m.chamber_id);
  const [hasVote, setHasVote] = useState<boolean>(m.has_vote);
  const [err, setErr] = useState<Error | null>(null);
  const save = async () => {
    try {
      await patch(`/memberships/${m.id}`, { position, hasVote });
      onSaved();
    } catch (e) {
      setErr(e as Error);
    }
  };
  return (
    <Modal title={`تغییر سمت — ${m.full_name}`} onClose={onClose} footer={<Button onClick={save}>ثبت</Button>}>
      <ErrorBox error={err} />
      <p className="muted small">سابقه سمت فعلی حفظ شده و سمت جدید از امروز ثبت می‌شود.</p>
      <Field label="سمت جدید">
        <select className="input" value={position} onChange={(e) => setPosition(e.target.value)}>
          {roles.positions.map((p) => (
            <option key={p.key} value={p.key}>
              {p.title}
            </option>
          ))}
        </select>
      </Field>
      <label className="check">
        <input type="checkbox" checked={hasVote} onChange={(e) => setHasVote(e.target.checked)} /> حق رأی دارد
      </label>
    </Modal>
  );
}

function Meetings({ commission }: { commission: any }) {
  const { data, reload } = useApi(`/meetings?commissionId=${commission.id}&order=desc&pageSize=50`);
  const [open, setOpen] = useState(false);
  const canCreate = commission.capabilities.includes('meeting.manage');
  return (
    <Card title="جلسات کمیسیون" actions={canCreate && <Button onClick={() => setOpen(true)}>جلسه جدید</Button>}>
      {data?.items.length === 0 && <Empty>جلسه‌ای ثبت نشده است.</Empty>}
      <ul className="list">
        {data?.items.map((m: any) => (
          <li key={m.id} className="row between gap">
            <Link to={`/meetings/${m.id}`}>
              جلسه {fa(m.number)}: {m.title}
            </Link>
            <span className="row gap-sm">
              <span className="muted small">{dateTimeFa(m.scheduled_at)}</span>
              <MeetingStatusBadge status={m.status} />
            </span>
          </li>
        ))}
      </ul>
      {open && <NewMeetingModal commissionId={commission.id} onClose={() => setOpen(false)} onSaved={() => { setOpen(false); void reload(); }} />}
    </Card>
  );
}

function Issues({ commission }: { commission: any }) {
  const { data, reload } = useApi<any[]>(`/commissions/${commission.id}/issues`);
  const canManage = commission.capabilities.includes('issue.manage');
  const canRaise = canManage || ['chair', 'vice_chair', 'secretary', 'member'].includes(commission.myPosition);
  const referrals = useApi<any[]>(canManage ? `/referrals?commissionId=${commission.id}` : null);
  const members = useApi<any[]>(canManage ? `/commissions/${commission.id}/members` : null);
  const [form, setForm] = useState({ title: '', description: '' });
  const [refFor, setRefFor] = useState<any | null>(null);
  const add = async () => {
    await post(`/commissions/${commission.id}/issues`, form);
    setForm({ title: '', description: '' });
    void reload();
  };
  return (
    <div className="grid grid-2">
      <Card title="مسائل و موضوعات کمیسیون">
        {canRaise && <div className="row gap-sm mb">
          <input className="input" placeholder="عنوان موضوع جدید" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
          <Button disabled={form.title.length < 3} onClick={add}>
            ثبت
          </Button>
        </div>}
        {data?.length === 0 && <Empty>موضوعی ثبت نشده است.</Empty>}
        <ul className="list">
          {data?.map((i) => (
            <li key={i.id}>
              <div className="row between gap">
                <strong>{i.title}</strong>
                <Badge tone={i.status === 'open' ? 'info' : i.status === 'resolved' ? 'success' : 'accent'}>{ISSUE_STATUS_LABELS[i.status as IssueStatus]}</Badge>
              </div>
              <div className="muted small">
                {i.created_by_name} — {dateFa(i.created_at)} — {fa(i.referral_count)} ارجاع
              </div>
              {canManage && (
                <div className="row gap-sm">
                  <Button size="sm" variant="ghost" onClick={() => setRefFor(i)}>
                    ارجاع به کارشناس
                  </Button>
                  {i.status !== 'resolved' && (
                    <Button size="sm" variant="ghost" onClick={async () => { await patch(`/issues/${i.id}`, { status: 'resolved' }); void reload(); }}>
                      حل‌شده
                    </Button>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      </Card>
      {canManage && (
        <Card title="ارجاعات کارشناسی">
          {referrals.data?.length === 0 && <Empty>ارجاعی ثبت نشده است.</Empty>}
          <ul className="list">
            {referrals.data?.map((r) => (
              <li key={r.id}>
                <div className="row between">
                  <strong>{r.expert_name}</strong>
                  <Badge tone={r.status === 'answered' ? 'success' : 'warning'}>{r.status === 'answered' ? 'پاسخ داده شد' : 'در انتظار پاسخ'}</Badge>
                </div>
                <div className="small">{r.request}</div>
                {r.issue_title && <div className="muted small">موضوع: {r.issue_title}</div>}
                {r.response && <div className="alert alert-success small mt">{r.response}</div>}
              </li>
            ))}
          </ul>
        </Card>
      )}
      {refFor && (
        <ReferralModal
          commissionId={commission.id}
          issue={refFor}
          experts={(members.data ?? []).filter((m) => m.position === 'expert')}
          onClose={() => setRefFor(null)}
          onSaved={() => { setRefFor(null); void reload(); void referrals.reload(); }}
        />
      )}
    </div>
  );
}

function ReferralModal({ commissionId, issue, experts, onClose, onSaved }: { commissionId: string; issue: any; experts: any[]; onClose: () => void; onSaved: () => void }) {
  const [expertId, setExpertId] = useState(experts[0]?.user_id ?? '');
  const [request, setRequest] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [err, setErr] = useState<Error | null>(null);
  const save = async () => {
    try {
      await post('/referrals', { commissionId, issueId: issue.id, expertId, request, dueDate: dueDate || null });
      onSaved();
    } catch (e) {
      setErr(e as Error);
    }
  };
  return (
    <Modal title={`ارجاع کارشناسی — ${issue.title}`} onClose={onClose} footer={<Button onClick={save}>ارسال</Button>}>
      <ErrorBox error={err} />
      {experts.length === 0 && <div className="alert alert-warning">کارشناسی در این کمیسیون تعریف نشده است.</div>}
      <Field label="کارشناس">
        <select className="input" value={expertId} onChange={(e) => setExpertId(e.target.value)}>
          {experts.map((e) => (
            <option key={e.user_id} value={e.user_id}>
              {e.full_name}
            </option>
          ))}
        </select>
      </Field>
      <Field label="شرح درخواست">
        <textarea className="input" value={request} onChange={(e) => setRequest(e.target.value)} />
      </Field>
      <Field label="مهلت پاسخ">
        <JalaliDateInput value={dueDate} onChange={setDueDate} />
      </Field>
    </Modal>
  );
}

function Settings({ commission, onSaved }: { commission: any; onSaved: () => void }) {
  const { isAdmin } = useAuth();
  const [s, setS] = useState<CommissionSettings>(commission.settings);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<Error | null>(null);
  const save = async () => {
    try {
      await patch(`/commissions/${commission.id}`, { settings: s });
      setMsg('تنظیمات ذخیره شد');
      onSaved();
    } catch (e) {
      setErr(e as Error);
    }
  };
  const disabled = !isAdmin;
  const check = (k: keyof CommissionSettings, label: string) => (
    <label className="check">
      <input type="checkbox" disabled={disabled} checked={!!s[k]} onChange={(e) => setS({ ...s, [k]: e.target.checked })} /> {label}
    </label>
  );
  return (
    <Card title="قواعد نصاب و رأی‌گیری" actions={isAdmin && <Button onClick={save}>ذخیره</Button>}>
      {msg && <div className="alert alert-success">{msg}</div>}
      <ErrorBox error={err} />
      <div className="grid grid-2">
        <div>
          <h3 className="mb">حد نصاب</h3>
          <Field label="نوع محاسبه">
            <select className="input" disabled={disabled} value={s.quorum.type} onChange={(e) => setS({ ...s, quorum: { ...s.quorum, type: e.target.value as any } })}>
              <option value="majority">نصف به‌علاوه یک</option>
              <option value="two_thirds">دو سوم</option>
              <option value="percent">درصد مشخص</option>
              <option value="fixed">تعداد ثابت</option>
            </select>
          </Field>
          {(s.quorum.type === 'percent' || s.quorum.type === 'fixed') && (
            <Field label={s.quorum.type === 'percent' ? 'درصد' : 'تعداد نفرات'}>
              <input className="input" type="number" disabled={disabled} value={s.quorum.value ?? ''} onChange={(e) => setS({ ...s, quorum: { ...s.quorum, value: Number(e.target.value) } })} />
            </Field>
          )}
          <label className="check">
            <input type="checkbox" disabled={disabled} checked={s.quorum.countOnline} onChange={(e) => setS({ ...s, quorum: { ...s.quorum, countOnline: e.target.checked } })} /> حضور آنلاین در نصاب محاسبه شود
          </label>
          <label className="check">
            <input type="checkbox" disabled={disabled} checked={s.quorum.countProxy} onChange={(e) => setS({ ...s, quorum: { ...s.quorum, countProxy: e.target.checked } })} /> حضور نماینده در نصاب محاسبه شود
          </label>
          {check('allowProxy', 'حضور نماینده به‌جای عضو مجاز است')}
          {check('proxyCanVote', 'نماینده به‌جای مدعو دارای حق رأی، رأی می‌دهد')}
          {check('requireDelegateLetter', 'معرفی نماینده فقط با بارگذاری معرفی‌نامه رسمی')}
          {check('requireQuorumToStart', 'شروع رسمی جلسه بدون نصاب ممنوع است')}
          {check('requireQuorumForVoting', 'رأی‌گیری بدون نصاب ممنوع است')}
        </div>
        <div>
          <h3 className="mb">رأی‌گیری و اجرا</h3>
          <Field label="قاعده تصویب">
            <select className="input" disabled={disabled} value={s.passRule} onChange={(e) => setS({ ...s, passRule: e.target.value as any })}>
              <option value="majority_of_present">اکثریت مطلق حاضرین</option>
              <option value="majority_of_cast">اکثریت آرای مأخوذه</option>
              <option value="simple_majority">موافق بیشتر از مخالف</option>
              <option value="two_thirds_of_present">دو سوم حاضرین</option>
            </select>
          </Field>
          <Field label="نمایش نتیجه رأی">
            <select className="input" disabled={disabled} value={s.resultVisibility} onChange={(e) => setS({ ...s, resultVisibility: e.target.value as any })}>
              <option value="invitees">همه حاضرین جلسه</option>
              <option value="officers">فقط رئیس و دبیر</option>
            </select>
          </Field>
          {check('secretVoteDefault', 'رأی‌گیری به‌صورت پیش‌فرض مخفی باشد')}
          {check('allowComments', 'اعضا امکان ثبت نظر روی دستور جلسه دارند')}
          {check('allowParallelAgenda', 'فعال بودن هم‌زمان چند آیتم دستور جلسه')}
          <Field label="یادآوری سررسید مصوبات (روز قبل)">
            <input className="input" type="number" disabled={disabled} value={s.dueSoonDays} onChange={(e) => setS({ ...s, dueSoonDays: Number(e.target.value) })} />
          </Field>
        </div>
      </div>
    </Card>
  );
}
