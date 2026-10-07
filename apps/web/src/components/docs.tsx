import { useState } from 'react';
import { download, post, upload } from '../lib/api';
import { Badge, Button, ErrorBox, fa, type Tone } from './ui';

export const DOC_KINDS: Record<string, { label: string; tone: Tone; icon: string }> = {
  presentation: { label: 'ارائه', tone: 'accent', icon: '📊' },
  photo: { label: 'عکس', tone: 'success', icon: '🖼️' },
  attachment: { label: 'پیوست', tone: 'neutral', icon: '📄' },
  report: { label: 'گزارش', tone: 'info', icon: '📑' },
  letter: { label: 'نامه', tone: 'warning', icon: '✉️' },
  evidence: { label: 'مستند اقدام', tone: 'info', icon: '📎' },
};

export const ACCEPT = '.pdf,.ppt,.pptx,.ppsx,.doc,.docx,.xls,.xlsx,.png,.jpg,.jpeg,.webp,.heic,.txt';
export const ACCEPT_HINT = 'پاورپوینت، PDF، عکس، Word و Excel — حداکثر ۵۰ مگابایت برای هر فایل';

const VIEWABLE = ['application/pdf', 'image/png', 'image/jpeg', 'image/webp'];

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
    const { url } = await post<{ url: string }>(`/documents/${d.id}/link?inline=1`);
    const u = new URL(url);
    // Same origin as the web app: avoids host/port rewrites made by the reverse proxy.
    const href = `${u.pathname}${u.search}`;
    if (tab) tab.location.href = href;
    else window.location.href = href;
    return;
  }
  await download(`/documents/${d.id}/download`, d.file_name);
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
      setBusy(list.length > 1 ? `${fa(i + 1)} از ${fa(list.length)}` : '');
      try {
        await upload({ ...target, ...(kind ? { kind } : {}) }, f);
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
            {['presentation', 'photo', 'attachment', 'report'].map((k) => (
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
  return (
    <>
      <Button size="sm" variant="ghost" onClick={() => openDocument(d).catch(setErr)}>
        {viewable ? 'مشاهده' : 'دریافت'}
      </Button>
      {err && <span className="small" style={{ color: "var(--danger)" }}>{err.message}</span>}
    </>
  );
}
