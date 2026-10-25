import { MEETING_TYPE_LABELS, MEETING_TYPES, type MeetingType } from '@kx/shared';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, patch, post } from '../lib/api';
import { useApi } from '../lib/hooks';
import { Badge, Button, Card, ErrorBox, Field, fa, JalaliDateInput, Modal } from './ui';

/**
 * Meetings recorded from the archive (ثبت از سوابق): held before the system was used. They are entered with
 * their real day and hours, attendance, agenda, vote results and resolutions, then finalized as approved on paper.
 */

const pad = (n: number) => String(n).padStart(2, '0');
/** Day and hour in Iran of an instant. */
const tehranParts = (iso: string) => {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tehran', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const p = Object.fromEntries(f.formatToParts(new Date(iso)).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${pad(Number(p.hour))}:${p.minute}` };
};

function TimeInput({ value, onChange, label }: { value: string; onChange: (v: string) => void; label: string }) {
  return <input className="input ltr" type="time" aria-label={label} value={value} onChange={(e) => onChange(e.target.value)} />;
}

export function ArchivalMeetingModal({ commissions, commissionId, onClose }: { commissions: { id: string; name: string }[]; commissionId?: string; onClose: () => void }) {
  const nav = useNavigate();
  const [form, setForm] = useState({
    commissionId: commissionId ?? commissions[0]?.id ?? '',
    number: '',
    title: '',
    date: '',
    startTime: '10:00',
    endTime: '12:00',
    location: '',
    type: 'in_person' as MeetingType,
  });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<Error | null>(null);
  const save = async () => {
    setBusy(true);
    setErr(null);
    try {
      const m = await post<{ id: string }>('/meetings/archival', {
        ...form,
        number: form.number ? Number(form.number.replace(/[۰-۹]/g, (d) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d)))) : undefined,
        location: form.location || null,
      });
      nav(`/meetings/${m.id}`);
    } catch (e) {
      setErr(e as Error);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title="ثبت جلسهٔ برگزارشده (از سوابق)"
      wide
      onClose={onClose}
      footer={
        <Button busy={busy} disabled={!form.commissionId || form.title.trim().length < 2 || !form.date} onClick={() => void save()}>
          ثبت و ادامه
        </Button>
      }
    >
      <ErrorBox error={err} />
      <p className="muted small" style={{ marginTop: 0 }}>
        برای جلسه‌هایی که پیش از استفاده از سامانه برگزار شده‌اند. اعضای کمیسیون در همان تاریخ خودکار به‌عنوان مدعو می‌آیند؛ هیچ دعوت‌نامه، پیامک یا اعلانی فرستاده نمی‌شود.
        پس از ثبت، حضور و غیاب، دستور جلسه، نتیجهٔ رأی‌ها، مصوبات و اسکن صورتجلسهٔ امضاشده را وارد و در پایان «نهایی‌سازی» کنید.
      </p>
      {!commissionId && commissions.length > 1 && (
        <Field label="کمیسیون">
          <select className="input" value={form.commissionId} onChange={(e) => setForm({ ...form, commissionId: e.target.value })}>
            {commissions.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </Field>
      )}
      <div className="grid grid-3">
        <Field label="شمارهٔ جلسه" hint="همان شمارهٔ صورتجلسهٔ کاغذی">
          <input className="input ltr" inputMode="numeric" value={form.number} onChange={(e) => setForm({ ...form, number: e.target.value })} placeholder="خودکار" />
        </Field>
        <Field label="عنوان جلسه">
          <input className="input" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
        </Field>
        <Field label="تاریخ برگزاری">
          <JalaliDateInput value={form.date} onChange={(date) => setForm({ ...form, date })} />
        </Field>
        <Field label="ساعت شروع">
          <TimeInput label="ساعت شروع" value={form.startTime} onChange={(startTime) => setForm({ ...form, startTime })} />
        </Field>
        <Field label="ساعت پایان">
          <TimeInput label="ساعت پایان" value={form.endTime} onChange={(endTime) => setForm({ ...form, endTime })} />
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
      <Field label="مکان">
        <input className="input" value={form.location} onChange={(e) => setForm({ ...form, location: e.target.value })} />
      </Field>
    </Modal>
  );
}

/** Steps of recording an archived meeting, what is still missing, and the final step. */
export function ArchivalPanel({ m, onChanged, onTab }: { m: any; onChanged: () => void; onTab: (t: string) => void }) {
  const open = m.status === 'minutes_draft';
  const check = useApi<any>(`/meetings/${m.id}/archival/checklist`);
  const [editing, setEditing] = useState(false);
  const [finalizing, setFinalizing] = useState(false);
  const [err, setErr] = useState<Error | null>(null);
  const c = check.data;
  const refresh = () => {
    void check.reload();
    onChanged();
  };
  if (!open) {
    return (
      <div className="alert alert-success">
        <Badge tone="info">ثبت از سوابق</Badge> این جلسه از سوابق ثبت و صورتجلسهٔ آن به‌صورت کاغذی تأیید شده است{c?.signed_scans ? '؛ اسکن نسخهٔ امضاشده در «مستندات» است.' : '.'}
      </div>
    );
  }
  const step = (done: boolean, label: string, tab?: string, extra?: string) => (
    <li className={done ? 'arch-done' : ''}>
      <span className="arch-mark" aria-hidden>
        {done ? '✓' : '•'}
      </span>
      {tab ? (
        <button type="button" className="link-btn" onClick={() => onTab(tab)}>
          {label}
        </button>
      ) : (
        label
      )}
      {extra && <span className="muted small"> — {extra}</span>}
    </li>
  );
  const markAll = async () => {
    setErr(null);
    try {
      await post(`/meetings/${m.id}/attendance/bulk`, { status: 'manual_present', onlyUnset: true });
      refresh();
    } catch (e) {
      setErr(e as Error);
    }
  };
  return (
    <Card className="mb arch-panel">
      <div className="row between wrap gap-sm">
        <h2 style={{ margin: 0 }}>
          <Badge tone="info">ثبت از سوابق</Badge> ورود اطلاعات جلسهٔ برگزارشده
        </h2>
        <div className="row gap-sm wrap">
          <Button size="sm" variant="secondary" onClick={() => setEditing(true)}>
            ویرایش مشخصات و ساعت‌ها
          </Button>
          <Button size="sm" onClick={() => setFinalizing(true)}>
            نهایی‌سازی جلسه
          </Button>
        </div>
      </div>
      <ErrorBox error={err} />
      {c && (
        <ol className="arch-steps">
          {step(c.attendance_unset === 0, 'حاضرین و غایبین', 'attendance', c.attendance_unset ? `${fa(c.attendance_unset)} نفر هنوز وضعیت ندارند` : `${fa(c.invitees)} مدعو`)}
          {step(c.agenda > 0, 'دستور جلسه، خلاصهٔ مذاکرات و نتیجهٔ رأی‌ها', 'agenda', c.agenda ? `${fa(c.agenda)} آیتم` : undefined)}
          {step(c.resolutions > 0, 'مصوبات جلسه', 'resolutions', c.resolutions ? `${fa(c.resolutions)} مصوبه` : undefined)}
          {step(c.signed_scans > 0, 'اسکن صورتجلسهٔ امضاشده (نوع سند: صورتجلسهٔ امضاشده)', 'documents')}
          {step(false, 'نهایی‌سازی: صورتجلسه از داده‌ها ساخته و تأییدشده به‌صورت کاغذی ثبت می‌شود')}
        </ol>
      )}
      {c?.attendance_unset > 0 && (
        <Button size="sm" variant="secondary" onClick={() => void markAll()}>
          ثبت «حاضر» برای {fa(c.attendance_unset)} نفری که وضعیت ندارند
        </Button>
      )}
      {editing && (
        <ArchivalEditModal
          m={m}
          onClose={() => setEditing(false)}
          onSaved={() => {
            setEditing(false);
            refresh();
          }}
        />
      )}
      {finalizing && c && (
        <FinalizeModal
          m={m}
          c={c}
          onClose={() => setFinalizing(false)}
          onDone={() => {
            setFinalizing(false);
            refresh();
          }}
        />
      )}
    </Card>
  );
}

function ArchivalEditModal({ m, onClose, onSaved }: { m: any; onClose: () => void; onSaved: () => void }) {
  const start = tehranParts(m.started_at ?? m.scheduled_at);
  const end = tehranParts(m.ended_at ?? m.scheduled_at);
  const [form, setForm] = useState({ number: String(m.number), title: m.title, date: start.date, startTime: start.time, endTime: end.time, location: m.location ?? '', type: m.type });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<Error | null>(null);
  const save = async () => {
    setBusy(true);
    setErr(null);
    try {
      await patch(`/meetings/${m.id}`, { ...form, number: Number(form.number) || undefined, location: form.location || null });
      onSaved();
    } catch (e) {
      setErr(e as Error);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title="مشخصات جلسهٔ سوابق"
      wide
      onClose={onClose}
      footer={
        <Button busy={busy} onClick={() => void save()}>
          ذخیره
        </Button>
      }
    >
      <ErrorBox error={err} />
      <div className="grid grid-3">
        <Field label="شمارهٔ جلسه">
          <input className="input ltr" inputMode="numeric" value={form.number} onChange={(e) => setForm({ ...form, number: e.target.value })} />
        </Field>
        <Field label="عنوان">
          <input className="input" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
        </Field>
        <Field label="تاریخ برگزاری">
          <JalaliDateInput value={form.date} onChange={(date) => setForm({ ...form, date })} />
        </Field>
        <Field label="ساعت شروع">
          <TimeInput label="ساعت شروع" value={form.startTime} onChange={(startTime) => setForm({ ...form, startTime })} />
        </Field>
        <Field label="ساعت پایان">
          <TimeInput label="ساعت پایان" value={form.endTime} onChange={(endTime) => setForm({ ...form, endTime })} />
        </Field>
        <Field label="نوع جلسه">
          <select className="input" value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}>
            {MEETING_TYPES.map((t) => (
              <option key={t} value={t}>
                {MEETING_TYPE_LABELS[t]}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <Field label="مکان">
        <input className="input" value={form.location} onChange={(e) => setForm({ ...form, location: e.target.value })} />
      </Field>
    </Modal>
  );
}

function FinalizeModal({ m, c, onClose, onDone }: { m: any; c: any; onClose: () => void; onDone: () => void }) {
  const [regenerate, setRegenerate] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<Error | null>(null);
  const go = async () => {
    setBusy(true);
    setErr(null);
    try {
      await api(`/meetings/${m.id}/archival/finalize`, { method: 'POST', json: { regenerate } });
      onDone();
    } catch (e) {
      setErr(e as Error);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title="نهایی‌سازی جلسهٔ سوابق"
      onClose={onClose}
      footer={
        <Button busy={busy} onClick={() => void go()}>
          نهایی‌سازی
        </Button>
      }
    >
      <ErrorBox error={err} />
      <p style={{ marginTop: 0 }}>پس از نهایی‌سازی، صورتجلسه «تأییدشده به‌صورت کاغذی» ثبت می‌شود و جلسه مثل هر جلسهٔ تأییدشده قفل خواهد شد.</p>
      {c.attendance_unset > 0 && <div className="alert alert-warning">{fa(c.attendance_unset)} نفر هنوز وضعیت حضور ندارند و «غایب» ثبت می‌شوند.</div>}
      {c.signed_scans === 0 && <div className="alert alert-warning">اسکن صورتجلسهٔ امضاشده هنوز در «مستندات» بارگذاری نشده است.</div>}
      <label className="check">
        <input type="checkbox" checked={regenerate} onChange={(e) => setRegenerate(e.target.checked)} /> متن صورتجلسه از روی داده‌های ثبت‌شده (حاضرین، دستور جلسه، رأی‌ها) دوباره ساخته شود
      </label>
      {!regenerate && <p className="muted small">متنی که در زبانهٔ «صورتجلسه» ویرایش کرده‌اید همان‌طور ثبت می‌شود.</p>}
    </Modal>
  );
}

/** The result of a vote as written in the paper minutes. */
export function ManualVoteModal({ item, onClose, onSaved }: { item: any; onClose: () => void; onSaved: () => void }) {
  const [v, setV] = useState({ yes: '', no: '', abstain: '', passed: true });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<Error | null>(null);
  const n = (s: string) => Number(s.replace(/[۰-۹]/g, (d) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d)))) || 0;
  const save = async () => {
    setBusy(true);
    setErr(null);
    try {
      await post(`/agenda-items/${item.id}/vote/manual`, { yes: n(v.yes), no: n(v.no), abstain: n(v.abstain), passed: v.passed });
      onSaved();
    } catch (e) {
      setErr(e as Error);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title={`نتیجهٔ رأی — ${item.title}`}
      onClose={onClose}
      footer={
        <Button busy={busy} onClick={() => void save()}>
          ثبت نتیجه
        </Button>
      }
    >
      <ErrorBox error={err} />
      <p className="muted small" style={{ marginTop: 0 }}>
        تعداد آرا را مطابق صورتجلسهٔ کاغذی وارد کنید.
      </p>
      <div className="grid grid-3">
        <Field label="موافق">
          <input className="input ltr" inputMode="numeric" value={v.yes} onChange={(e) => setV({ ...v, yes: e.target.value })} />
        </Field>
        <Field label="مخالف">
          <input className="input ltr" inputMode="numeric" value={v.no} onChange={(e) => setV({ ...v, no: e.target.value })} />
        </Field>
        <Field label="ممتنع">
          <input className="input ltr" inputMode="numeric" value={v.abstain} onChange={(e) => setV({ ...v, abstain: e.target.value })} />
        </Field>
      </div>
      <div className="row gap">
        <label className="check" style={{ margin: 0 }}>
          <input type="radio" checked={v.passed} onChange={() => setV({ ...v, passed: true })} /> تصویب شد
        </label>
        <label className="check" style={{ margin: 0 }}>
          <input type="radio" checked={!v.passed} onChange={() => setV({ ...v, passed: false })} /> تصویب نشد
        </label>
      </div>
    </Modal>
  );
}

/** Discussion summary and decision of an agenda item, as written in the paper minutes. */
export function ItemSummaryModal({ item, onClose, onSaved }: { item: any; onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState({ discussionSummary: item.discussion_summary ?? '', decision: item.decision ?? '' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<Error | null>(null);
  const save = async () => {
    setBusy(true);
    setErr(null);
    try {
      await patch(`/agenda-items/${item.id}`, { discussionSummary: form.discussionSummary || null, decision: form.decision || null });
      onSaved();
    } catch (e) {
      setErr(e as Error);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title={`مذاکرات و تصمیم — ${item.title}`}
      wide
      onClose={onClose}
      footer={
        <Button busy={busy} onClick={() => void save()}>
          ذخیره
        </Button>
      }
    >
      <ErrorBox error={err} />
      <Field label="خلاصهٔ مذاکرات">
        <textarea className="input" rows={4} value={form.discussionSummary} onChange={(e) => setForm({ ...form, discussionSummary: e.target.value })} />
      </Field>
      <Field label="تصمیم جلسه">
        <textarea className="input" rows={3} value={form.decision} onChange={(e) => setForm({ ...form, decision: e.target.value })} />
      </Field>
    </Modal>
  );
}
