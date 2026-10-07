import { JALALI_MONTHS, MEETING_TYPE_LABELS, MEETING_TYPES, toGregorian, toJalali, type MeetingType } from '@kx/shared';
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { MeetingStatusBadge } from '../components/status';
import { Badge, Button, Card, dateTimeFa, Empty, ErrorBox, Field, fa, JalaliDateTimeInput, Loading, Modal, PageHeader } from '../components/ui';
import { post } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useApi } from '../lib/hooks';

export function MeetingsPage() {
  const nav = useNavigate();
  const { me } = useAuth();
  const now = new Date();
  const [[jy, jm], setMonth] = useState(() => {
    const [y, m] = toJalali(now.getFullYear(), now.getMonth() + 1, now.getDate());
    return [y, m] as [number, number];
  });
  const [mine, setMine] = useState(false);
  const range = useMemo(() => {
    const [gy, gm, gd] = toGregorian(jy, jm, 1);
    const [ny, nm] = jm === 12 ? [jy + 1, 1] : [jy, jm + 1];
    const [gy2, gm2, gd2] = toGregorian(ny, nm, 1);
    return { from: new Date(gy, gm - 1, gd).toISOString(), to: new Date(gy2, gm2 - 1, gd2).toISOString() };
  }, [jy, jm]);
  const { data, loading, reload } = useApi(`/meetings?from=${range.from}&to=${range.to}&pageSize=100&mine=${mine}`);
  const [open, setOpen] = useState(false);
  // Meetings are created by each commission's secretary/chair (executive work), not by the chamber admin.
  const canCreate = me!.memberships.some((m) => ['chair', 'vice_chair', 'secretary'].includes(m.position));
  const shift = (d: number) => {
    let m = jm + d;
    let y = jy;
    if (m < 1) [m, y] = [12, y - 1];
    if (m > 12) [m, y] = [1, y + 1];
    setMonth([y, m]);
  };

  const byDay = useMemo(() => {
    const groups = new Map<string, any[]>();
    for (const m of data?.items ?? []) {
      const d = new Date(m.scheduled_at);
      const key = fa(toJalali(d.getFullYear(), d.getMonth() + 1, d.getDate())[2]);
      groups.set(key, [...(groups.get(key) ?? []), m]);
    }
    return [...groups.entries()];
  }, [data]);

  return (
    <>
      <PageHeader
        title="تقویم جلسات"
        actions={
          <>
            <label className="check" style={{ margin: 0 }}>
              <input type="checkbox" checked={mine} onChange={(e) => setMine(e.target.checked)} /> فقط جلسات من
            </label>
            {canCreate && <Button onClick={() => setOpen(true)}>جلسه جدید</Button>}
          </>
        }
      />
      <Card>
        <div className="row between mb">
          <Button variant="secondary" size="sm" onClick={() => shift(-1)}>
            ماه قبل
          </Button>
          <h2>
            {JALALI_MONTHS[jm - 1]} {fa(jy)}
          </h2>
          <Button variant="secondary" size="sm" onClick={() => shift(1)}>
            ماه بعد
          </Button>
        </div>
        {loading && !data ? (
          <Loading />
        ) : byDay.length === 0 ? (
          <Empty>در این ماه جلسه‌ای ثبت نشده است.</Empty>
        ) : (
          byDay.map(([day, items]) => (
            <div key={day} className="row gap" style={{ alignItems: 'flex-start', borderBottom: '1px solid var(--border)', padding: '10px 0' }}>
              <div style={{ width: 56, textAlign: 'center' }}>
                <div style={{ fontSize: '1.5rem', fontWeight: 700 }}>{day}</div>
                <div className="muted small">{JALALI_MONTHS[jm - 1]}</div>
              </div>
              <div className="grow col gap-sm">
                {items.map((m) => (
                  <div key={m.id} className="agenda-item row between gap wrap" style={{ cursor: 'pointer', marginBottom: 0 }} onClick={() => nav(`/meetings/${m.id}`)}>
                    <div>
                      <strong>
                        {m.commission_name} — جلسه {fa(m.number)}
                      </strong>
                      <div>{m.title}</div>
                      <div className="muted small">
                        {dateTimeFa(m.scheduled_at)} — {MEETING_TYPE_LABELS[m.type as MeetingType]}
                        {m.location ? ` — ${m.location}` : ''}
                      </div>
                    </div>
                    <div className="row gap-sm">
                      {m.my_role && <Badge tone="info">دعوت‌شده</Badge>}
                      <MeetingStatusBadge status={m.status} />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))
        )}
      </Card>
      {open && <NewMeetingModal onClose={() => setOpen(false)} onSaved={(id) => { setOpen(false); void reload(); nav(`/meetings/${id}`); }} />}
    </>
  );
}

export function NewMeetingModal({ commissionId, onClose, onSaved }: { commissionId?: string; onClose: () => void; onSaved: (id: string) => void }) {
  const { me } = useAuth();
  const commissions = useApi(commissionId ? null : '/commissions?pageSize=100');
  const options = (commissions.data?.items ?? []).filter(
    (c: any) => ['chair', 'vice_chair', 'secretary'].includes(c.my_position),
  );
  const [form, setForm] = useState({
    commissionId: commissionId ?? '',
    title: '',
    scheduledAt: '',
    durationMinutes: 90,
    type: 'in_person' as MeetingType,
    location: '',
    onlineLink: '',
  });
  const [agenda, setAgenda] = useState<string[]>(['']);
  const [err, setErr] = useState<Error | null>(null);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      const r = await post('/meetings', {
        ...form,
        commissionId: form.commissionId || options[0]?.id,
        location: form.location || null,
        onlineLink: form.onlineLink || null,
        agenda: agenda.filter((a) => a.trim().length >= 2).map((title) => ({ title })),
        schedule: true,
      });
      onSaved(r.id);
    } catch (e) {
      setErr(e as Error);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title="جلسه جدید" wide onClose={onClose} footer={<Button busy={busy} onClick={save}>ایجاد جلسه</Button>}>
      <ErrorBox error={err} />
      {!commissionId && (
        <Field label="کمیسیون">
          <select className="input" value={form.commissionId || options[0]?.id || ''} onChange={(e) => setForm({ ...form, commissionId: e.target.value })}>
            {options.map((c: any) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </Field>
      )}
      <Field label="عنوان جلسه">
        <input className="input" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
      </Field>
      <div className="grid grid-3">
        <Field label="تاریخ و ساعت (شمسی)">
          <JalaliDateTimeInput value={form.scheduledAt} onChange={(v) => setForm({ ...form, scheduledAt: v })} />
        </Field>
        <Field label="مدت (دقیقه)">
          <input className="input" type="number" value={form.durationMinutes} onChange={(e) => setForm({ ...form, durationMinutes: Number(e.target.value) })} />
        </Field>
        <Field label="نوع جلسه">
          <select className="input" value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value as MeetingType })}>
            {MEETING_TYPES.map((t) => (
              <option key={t} value={t}>
                {MEETING_TYPE_LABELS[t]}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <div className="grid grid-2">
        {form.type !== 'online' && (
          <Field label="مکان">
            <input className="input" value={form.location} onChange={(e) => setForm({ ...form, location: e.target.value })} />
          </Field>
        )}
        {form.type !== 'in_person' && (
          <Field label="لینک جلسه آنلاین">
            <input className="input ltr" value={form.onlineLink} onChange={(e) => setForm({ ...form, onlineLink: e.target.value })} />
          </Field>
        )}
      </div>
      <h3 className="mb">دستور جلسه</h3>
      {agenda.map((a, i) => (
        <div className="row gap-sm mb" key={i}>
          <span className="muted">{fa(i + 1)}.</span>
          <input className="input" value={a} onChange={(e) => setAgenda(agenda.map((x, j) => (j === i ? e.target.value : x)))} />
          <Button variant="ghost" size="sm" onClick={() => setAgenda(agenda.filter((_, j) => j !== i))}>
            حذف
          </Button>
        </div>
      ))}
      <Button variant="secondary" size="sm" onClick={() => setAgenda([...agenda, ''])}>
        + آیتم
      </Button>
      <p className="muted small mt">همه اعضای فعال کمیسیون (به‌جز کارشناسان) به‌صورت خودکار دعوت می‌شوند؛ مدعوین را بعداً در صفحه جلسه اضافه کنید.</p>
    </Modal>
  );
}
