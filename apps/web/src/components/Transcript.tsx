import { useEffect, useState } from 'react';
import { post } from '../lib/api';
import { useApi } from '../lib/hooks';
import { Badge, Button, Card, dateTimeFa, ErrorBox, fa, Field, type Tone } from './ui';

/** A resolution drafted from the meeting's recording, offered to the secretary for registering. */
export interface DraftResolution {
  text: string;
  agendaItemId: string | null;
  responsible: string | null;
  deadline: string | null;
}

const STATUS: Record<string, { label: string; tone: Tone }> = {
  queued: { label: 'در صف پردازش', tone: 'neutral' },
  transcribing: { label: 'در حال تبدیل گفتار به متن', tone: 'info' },
  drafting: { label: 'در حال تهیهٔ پیش‌نویس', tone: 'info' },
  done: { label: 'آماده', tone: 'success' },
  failed: { label: 'ناموفق', tone: 'danger' },
  cancelled: { label: 'لغو شد', tone: 'neutral' },
};
const OPEN = ['queued', 'transcribing', 'drafting'];

function saveText(name: string, text: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/**
 * «پیش‌نویس از فایل صوتی»: the meeting's recording becomes text on the organisation's own server, and a local model
 * drafts the minutes text and resolutions; the secretary edits the text before it goes into the minutes and
 * registers each resolution through the usual form.
 */
export function TranscriptPanel({
  m,
  onApplied,
  onResolution,
}: {
  m: any;
  onApplied: () => Promise<void>;
  onResolution: (r: DraftResolution, saved: () => void) => void;
}) {
  const { data, reload } = useApi<any>(`/meetings/${m.id}/transcripts`);
  const docs = useApi<any[]>(`/documents?meetingId=${m.id}`);
  const [documentId, setDocumentId] = useState('');
  const [pasting, setPasting] = useState(false);
  const [text, setText] = useState('');
  const [discussion, setDiscussion] = useState<string | null>(null);
  const [done, setDone] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<Error | null>(null);
  const [open, setOpen] = useState(false);
  const job = data?.items?.[0];
  const running = job && OPEN.includes(job.status);

  // While a job is running, its progress is checked every few seconds.
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => void reload(), 5000);
    return () => clearInterval(t);
  }, [running, reload]);
  useEffect(() => {
    setDiscussion(job?.status === 'done' ? (job.discussion ?? '') : null);
    setDone(new Set());
  }, [job?.id, job?.status, job?.discussion]);

  if (!data) return null;
  const sources = (docs.data ?? []).filter((d) => d.kind === 'recording' || d.mime_type === 'text/plain');
  const ready = data.transcription || data.drafting;
  const act = async (fn: () => Promise<unknown>) => {
    setErr(null);
    setBusy(true);
    try {
      await fn();
      await reload();
    } catch (e) {
      setErr(e as Error);
    } finally {
      setBusy(false);
    }
  };
  const agendaTitle = (id: string | null) => m.agenda.find((a: any) => a.id === id)?.title;

  if (!ready && !job) {
    return (
      <Card title="پیش‌نویس صورتجلسه از فایل صوتی">
        <p className="muted small" style={{ margin: 0 }}>
          با راه‌اندازی موتور تبدیل گفتار به متن (Whisper) و مدل زبانی (Ollama) روی سرور سامانه، فایل صوتی یا فیلم جلسه که در زبانهٔ «مستندات» بارگذاری شده، به
          متن تبدیل می‌شود و «شرح مذاکرات» و «پیش‌نویس مصوبات» برای بازبینی دبیر آماده می‌شود. هیچ فایلی از سرور خارج نمی‌شود. این موتورها هنوز روی این سرور
          راه‌اندازی نشده‌اند.
        </p>
      </Card>
    );
  }

  return (
    <Card
      title={
        <span className="row gap-sm">پیش‌نویس صورتجلسه از فایل صوتی {job && <Badge tone={STATUS[job.status].tone}>{STATUS[job.status].label}</Badge>}</span>
      }
    >
      <ErrorBox error={err} />
      {!running && (
        <div className="row gap-sm wrap mb" style={{ alignItems: 'flex-end' }}>
          {!pasting ? (
            <>
              <Field label="فایل جلسه" hint={sources.length ? undefined : 'ابتدا فایل صوتی یا فیلم جلسه را در زبانهٔ «مستندات» بارگذاری کنید'}>
                <select className="input" style={{ minWidth: 260 }} value={documentId} onChange={(e) => setDocumentId(e.target.value)}>
                  <option value="">—</option>
                  {sources.map((d) => (
                    <option key={d.id} value={d.id} disabled={d.kind === 'recording' ? !data.transcription : !data.drafting}>
                      {d.title ?? d.file_name}
                      {d.kind !== 'recording' ? ' (متن)' : ''}
                    </option>
                  ))}
                </select>
              </Field>
              <Button busy={busy} disabled={!documentId} onClick={() => act(() => post(`/meetings/${m.id}/transcripts`, { documentId }))}>
                تبدیل به متن و تهیهٔ پیش‌نویس
              </Button>
            </>
          ) : (
            <div style={{ flex: 1, minWidth: 260 }}>
              <Field label="متن پیاده‌شدهٔ جلسه">
                <textarea className="input" style={{ minHeight: 160 }} value={text} onChange={(e) => setText(e.target.value)} />
              </Field>
              <Button
                busy={busy}
                disabled={text.trim().length < 50}
                onClick={() => act(() => post(`/meetings/${m.id}/transcripts`, { text })).then(() => setPasting(false))}
              >
                تهیهٔ پیش‌نویس از این متن
              </Button>
            </div>
          )}
          {data.drafting && (
            <Button variant="ghost" size="sm" onClick={() => setPasting(!pasting)}>
              {pasting ? 'انتخاب فایل جلسه' : 'یا متن پیاده‌شده را وارد کنید'}
            </Button>
          )}
        </div>
      )}
      {!data.transcription && (
        <p className="muted small">موتور تبدیل گفتار به متن روی سرور راه‌اندازی نشده است؛ فعلاً فقط از متن پیاده‌شده پیش‌نویس تهیه می‌شود.</p>
      )}

      {job && (
        <div className="muted small mb">
          {job.file_name ? `فایل: ${job.file_name} — ` : 'از متن واردشده — '}
          درخواست {job.created_by_name} در {dateTimeFa(job.created_at)}
          {job.finished_at && ` — پایان ${dateTimeFa(job.finished_at)}`}
        </div>
      )}
      {running && (
        <div className="alert alert-info row between wrap gap-sm">
          <span>
            {STATUS[job.status].label}… تبدیل یک جلسهٔ دوساعته روی پردازندهٔ سرور ممکن است تا یک ساعت یا بیشتر طول بکشد. نتیجه با اعلان به شما خبر داده می‌شود و
            لازم نیست این صفحه باز بماند.
          </span>
          <Button size="sm" variant="danger" busy={busy} onClick={() => confirm('پردازش لغو شود؟') && act(() => post(`/transcripts/${job.id}/cancel`))}>
            لغو
          </Button>
        </div>
      )}
      {job?.status === 'failed' && (
        <div className="alert alert-danger row between wrap gap-sm">
          <span>{job.error}</span>
          <Button size="sm" busy={busy} onClick={() => act(() => post(`/transcripts/${job.id}/retry`))}>
            تلاش دوباره
          </Button>
        </div>
      )}

      {job?.status === 'done' && (
        <>
          {discussion !== null && job.discussion !== null && (
            <Field label="شرح مذاکرات جلسه (پیش‌نویس — پیش از افزودن بازبینی کنید)">
              <textarea className="input" style={{ minHeight: 220 }} value={discussion} onChange={(e) => setDiscussion(e.target.value)} />
            </Field>
          )}
          <div className="row gap-sm wrap mb">
            {job.discussion !== null && (
              <Button
                busy={busy}
                disabled={m.status !== 'minutes_draft' || !discussion?.trim()}
                onClick={() => act(() => post(`/transcripts/${job.id}/apply`, { discussion }).then(onApplied))}
              >
                {job.applied_at ? 'جایگزینی در صورتجلسه' : 'افزودن به صورتجلسه'}
              </Button>
            )}
            {data.drafting && (
              <Button
                variant="secondary"
                busy={busy}
                onClick={() => confirm('پیش‌نویس از روی همین متن دوباره تهیه شود؟') && act(() => post(`/transcripts/${job.id}/retry`))}
              >
                تهیهٔ دوبارهٔ پیش‌نویس
              </Button>
            )}
            {job.transcript && (
              <Button variant="ghost" onClick={() => saveText(`متن جلسه ${m.number ?? ''}.txt`, job.transcript)}>
                دریافت متن کامل
              </Button>
            )}
          </div>
          {job.applied_at && <p className="muted small">در {dateTimeFa(job.applied_at)} به صورتجلسه افزوده شد.</p>}

          {job.resolutions?.length > 0 && (
            <>
              <h4 style={{ marginBottom: 6 }}>پیش‌نویس مصوبات ({fa(job.resolutions.length)})</h4>
              <ul className="list">
                {job.resolutions.map((r: DraftResolution, i: number) => (
                  <li key={i} className="row between gap wrap">
                    <span style={{ flex: 1, minWidth: 220 }}>
                      {r.text}
                      <span className="muted small" style={{ display: 'block' }}>
                        {[
                          agendaTitle(r.agendaItemId) && `بند: ${agendaTitle(r.agendaItemId)}`,
                          r.responsible && `مسئول: ${r.responsible}`,
                          r.deadline && `مهلت: ${r.deadline}`,
                        ]
                          .filter(Boolean)
                          .join(' — ')}
                      </span>
                    </span>
                    {done.has(i) ? (
                      <Badge tone="success">ثبت شد</Badge>
                    ) : (
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={!m.capabilities.includes('resolution.manage')}
                        onClick={() => onResolution(r, () => setDone((s) => new Set(s).add(i)))}
                      >
                        ثبت مصوبه…
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            </>
          )}
          {job.discussion !== null && !job.resolutions?.length && <p className="muted small">مصوبه‌ای در متن جلسه تشخیص داده نشد.</p>}

          {job.transcript && (
            <details open={open} onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
              <summary className="small">متن کامل پیاده‌شده</summary>
              {open && (
                <pre
                  style={{
                    whiteSpace: 'pre-wrap',
                    fontFamily: 'inherit',
                    maxHeight: 400,
                    overflow: 'auto',
                  }}
                >
                  {job.transcript}
                </pre>
              )}
            </details>
          )}
          <p className="muted small">
            این پیش‌نویس با هوش مصنوعی و از روی صدای جلسه تهیه شده و ممکن است نام‌ها یا مطالب را اشتباه ثبت کرده باشد؛ مسئولیت متن نهایی با دبیر است.
          </p>
        </>
      )}
    </Card>
  );
}
