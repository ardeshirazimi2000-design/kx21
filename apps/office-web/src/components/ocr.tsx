import { useState } from 'react';
import { get, patch, post, upload } from '../lib/api';
import { useAction } from '../lib/hooks';
import { Icon } from './icons';
import { Badge, Button, ErrorBox, Modal, dateTimeFa, fa } from './ui';
import type { PickedFile } from './capture';

/**
 * OCR and AI summary of incoming letters (نامه وارده): the text of a scan is read on the organisation's own server,
 * and when an AI model is set up in «یکپارچه‌سازی», a short summary is suggested for «شرح نامه».
 * Classified letters are never sent to the AI model.
 */

export const OCR_TYPES = ['application/pdf', 'image/png', 'image/jpeg', 'image/tiff'];
const readable = (f: File) => OCR_TYPES.includes(f.type) || /\.(pdf|png|jpe?g|tiff?)$/i.test(f.name);

/** Status of the text read from one attachment, with a view of the text and «خواندن دوباره». */
export function OcrStatus({ letterId, att, canRun, onChange }: { letterId: string; att: any; canRun: boolean; onChange: () => Promise<void> }) {
  const act = useAction();
  const [text, setText] = useState<any>(null);
  if (!att.ocr_status || att.ocr_status === 'unsupported') return null;
  const rerun = () => act.run(async () => (await post(`/letters/${letterId}/attachments/${att.id}/ocr`), await onChange()));
  return (
    <div className="ocr-status small">
      {att.ocr_status === 'pending' && <Badge tone="info">در حال خواندن متن…</Badge>}
      {att.ocr_status === 'done' && (
        <>
          <Badge tone="success">متن خوانده شد</Badge>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => void act.run(async () => setText(await get(`/letters/${letterId}/attachments/${att.id}/text`)))}>
            نمایش متن ({fa(att.ocr_pages ?? 1)} صفحه)
          </button>
        </>
      )}
      {att.ocr_status === 'empty' && <Badge tone="warning">متنی در تصویر پیدا نشد</Badge>}
      {att.ocr_status === 'failed' && (
        <span title={att.ocr_error ?? ''}>
          <Badge tone="danger">خواندن متن ناموفق بود</Badge>
        </span>
      )}
      {canRun && att.ocr_status !== 'pending' && (
        <button type="button" className="btn btn-ghost btn-sm" disabled={act.busy} onClick={() => void rerun()}>
          {act.busy ? 'در حال خواندن…' : 'خواندن دوباره'}
        </button>
      )}
      <ErrorBox error={act.error} />
      {text && (
        <Modal
          wide
          title={`متن خوانده‌شده از «${text.file_name}»`}
          onClose={() => setText(null)}
          footer={
            <Button variant="secondary" onClick={() => void navigator.clipboard?.writeText(text.ocr_text ?? '')}>
              رونوشت متن
            </Button>
          }
        >
          <p className="small muted mb">
            متن با OCR روی سرور سازمان خوانده شده ({text.ocr_method === 'text-layer' ? 'از متن خود PDF' : 'Tesseract فارسی'} — {dateTimeFa(text.ocr_at)}) و ممکن است غلط داشته
            باشد؛ برای جستجو در «جستجوی هوشمند» استفاده می‌شود.
          </p>
          <pre className="ocr-text">{text.ocr_text}</pre>
        </Modal>
      )}
    </div>
  );
}

/** The AI-suggested summary of an incoming letter, and the actions on it. */
export function AiSummary({ letter: l, onChange }: { letter: any; onChange: () => Promise<void> }) {
  const act = useAction();
  if (l.kind !== 'incoming' || !l.aiSummary) return null;
  const canEdit = l.my?.canEdit;
  const filled = !!l.ai_summary && l.summary === l.ai_summary;
  const pending = l.attachments.some((a: any) => a.ocr_status === 'pending');
  if (!l.ai_summary && !(canEdit && l.aiSummary.available)) {
    // Say why nothing is offered only when it is because of classification.
    return l.confidentiality > 0 && l.attachments.some((a: any) => a.ocr_status === 'done') ? (
      <p className="small muted no-print">نامه طبقه‌بندی‌شده است؛ متن آن فقط روی سرور خوانده شد و برای خلاصه‌سازی به هوش مصنوعی فرستاده نمی‌شود.</p>
    ) : null;
  }
  return (
    <div className="ai-summary no-print">
      <div className="ai-summary-head">
        <Icon name="sparkle" />
        <strong>خلاصه پیشنهادی هوش مصنوعی</strong>
        {filled && <Badge tone="info">در شرح نامه درج شده</Badge>}
      </div>
      {l.ai_summary ? <p className="smart-summary">{l.ai_summary}</p> : <p className="small muted">{pending ? 'پس از خواندن متن پیوست‌ها، خلاصه ساخته می‌شود…' : 'هنوز خلاصه‌ای ساخته نشده است.'}</p>}
      {l.ai_summary && <p className="small muted">این خلاصه را ماشین نوشته است؛ پیش از تکیه بر آن، آن را با اصل نامه مقایسه کنید.</p>}
      <ErrorBox error={act.error} />
      {canEdit && (
        <div className="row gap-sm wrap">
          {l.ai_summary && !filled && (
            <Button size="sm" busy={act.busy} onClick={() => void act.run(async () => (await patch(`/letters/${l.id}`, { summary: l.ai_summary }), await onChange()))}>
              درج در شرح نامه
            </Button>
          )}
          {l.aiSummary.available && (
            <Button size="sm" variant="secondary" busy={act.busy} disabled={pending} onClick={() => void act.run(async () => (await post(`/letters/${l.id}/ai-summary`), await onChange()))}>
              {l.ai_summary ? 'خلاصه‌سازی دوباره' : 'خلاصه‌سازی با هوش مصنوعی'}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

export interface OcrPreview {
  text: string;
  pages: number;
  method: string;
  summary: string | null;
  summaryNote: string | null;
  fileName: string;
}

/**
 * In the «ثبت نامه وارده» form: reads the picked scan before saving, so the letter's text and «شرح نامه» can be filled
 * from it. Nothing is stored until the letter is saved.
 */
export function OcrFromScan({
  files,
  confidentiality,
  subject,
  sender,
  onResult,
}: {
  files: PickedFile[];
  confidentiality: number;
  subject: string;
  sender: { org: string; person: string };
  onResult: (r: OcrPreview) => void;
}) {
  const act = useAction();
  const scans = files.filter((x) => readable(x.file));
  if (!scans.length) return null;
  const run = () =>
    act.run(async () => {
      let text = '';
      let pages = 0;
      let last: any = null;
      // Every scan is read; the summary is made once, from all of them together.
      for (const [i, x] of scans.entries()) {
        const only = scans.length === 1;
        last = await upload(
          '/letters/ocr',
          { confidentiality: String(confidentiality), summarise: only ? '1' : '0', subject, externalOrg: sender.org, externalParty: sender.person },
          x.file,
        );
        text += (i ? '\n\n' : '') + last.text;
        pages += last.pages;
      }
      let summary = last.summary as string | null;
      let summaryNote = last.summaryNote as string | null;
      if (scans.length > 1) {
        const all = new File([text], 'scans.txt', { type: 'text/plain' });
        const s = await upload('/letters/ocr', { confidentiality: String(confidentiality), subject, externalOrg: sender.org, externalParty: sender.person }, all);
        summary = s.summary;
        summaryNote = s.summaryNote;
      }
      onResult({ text, pages, method: last.method, summary, summaryNote, fileName: scans.map((x) => x.file.name).join('، ') });
    });
  return (
    <div className="ocr-scan">
      <Button type="button" variant="secondary" busy={act.busy} onClick={() => void run()}>
        <Icon name="scanner" /> خواندن متن نامه از اسکن (OCR)
      </Button>
      <span className="small muted">
        {act.busy
          ? 'در حال خواندن متن… (هر صفحه چند ثانیه)'
          : confidentiality > 0
            ? 'متن روی سرور سازمان خوانده می‌شود؛ نامه طبقه‌بندی‌شده برای خلاصه‌سازی به هوش مصنوعی فرستاده نمی‌شود.'
            : 'متن روی سرور سازمان خوانده می‌شود و اگر هوش مصنوعی تنظیم شده باشد، شرح نامه هم پیشنهاد می‌شود.'}
      </span>
      <ErrorBox error={act.error} />
    </div>
  );
}
