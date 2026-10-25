import { useId, useState } from 'react';
import { patch, upload } from '../lib/api';
import { useApi } from '../lib/hooks';
import { Badge, Button, Card, dateFa, ErrorBox, Field, fa, Modal, Progress } from './ui';

/** Executive bodies (دستگاه‌های اجرایی) of a resolution: one lead and partners, each reporting its own progress. */

export interface ExecutorDraft {
  name: string;
  role: 'lead' | 'partner';
}

/** Rows of bodies; names come from the chamber's list as you type, and a new name joins it. */
export function ExecutorsEditor({ chamberId, value, onChange }: { chamberId: string; value: ExecutorDraft[]; onChange: (v: ExecutorDraft[]) => void }) {
  const listId = useId();
  const orgs = useApi<{ id: string; name: string }[]>(`/organizations?chamberId=${chamberId}`);
  const set = (i: number, patchRow: Partial<ExecutorDraft>) =>
    onChange(value.map((e, j) => (j === i ? { ...e, ...patchRow } : patchRow.role === 'lead' ? { ...e, role: 'partner' } : e)));
  return (
    <div className="exec-editor">
      <datalist id={listId}>
        {(orgs.data ?? []).map((o) => (
          <option key={o.id} value={o.name} />
        ))}
      </datalist>
      {value.length === 0 && <p className="muted small">دستگاهی تعیین نشده است.</p>}
      {value.map((e, i) => (
        <div key={i} className="exec-row">
          <input
            className="input"
            list={listId}
            placeholder="نام دستگاه اجرایی، مثلاً سازمان صمت استان"
            aria-label={`دستگاه ${i + 1}`}
            value={e.name}
            onChange={(ev) => set(i, { name: ev.target.value })}
          />
          <label className="check" style={{ margin: 0, whiteSpace: 'nowrap' }}>
            <input type="radio" name={`${listId}-lead`} checked={e.role === 'lead'} onChange={() => set(i, { role: 'lead' })} /> مسئول اصلی
          </label>
          <Button size="sm" variant="ghost" onClick={() => onChange(value.filter((_, j) => j !== i))} aria-label={`حذف ${e.name || `دستگاه ${i + 1}`}`}>
            <span style={{ color: 'var(--danger)' }}>حذف</span>
          </Button>
        </div>
      ))}
      <Button size="sm" variant="secondary" onClick={() => onChange([...value, { name: '', role: value.some((x) => x.role === 'lead') ? 'partner' : 'lead' }])} disabled={value.length >= 12}>
        + افزودن دستگاه اجرایی
      </Button>
    </div>
  );
}

/** Bodies to send to the API: empty rows left out, one lead. */
export const cleanExecutors = (v: ExecutorDraft[]) => {
  const rows = v.map((e) => ({ ...e, name: e.name.trim() })).filter((e) => e.name.length >= 2);
  if (rows.length && !rows.some((e) => e.role === 'lead')) rows[0] = { ...rows[0], role: 'lead' };
  return rows;
};

const STATUS: Record<string, { label: string; tone: 'neutral' | 'info' | 'success' }> = {
  open: { label: 'شروع نشده', tone: 'neutral' },
  in_progress: { label: 'در حال اجرا', tone: 'info' },
  done: { label: 'انجام شد', tone: 'success' },
};

/** The bodies of a resolution with their progress; officers and the person following it up record reports. */
export function ExecutorsCard({ r, onChanged }: { r: any; onChanged: () => void }) {
  const [reporting, setReporting] = useState<any | null>(null);
  const canReport = (r.canManage || r.isOwner) && !['done', 'cancelled', 'submitted'].includes(r.status);
  if (!r.executors?.length) return null;
  return (
    <Card title="دستگاه‌های اجرایی" className="mb">
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>دستگاه</th>
              <th>نقش</th>
              <th style={{ minWidth: 140 }}>پیشرفت</th>
              <th>وضعیت</th>
              <th>آخرین گزارش</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {r.executors.map((e: any) => (
              <tr key={e.id}>
                <td>{e.name}</td>
                <td>{e.role === 'lead' ? <Badge tone="accent">مسئول اصلی</Badge> : <Badge>همکار</Badge>}</td>
                <td>
                  <div className="row gap-sm">
                    <span className="small">{fa(e.progress)}٪</span>
                    <div className="grow">
                      <Progress value={e.progress} />
                    </div>
                  </div>
                </td>
                <td>
                  <Badge tone={STATUS[e.status]?.tone ?? 'neutral'}>{STATUS[e.status]?.label ?? e.status}</Badge>
                </td>
                <td className="small muted">{e.last_report_at ? dateFa(e.last_report_at) : '—'}</td>
                <td>
                  {canReport && (
                    <Button size="sm" variant="secondary" onClick={() => setReporting(e)}>
                      ثبت گزارش
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="muted small" style={{ marginBottom: 0 }}>
        پیشرفت کل مصوبه میانگین پیشرفت دستگاه‌هاست؛ وقتی همهٔ دستگاه‌ها به ۱۰۰٪ برسند، مصوبه برای بررسی دبیر ارسال می‌شود.
      </p>
      {reporting && (
        <ReportModal
          r={r}
          executor={reporting}
          onClose={() => setReporting(null)}
          onSaved={() => {
            setReporting(null);
            onChanged();
          }}
        />
      )}
    </Card>
  );
}

function ReportModal({ r, executor, onClose, onSaved }: { r: any; executor: any; onClose: () => void; onSaved: () => void }) {
  const [progress, setProgress] = useState<number>(executor.progress);
  const [note, setNote] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<Error | null>(null);
  const save = async () => {
    setBusy(true);
    setErr(null);
    try {
      const documentId = file ? (await upload({ resolutionId: r.id, kind: 'evidence' }, file)).id : undefined;
      await patch(`/resolutions/${r.id}/executors/${executor.id}/progress`, { progress, note: note.trim() || null, documentId });
      onSaved();
    } catch (e) {
      setErr(e as Error);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title={`گزارش پیشرفت — ${executor.name}`}
      onClose={onClose}
      footer={
        <Button busy={busy} onClick={() => void save()}>
          ثبت گزارش
        </Button>
      }
    >
      <ErrorBox error={err} />
      <Field label={`درصد پیشرفت این دستگاه: ${fa(progress)}٪`}>
        <input type="range" min={0} max={100} step={5} value={progress} onChange={(e) => setProgress(Number(e.target.value))} />
      </Field>
      <Field label="اقدام انجام‌شده">
        <textarea className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="مثلاً نامهٔ شمارهٔ … به دستگاه ارسال و پاسخ دریافت شد" />
      </Field>
      <Field label="مستند (اختیاری)">
        <input type="file" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
      </Field>
    </Modal>
  );
}
