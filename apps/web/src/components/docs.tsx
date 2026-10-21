import { useState } from 'react';
import { del, download, patch, post, upload } from '../lib/api';
import { Badge, Button, ErrorBox, fa, Field, Modal, type Tone } from './ui';

export const DOC_KINDS: Record<string, { label: string; tone: Tone; icon: string }> = {
  presentation: { label: 'ارائه', tone: 'accent', icon: '📊' },
  photo: { label: 'عکس', tone: 'success', icon: '🖼️' },
  attachment: { label: 'پیوست', tone: 'neutral', icon: '📄' },
  report: { label: 'گزارش', tone: 'info', icon: '📑' },
  letter: { label: 'نامه', tone: 'warning', icon: '✉️' },
  evidence: { label: 'مستند اقدام', tone: 'info', icon: '📎' },
  recording: { label: 'فیلم جلسه', tone: 'accent', icon: '🎬' },
};

export const ACCEPT = '.pdf,.ppt,.pptx,.ppsx,.doc,.docx,.xls,.xlsx,.png,.jpg,.jpeg,.webp,.heic,.txt,.webm,.mp4';
export const ACCEPT_HINT = 'پاورپوینت، PDF، عکس، Word و Excel تا ۵۰ مگابایت؛ فیلم جلسه (WebM یا MP4) تا ۲ گیگابایت';

const VIDEO = ['video/webm', 'video/mp4'];
const VIEWABLE = ['application/pdf', 'image/png', 'image/jpeg', 'image/webp', ...VIDEO];

/** Signed same-origin link to a document (inline = open in the browser instead of downloading). */
async function signedHref(id: string, inline: boolean) {
  const { url } = await post<{ url: string }>(`/documents/${id}/link${inline ? '?inline=1' : ''}`);
  const u = new URL(url);
  // Same origin as the web app: avoids host/port rewrites made by the reverse proxy.
  return `${u.pathname}${u.search}`;
}

export function DocKind({ kind }: { kind: string }) {
  const k = DOC_KINDS[kind] ?? DOC_KINDS.attachment;
  return (
    <Badge tone={k.tone}>
      {k.icon} {k.label}
    </Badge>
  );
}

/** PDFs and pictures open in a new tab (short-lived signed link); everything else is downloaded. */
export async function openDocument(d: { id: string; file_name: string; mime_type?: string }) {
  if (d.mime_type && VIEWABLE.includes(d.mime_type)) {
    const tab = window.open('about:blank', '_blank');
    const href = await signedHref(d.id, true);
    if (tab) tab.location.href = href;
    else window.location.href = href;
    return;
  }
  await download(`/documents/${d.id}/download`, d.file_name);
}

/** Large videos are downloaded by the browser itself (a signed link) rather than read into memory. */
async function downloadVideo(d: { id: string }) {
  const a = document.createElement('a');
  a.href = await signedHref(d.id, false);
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/** Multi-file picker that uploads each file to the given target; kind is detected from the file unless chosen. */
export function UploadFiles({ target, onDone, withKind = true }: { target: Record<string, string>; onDone: () => void; withKind?: boolean }) {
  const [kind, setKind] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<Error | null>(null);
  const onFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    setErr(null);
    const list = [...files];
    const failed: string[] = [];
    for (const [i, f] of list.entries()) {
      const of = list.length > 1 ? `${fa(i + 1)} از ${fa(list.length)}` : '';
      setBusy(of);
      try {
        await upload({ ...target, ...(kind ? { kind } : {}) }, f, (p) => setBusy(`${of} — ${fa(p)}٪`));
      } catch (e) {
        failed.push(`${f.name}: ${(e as Error).message}`);
      }
    }
    setBusy(null);
    if (failed.length) setErr(new Error(`بارگذاری ${failed.length} فایل ناموفق بود — ${failed.join('؛ ')}`));
    onDone();
  };
  return (
    <>
      <ErrorBox error={err} />
      <div className="row gap-sm wrap" style={{ alignItems: 'center' }}>
        {withKind && (
          <select className="input" style={{ maxWidth: 190 }} value={kind} onChange={(e) => setKind(e.target.value)} aria-label="نوع سند">
            <option value="">نوع: تشخیص خودکار</option>
            {['presentation', 'photo', 'attachment', 'report', 'recording'].map((k) => (
              <option key={k} value={k}>
                {DOC_KINDS[k].label}
              </option>
            ))}
          </select>
        )}
        <label className="btn btn-secondary">
          {busy !== null ? `در حال بارگذاری ${busy}…` : 'افزودن فایل‌ها'}
          <input type="file" hidden multiple accept={ACCEPT} disabled={busy !== null} onChange={(e) => void onFiles(e.target.files).then(() => (e.target.value = ''))} />
        </label>
        <span className="muted small">{ACCEPT_HINT}</span>
      </div>
    </>
  );
}

export function ViewButton({ d }: { d: { id: string; file_name: string; mime_type?: string } }) {
  const [err, setErr] = useState<Error | null>(null);
  const viewable = !!d.mime_type && VIEWABLE.includes(d.mime_type);
  const video = !!d.mime_type && VIDEO.includes(d.mime_type);
  return (
    <>
      <Button size="sm" variant="ghost" onClick={() => openDocument(d).catch(setErr)}>
        {video ? 'پخش' : viewable ? 'مشاهده' : 'دریافت'}
      </Button>
      {video && (
        <Button size="sm" variant="ghost" onClick={() => downloadVideo(d).catch(setErr)}>
          دریافت
        </Button>
      )}
      {err && <span className="small" style={{ color: "var(--danger)" }}>{err.message}</span>}
    </>
  );
}

/**
 * Correcting a document uploaded by mistake: change its title or type, or delete it (to upload the right file).
 * The server decides who may (the uploader or the secretary) and refuses once the minutes are approved.
 */
export function DocActions({ d, onDone }: { d: { id: string; kind: string; title?: string | null; file_name: string }; onDone: () => void }) {
  const [edit, setEdit] = useState(false);
  const [title, setTitle] = useState(d.title ?? '');
  const [kind, setKind] = useState(d.kind);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<Error | null>(null);
  const save = async () => {
    setBusy(true);
    setErr(null);
    try {
      await patch(`/documents/${d.id}`, { title: title.trim() || null, ...(d.kind === 'recording' ? {} : { kind }) });
      setEdit(false);
      onDone();
    } catch (e) {
      setErr(e as Error);
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    if (!confirm(`فایل «${d.title || d.file_name}» حذف شود؟\nاین کار قابل برگشت نیست.`)) return;
    setErr(null);
    try {
      await del(`/documents/${d.id}`);
      onDone();
    } catch (e) {
      setErr(e as Error);
    }
  };
  return (
    <>
      <Button size="sm" variant="ghost" onClick={() => setEdit(true)} aria-label={`اصلاح ${d.title || d.file_name}`}>
        اصلاح
      </Button>
      <Button size="sm" variant="ghost" onClick={() => void remove()} aria-label={`حذف ${d.title || d.file_name}`}>
        <span style={{ color: 'var(--danger)' }}>حذف</span>
      </Button>
      {err && !edit && <span className="small" style={{ color: 'var(--danger)' }}>{err.message}</span>}
      {edit && (
        <Modal
          title="اصلاح مشخصات سند"
          onClose={() => setEdit(false)}
          footer={
            <Button busy={busy} onClick={() => void save()}>
              ذخیره
            </Button>
          }
        >
          <ErrorBox error={err} />
          <p className="muted small" style={{ marginTop: 0 }}>
            فایل: <span className="ltr">{d.file_name}</span> — برای جایگزینی خود فایل، این سند را حذف و فایل درست را دوباره بارگذاری کنید.
          </p>
          <Field label="عنوان" hint="خالی بگذارید تا نام فایل نمایش داده شود">
            <input className="input" value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} />
          </Field>
          {d.kind !== 'recording' && (
            <Field label="نوع سند">
              <select className="input" value={kind} onChange={(e) => setKind(e.target.value)}>
                {['presentation', 'photo', 'attachment', 'report', 'letter', 'evidence'].map((k) => (
                  <option key={k} value={k}>
                    {DOC_KINDS[k].label}
                  </option>
                ))}
              </select>
            </Field>
          )}
        </Modal>
      )}
    </>
  );
}
