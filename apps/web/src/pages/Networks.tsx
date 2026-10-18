import { NETWORK_PROPOSAL_STATUS_LABELS, NETWORK_PROPOSAL_STATUSES, RESOLUTION_STATUS_LABELS, type NetworkProposalStatus, type ResolutionStatus } from '@kx/shared';
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { del, patch, post } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useApi } from '../lib/hooks';
import { Badge, Button, Card, dateFa, Empty, ErrorBox, Field, fa, Loading, Modal, PageHeader, Progress, Stat, Tabs } from '../components/ui';

const PROPOSAL_TONE: Record<NetworkProposalStatus, 'warning' | 'info' | 'success' | 'neutral'> = {
  new: 'warning',
  reviewing: 'info',
  forwarded: 'success',
  closed: 'neutral',
};

/** Thematic networks of commissions across chambers (شبکه‌های موضوعی). */
export function NetworksPage() {
  const { me } = useAuth();
  const { data, loading, reload } = useApi<any[]>('/networks');
  const [open, setOpen] = useState(false);
  return (
    <>
      <PageHeader
        title="شبکه‌های موضوعی کمیسیون‌ها"
        subtitle="کمیسیون‌های هم‌موضوع اتاق‌های استان‌ها؛ اشتراک مصوبات، حمایت و پیشنهادهای ملی"
        actions={me?.is_super_admin && <Button onClick={() => setOpen(true)}>شبکه جدید</Button>}
      />
      {loading && <Loading />}
      {data && data.length === 0 && (
        <Card>
          <Empty>
            {me?.is_super_admin ? 'هنوز شبکه‌ای تعریف نشده است.' : 'کمیسیون‌های شما هنوز عضو هیچ شبکه‌ای نیستند. مدیر اتاق می‌تواند کمیسیون را به شبکه مربوط اضافه کند.'}
          </Empty>
        </Card>
      )}
      <div className="grid grid-2">
        {data?.map((n) => (
          <Link key={n.id} to={`/networks/${n.id}`} className="card net-card">
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <h3 style={{ margin: 0 }}>{n.name}</h3>
              <span className="row gap-sm">
                {n.is_coordinator && <Badge tone="accent">دبیر شبکه</Badge>}
                {n.status === 'archived' && <Badge>بایگانی</Badge>}
              </span>
            </div>
            {n.description && <p className="muted small">{n.description}</p>}
            <div className="row gap-sm wrap small">
              <Badge tone="info">{fa(n.chamber_count)} اتاق</Badge>
              <Badge tone="info">{fa(n.commission_count)} کمیسیون</Badge>
              <Badge>{fa(n.shared_count)} مصوبه مشترک</Badge>
              {Number(n.proposal_count) > 0 && <Badge tone="success">{fa(n.proposal_count)} پیشنهاد ملی</Badge>}
            </div>
          </Link>
        ))}
      </div>
      {open && <NetworkModal onClose={() => setOpen(false)} onSaved={() => { setOpen(false); void reload(); }} />}
    </>
  );
}

function NetworkModal({ network, onClose, onSaved }: { network?: any; onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState({
    name: network?.name ?? '',
    description: network?.description ?? '',
    endorseThreshold: network?.endorse_threshold ?? 3,
    status: network?.status ?? 'active',
  });
  const [err, setErr] = useState<Error | null>(null);
  const save = async () => {
    try {
      const payload = { ...form, description: form.description || null, endorseThreshold: Number(form.endorseThreshold) };
      if (network) await patch(`/networks/${network.id}`, payload);
      else await post('/networks', payload);
      onSaved();
    } catch (e) {
      setErr(e as Error);
    }
  };
  return (
    <Modal title={network ? 'ویرایش شبکه' : 'شبکه جدید'} onClose={onClose} footer={<Button onClick={save}>ذخیره</Button>}>
      <ErrorBox error={err} />
      <Field label="نام شبکه" hint="مثلاً «شبکه ملی انرژی و محیط زیست»">
        <input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
      </Field>
      <Field label="شرح">
        <textarea className="input" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
      </Field>
      <Field label="حد نصاب پیشنهاد ملی" hint="تعداد اتاق‌هایی (با احتساب اتاق مبدأ) که حمایت آن‌ها مصوبه را به پیشنهاد ملی تبدیل می‌کند">
        <input className="input ltr" type="number" min={2} max={40} value={form.endorseThreshold} onChange={(e) => setForm({ ...form, endorseThreshold: e.target.value })} />
      </Field>
      {network && (
        <label className="check">
          <input type="checkbox" checked={form.status === 'archived'} onChange={(e) => setForm({ ...form, status: e.target.checked ? 'archived' : 'active' })} /> بایگانی شبکه
        </label>
      )}
    </Modal>
  );
}

type Tab = 'commissions' | 'shared' | 'proposals' | 'dashboard' | 'settings';

export function NetworkDetailPage() {
  const { id } = useParams();
  const { data: n, error, reload } = useApi<any>(`/networks/${id}`);
  const [tab, setTab] = useState<Tab>('shared');
  if (error) return <ErrorBox error={error} />;
  if (!n) return <Loading />;
  const p = n.permissions;
  const tabs: { id: Tab; label: string }[] = [
    { id: 'shared', label: 'مصوبات مشترک' },
    { id: 'proposals', label: 'پیشنهادهای ملی' },
    { id: 'commissions', label: `کمیسیون‌های عضو (${fa(n.commissions.length)})` },
    ...(p.dashboard ? [{ id: 'dashboard' as Tab, label: 'داشبورد مقایسه‌ای' }] : []),
    ...(p.manage ? [{ id: 'settings' as Tab, label: 'تنظیمات و دبیران شبکه' }] : []),
  ];
  return (
    <>
      <PageHeader
        title={n.name}
        subtitle={
          <>
            {n.description ?? 'شبکه موضوعی کمیسیون‌ها'} — پیشنهاد ملی با حمایت {fa(n.endorse_threshold)} اتاق
            {n.coordinators.length > 0 && <> — دبیر شبکه: {n.coordinators.map((c: any) => c.full_name).join('، ')}</>}
          </>
        }
        actions={n.status === 'archived' && <Badge>بایگانی</Badge>}
      />
      <Tabs tabs={tabs} value={tab} onChange={setTab} />
      {tab === 'shared' && <SharedResolutions network={n} proposalsOnly={false} />}
      {tab === 'proposals' && <SharedResolutions network={n} proposalsOnly />}
      {tab === 'commissions' && <MemberCommissions network={n} reload={reload} />}
      {tab === 'dashboard' && <NetworkDashboard network={n} />}
      {tab === 'settings' && <NetworkSettings network={n} reload={reload} />}
    </>
  );
}

function SharedResolutions({ network, proposalsOnly }: { network: any; proposalsOnly: boolean }) {
  const [q, setQ] = useState('');
  const { data, reload } = useApi<any>(`/networks/${network.id}/resolutions?proposals=${proposalsOnly}&q=${encodeURIComponent(q)}`);
  const [endorsing, setEndorsing] = useState<any | null>(null);
  const [following, setFollowing] = useState<any | null>(null);
  const [err, setErr] = useState<Error | null>(null);
  const actFor: string[] = network.permissions.actFor;
  const commissionName = (id: string) => network.commissions.find((c: any) => c.id === id)?.name ?? '';
  const withdraw = async (r: any, commissionId: string) => {
    if (!confirm('حمایت این کمیسیون از مصوبه پس گرفته شود؟')) return;
    try {
      await del(`/networks/${network.id}/resolutions/${r.id}/endorsements/${commissionId}`);
      void reload();
    } catch (e) {
      setErr(e as Error);
    }
  };
  return (
    <>
      <ErrorBox error={err} />
      <Card>
        <p className="muted small" style={{ marginTop: 0 }}>
          {proposalsOnly
            ? `مصوباتی که با حمایت دست‌کم ${fa(network.endorse_threshold)} اتاق به پیشنهاد ملی تبدیل شده‌اند و دبیر شبکه در اتاق ایران آن‌ها را پیگیری می‌کند.`
            : 'مصوباتی که کمیسیون‌های عضو در شبکه منتشر کرده‌اند. رئیس، دبیر یا مدیر اتاقِ کمیسیون‌های دیگر می‌توانند از آن‌ها حمایت کنند.'}
        </p>
        <input className="input mb" placeholder="جستجو در متن، شماره یا نام کمیسیون" value={q} onChange={(e) => setQ(e.target.value)} />
        {data?.items.length === 0 && <Empty>{proposalsOnly ? 'هنوز پیشنهاد ملی‌ای شکل نگرفته است.' : 'هنوز مصوبه‌ای در این شبکه منتشر نشده است.'}</Empty>}
        <div className="net-feed">
          {data?.items.map((r: any) => {
            const own = actFor.includes(r.commission_id);
            const endorsedBy = new Set(r.endorsements.map((e: any) => e.commission_id));
            const canEndorseWith = actFor.filter((c) => c !== r.commission_id && !endorsedBy.has(c));
            const mine = actFor.filter((c) => endorsedBy.has(c));
            return (
              <article key={r.id} className="net-item">
                <header className="row wrap gap-sm" style={{ justifyContent: 'space-between' }}>
                  <span>
                    <strong>{r.commission_name}</strong> <span className="muted small">— {r.chamber_name}</span>
                  </span>
                  <span className="row gap-sm small">
                    <Badge>{r.number}</Badge>
                    <Badge tone={r.status === 'done' ? 'success' : 'info'}>{RESOLUTION_STATUS_LABELS[r.status as ResolutionStatus]}</Badge>
                    {r.proposal && <Badge tone={PROPOSAL_TONE[r.proposal.status as NetworkProposalStatus]}>پیشنهاد ملی: {NETWORK_PROPOSAL_STATUS_LABELS[r.proposal.status as NetworkProposalStatus]}</Badge>}
                  </span>
                </header>
                <p className="net-text">{r.text}</p>
                {r.share_note && <p className="muted small">یادداشت انتشار: {r.share_note}</p>}
                <div className="row wrap gap-sm small muted">
                  {r.addressee && <span>مخاطب: {r.addressee}</span>}
                  {r.due_date && <span>مهلت: {dateFa(r.due_date)}</span>}
                  <span style={{ minWidth: 120 }}>
                    پیشرفت اجرا: <Progress value={r.progress} />
                  </span>
                  <span>انتشار: {dateFa(r.shared_at)}{r.shared_by_name ? ` توسط ${r.shared_by_name}` : ''}</span>
                </div>
                <div className="net-support">
                  <div className="row gap-sm" style={{ alignItems: 'center' }}>
                    <strong className="small">حمایت اتاق‌ها: {fa(r.chamber_support)} از {fa(network.endorse_threshold)}</strong>
                    <div className="net-meter" aria-hidden>
                      <span style={{ width: `${Math.min(100, (100 * r.chamber_support) / network.endorse_threshold)}%` }} />
                    </div>
                  </div>
                  {r.endorsements.length > 0 && (
                    <ul className="list small">
                      {r.endorsements.map((e: any) => (
                        <li key={e.commission_id}>
                          <strong>{e.commission_name}</strong> <span className="muted">({e.chamber_name}، {dateFa(e.created_at)})</span>
                          {e.comment && <div>«{e.comment}»</div>}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
                {r.proposal?.response && (
                  <div className="alert alert-success small">
                    <strong>پاسخ دبیر شبکه:</strong> {r.proposal.response}
                  </div>
                )}
                <div className="row gap-sm wrap">
                  {!own && canEndorseWith.length > 0 && network.status === 'active' && (
                    <Button size="sm" onClick={() => setEndorsing({ r, options: canEndorseWith })}>
                      حمایت از این مصوبه
                    </Button>
                  )}
                  {mine.map((c) => (
                    <Button key={c} size="sm" variant="ghost" onClick={() => void withdraw(r, c)}>
                      پس‌گرفتن حمایت {commissionName(c)}
                    </Button>
                  ))}
                  {r.proposal && network.permissions.national && (
                    <Button size="sm" variant="secondary" onClick={() => setFollowing(r)}>
                      پیگیری پیشنهاد ملی
                    </Button>
                  )}
                  {own && <Link className="btn btn-ghost btn-sm" to={`/resolutions/${r.id}`}>صفحه مصوبه</Link>}
                </div>
              </article>
            );
          })}
        </div>
      </Card>
      {endorsing && (
        <EndorseModal network={network} resolution={endorsing.r} options={endorsing.options} commissionName={commissionName} onClose={() => setEndorsing(null)} onSaved={() => { setEndorsing(null); void reload(); }} />
      )}
      {following && <ProposalModal network={network} resolution={following} onClose={() => setFollowing(null)} onSaved={() => { setFollowing(null); void reload(); }} />}
    </>
  );
}

function EndorseModal({ network, resolution, options, commissionName, onClose, onSaved }: { network: any; resolution: any; options: string[]; commissionName: (id: string) => string; onClose: () => void; onSaved: () => void }) {
  const [commissionId, setCommissionId] = useState(options[0]);
  const [comment, setComment] = useState('');
  const [err, setErr] = useState<Error | null>(null);
  const [done, setDone] = useState<boolean | null>(null);
  const save = async () => {
    try {
      const r = await post(`/networks/${network.id}/resolutions/${resolution.id}/endorsements`, { commissionId, comment: comment || null });
      if (r.nationalProposal) setDone(true);
      else onSaved();
    } catch (e) {
      setErr(e as Error);
    }
  };
  if (done)
    return (
      <Modal title="پیشنهاد ملی" onClose={onSaved} footer={<Button onClick={onSaved}>بستن</Button>}>
        <div className="alert alert-success">با حمایت شما این مصوبه به حد نصاب رسید و به‌عنوان پیشنهاد ملی برای دبیر شبکه ارسال شد.</div>
      </Modal>
    );
  return (
    <Modal title={`حمایت از مصوبه ${resolution.number}`} onClose={onClose} footer={<Button onClick={save}>ثبت حمایت</Button>}>
      <ErrorBox error={err} />
      <p className="small">{resolution.text}</p>
      <Field label="از طرف کمیسیون">
        {options.length > 1 ? (
          <select className="input" value={commissionId} onChange={(e) => setCommissionId(e.target.value)}>
            {options.map((c) => (
              <option key={c} value={c}>
                {commissionName(c)}
              </option>
            ))}
          </select>
        ) : (
          <input className="input" readOnly value={commissionName(commissionId)} />
        )}
      </Field>
      <Field label="تجربه یا توضیح کمیسیون شما (اختیاری)" hint="مثلاً وضعیت همین مشکل در استان شما">
        <textarea className="input" value={comment} onChange={(e) => setComment(e.target.value)} />
      </Field>
    </Modal>
  );
}

function ProposalModal({ network, resolution, onClose, onSaved }: { network: any; resolution: any; onClose: () => void; onSaved: () => void }) {
  const [status, setStatus] = useState<NetworkProposalStatus>(resolution.proposal.status);
  const [response, setResponse] = useState(resolution.proposal.response ?? '');
  const [err, setErr] = useState<Error | null>(null);
  const save = async () => {
    try {
      await patch(`/networks/${network.id}/proposals/${resolution.id}`, { status, response: response || null });
      onSaved();
    } catch (e) {
      setErr(e as Error);
    }
  };
  return (
    <Modal title={`پیگیری پیشنهاد ملی ${resolution.number}`} onClose={onClose} footer={<Button onClick={save}>ذخیره و اطلاع به کمیسیون‌ها</Button>}>
      <ErrorBox error={err} />
      <p className="small">{resolution.text}</p>
      <Field label="وضعیت">
        <select className="input" value={status} onChange={(e) => setStatus(e.target.value as NetworkProposalStatus)}>
          {NETWORK_PROPOSAL_STATUSES.map((s) => (
            <option key={s} value={s}>
              {NETWORK_PROPOSAL_STATUS_LABELS[s]}
            </option>
          ))}
        </select>
      </Field>
      <Field label="پاسخ یا نتیجه پیگیری" hint="برای رئیس و دبیر کمیسیون مبدأ و کمیسیون‌های حامی ارسال می‌شود">
        <textarea className="input" value={response} onChange={(e) => setResponse(e.target.value)} />
      </Field>
    </Modal>
  );
}

function MemberCommissions({ network, reload }: { network: any; reload: () => void }) {
  const [adding, setAdding] = useState('');
  const [err, setErr] = useState<Error | null>(null);
  const act = async (fn: () => Promise<unknown>) => {
    setErr(null);
    try {
      await fn();
      setAdding('');
      reload();
    } catch (e) {
      setErr(e as Error);
    }
  };
  return (
    <Card>
      <ErrorBox error={err} />
      {network.joinable.length > 0 && network.status === 'active' && (
        <div className="row gap-sm mb wrap">
          <select className="input grow" value={adding} onChange={(e) => setAdding(e.target.value)} aria-label="افزودن کمیسیون">
            <option value="">افزودن کمیسیون به شبکه…</option>
            {network.joinable.map((c: any) => (
              <option key={c.id} value={c.id}>
                {c.name} — {c.chamber_name}
              </option>
            ))}
          </select>
          <Button disabled={!adding} onClick={() => act(() => post(`/networks/${network.id}/commissions`, { commissionId: adding }))}>
            افزودن
          </Button>
        </div>
      )}
      {network.commissions.length === 0 && <Empty>هنوز کمیسیونی به این شبکه نپیوسته است.</Empty>}
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>استان / اتاق</th>
              <th>کمیسیون</th>
              <th>رئیس</th>
              <th>دبیر</th>
              <th>اعضا</th>
              <th>مصوبات مشترک</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {network.commissions.map((c: any) => (
              <tr key={c.id}>
                <td>
                  <strong>{c.province}</strong>
                  <div className="muted small">{c.chamber_name}</div>
                </td>
                <td>
                  {c.name}
                  {c.domain && <div className="muted small">{c.domain}</div>}
                </td>
                <td>{c.chair_name ?? '—'}</td>
                <td>{c.secretary_name ?? '—'}</td>
                <td>{fa(c.member_count)}</td>
                <td>{fa(c.shared_count)}</td>
                <td>
                  {network.permissions.removable.includes(c.id) && (
                    <Button size="sm" variant="ghost" onClick={() => confirm(`«${c.name}» از شبکه خارج شود؟`) && act(() => del(`/networks/${network.id}/commissions/${c.id}`))}>
                      <span style={{ color: 'var(--danger)' }}>خروج از شبکه</span>
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function NetworkDashboard({ network }: { network: any }) {
  const { data } = useApi<any>(`/networks/${network.id}/dashboard`);
  if (!data) return <Loading />;
  const rows: any[] = data.commissions;
  const sum = (k: string) => rows.reduce((s, r) => s + Number(r[k] ?? 0), 0);
  const pct = (a: number, b: number) => (b ? Math.round((100 * a) / b) : 0);
  return (
    <>
      <div className="grid grid-4 mb">
        <Stat label="جلسات برگزارشده (۱۲ ماه)" value={fa(sum('meetings_held'))} />
        <Stat label="مصوبات" value={fa(sum('resolutions_total'))} hint={`${fa(pct(sum('resolutions_done'), sum('resolutions_total')))}٪ انجام‌شده`} />
        <Stat label="مصوبات منتشرشده در شبکه" value={fa(sum('shared'))} tone="info" />
        <Stat label="پیشنهادهای ملی" value={fa(data.proposals.total)} tone="success" hint={`${fa(data.proposals.new)} جدید، ${fa(data.proposals.forwarded)} ارسال‌شده`} />
      </div>
      <Card title={`مقایسه کمیسیون‌ها از ${dateFa(data.from)} تا ${dateFa(data.to)}`}>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>استان</th>
                <th>کمیسیون</th>
                <th>جلسات</th>
                <th>درصد حضور</th>
                <th>مصوبات</th>
                <th>درصد اجرا</th>
                <th>معوق</th>
                <th>منتشرشده</th>
                <th>حمایت داده</th>
                <th>حمایت گرفته</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td>{r.province}</td>
                  <td>{r.name}</td>
                  <td>{fa(r.meetings_held)}</td>
                  <td>{r.attendance_rate === null ? '—' : `${fa(r.attendance_rate)}٪`}</td>
                  <td>{fa(r.resolutions_total)}</td>
                  <td style={{ minWidth: 110 }}>
                    <Progress value={pct(r.resolutions_done, r.resolutions_total)} />
                  </td>
                  <td>{r.resolutions_overdue ? <Badge tone="danger">{fa(r.resolutions_overdue)}</Badge> : fa(0)}</td>
                  <td>{fa(r.shared)}</td>
                  <td>{fa(r.endorsements_given)}</td>
                  <td>{fa(r.endorsements_received)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </>
  );
}

function NetworkSettings({ network, reload }: { network: any; reload: () => void }) {
  const [editing, setEditing] = useState(false);
  const [q, setQ] = useState('');
  const people = useApi<any>(q.trim().length >= 2 ? `/people?q=${encodeURIComponent(q.trim())}&pageSize=10` : null);
  const [err, setErr] = useState<Error | null>(null);
  const act = async (fn: () => Promise<unknown>) => {
    setErr(null);
    try {
      await fn();
      setQ('');
      reload();
    } catch (e) {
      setErr(e as Error);
    }
  };
  return (
    <div className="grid grid-2">
      <Card title="مشخصات شبکه" actions={<Button size="sm" variant="secondary" onClick={() => setEditing(true)}>ویرایش</Button>}>
        <ul className="list">
          <li>نام: {network.name}</li>
          <li>شرح: {network.description ?? '—'}</li>
          <li>حد نصاب پیشنهاد ملی: حمایت {fa(network.endorse_threshold)} اتاق</li>
          <li>وضعیت: {network.status === 'active' ? 'فعال' : 'بایگانی'}</li>
        </ul>
      </Card>
      <Card title="دبیران شبکه">
        <ErrorBox error={err} />
        <p className="muted small" style={{ marginTop: 0 }}>
          دبیر شبکه همه مصوبات منتشرشده، داشبورد مقایسه‌ای و پیشنهادهای ملی این شبکه را می‌بیند و پیگیری پیشنهادها را ثبت می‌کند.
        </p>
        {network.coordinators.length === 0 && <Empty>دبیری تعیین نشده است.</Empty>}
        <ul className="list">
          {network.coordinators.map((c: any) => (
            <li key={c.id} className="row" style={{ justifyContent: 'space-between' }}>
              <span>
                {c.full_name} <span className="muted small">{c.organization ?? ''} {c.chamber_name ? `— ${c.chamber_name}` : ''}</span>
              </span>
              <Button size="sm" variant="ghost" onClick={() => act(() => del(`/networks/${network.id}/coordinators/${c.id}`))}>
                <span style={{ color: 'var(--danger)' }}>حذف</span>
              </Button>
            </li>
          ))}
        </ul>
        <Field label="افزودن دبیر شبکه" hint="جستجو در اشخاص همه اتاق‌ها">
          <input className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="نام، موبایل یا ایمیل" />
        </Field>
        <ul className="list small">
          {people.data?.items.map((p: any) => (
            <li key={p.id} className="row" style={{ justifyContent: 'space-between' }}>
              <span>
                {p.full_name} <span className="muted">— {p.chamber_name}</span>
              </span>
              <Button size="sm" variant="secondary" onClick={() => act(() => post(`/networks/${network.id}/coordinators`, { userId: p.id }))}>
                انتخاب
              </Button>
            </li>
          ))}
        </ul>
      </Card>
      {editing && <NetworkModal network={network} onClose={() => setEditing(false)} onSaved={() => { setEditing(false); reload(); }} />}
    </div>
  );
}

/** Card on the resolution page: publish the resolution to the networks of its commission. */
export function NetworkShareCard({ resolutionId }: { resolutionId: string }) {
  const { data, reload } = useApi<any>(`/resolutions/${resolutionId}/networks`);
  const [note, setNote] = useState('');
  const [err, setErr] = useState<Error | null>(null);
  const [busy, setBusy] = useState(false);
  if (!data || data.networks.length === 0) return null;
  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setErr(null);
    try {
      await fn();
      void reload();
    } catch (e) {
      setErr(e as Error);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card title="انتشار در شبکه کمیسیون‌ها" className="mt">
      <ErrorBox error={err} />
      <ul className="list small">
        {data.networks.map((n: any) => (
          <li key={n.id}>
            <Link to={`/networks/${n.id}`}>{n.name}</Link>
            {data.sharedAt && (
              <span className="muted">
                {' '}— {fa(n.endorsement_count)} حمایت
                {n.proposal_status && <> — <Badge tone={PROPOSAL_TONE[n.proposal_status as NetworkProposalStatus]}>پیشنهاد ملی: {NETWORK_PROPOSAL_STATUS_LABELS[n.proposal_status as NetworkProposalStatus]}</Badge></>}
              </span>
            )}
          </li>
        ))}
      </ul>
      {data.sharedAt ? (
        <>
          <div className="alert alert-success small">
            این مصوبه از {dateFa(data.sharedAt)} برای کمیسیون‌های هم‌موضوع اتاق‌های دیگر منتشر شده است.{data.shareNote && <> یادداشت: {data.shareNote}</>}
          </div>
          {data.canShare && !data.networks.some((n: any) => n.proposal_status) && (
            <Button size="sm" variant="ghost" busy={busy} onClick={() => confirm('انتشار این مصوبه لغو شود؟ حمایت‌های ثبت‌شده هم حذف می‌شود.') && act(() => del(`/resolutions/${resolutionId}/share`))}>
              لغو انتشار
            </Button>
          )}
        </>
      ) : data.canShare ? (
        <>
          <p className="muted small">
            با انتشار، متن مصوبه و وضعیت اجرای آن برای اعضای کمیسیون‌های این شبکه در اتاق‌های دیگر قابل مشاهده می‌شود تا در صورت مشابه بودن مسئله از آن حمایت کنند.
            آرا، صورتجلسه و مستندات منتشر نمی‌شود.
          </p>
          <Field label="یادداشت برای کمیسیون‌های دیگر (اختیاری)">
            <textarea className="input" value={note} onChange={(e) => setNote(e.target.value)} />
          </Field>
          <Button busy={busy} onClick={() => act(() => post(`/resolutions/${resolutionId}/share`, { note: note || null }))}>
            انتشار در شبکه
          </Button>
        </>
      ) : (
        <p className="muted small">این مصوبه در شبکه منتشر نشده است.</p>
      )}
    </Card>
  );
}
