/**
 * OCR and automatic summary of incoming letters (نامه وارده).
 *
 * Every attachment of an incoming letter is read on this server (lib/ocr.ts) by a background job; the text is kept with
 * the attachment and indexed by the smart search. Then, when an AI provider with a chat model is configured and the
 * letter is unclassified, a two-to-three line summary is suggested and placed in «شرح نامه» if that is still empty
 * (or still holds the previous suggestion). Classified letters are never sent to the AI provider: OCR only.
 */
import { one, query, tx, type Db } from '../db/pool.js';
import { audit } from '../lib/audit.js';
import { logger } from '../lib/logger.js';
import { extractText, OCR_MIME } from '../lib/ocr.js';
import { getFile } from '../lib/storage.js';
import { chat, loadAi } from './ai.js';
import { enqueue, registerHandler } from './jobs.js';
import { LATEST_OCR_SQL, letterText } from './search.js';

export const ocrApplies = (kind: string, mime: string) => kind === 'incoming' && OCR_MIME.includes(mime);

/** Queues OCR for a newly stored attachment (inside the caller's transaction). */
export async function queueOcr(db: Db, letterKind: string, att: { id: string; mime_type: string }) {
  if (!ocrApplies(letterKind, att.mime_type)) return false;
  await db.query(`UPDATE letter_attachments SET ocr_status = 'pending', ocr_error = NULL WHERE id = $1`, [att.id]);
  await enqueue('attachment.ocr', { attachmentId: att.id }, db, { maxAttempts: 3 });
  return true;
}

/** Reads one attachment and stores its text. Returns the stored row. */
export async function ocrAttachment(attachmentId: string) {
  const a = await one(
    `SELECT a.id, a.letter_id, a.mime_type, a.storage_key, a.sha256, l.kind FROM letter_attachments a JOIN letters l ON l.id = a.letter_id WHERE a.id = $1`,
    [attachmentId],
  );
  if (!a) return null;
  if (!OCR_MIME.includes(a.mime_type)) {
    await query(`UPDATE letter_attachments SET ocr_status = 'unsupported', ocr_at = now() WHERE id = $1`, [a.id]);
    return a;
  }
  // The same file (e.g. a scan attached twice) is read once.
  const same = await one(`SELECT ocr_text, ocr_method, ocr_pages FROM letter_attachments WHERE sha256 = $1 AND ocr_status = 'done' AND id <> $2 LIMIT 1`, [
    a.sha256,
    a.id,
  ]);
  let r: { text: string; pages: number; method: string };
  try {
    r = same ? { text: same.ocr_text, pages: same.ocr_pages, method: same.ocr_method } : await extractText(await getFile(a.storage_key), a.mime_type);
  } catch (e) {
    await query(`UPDATE letter_attachments SET ocr_status = 'failed', ocr_error = $2, ocr_at = now() WHERE id = $1`, [a.id, String((e as Error).message).slice(0, 500)]);
    throw e;
  }
  await query(
    `UPDATE letter_attachments SET ocr_status = $2, ocr_text = $3, ocr_method = $4, ocr_pages = $5, ocr_error = NULL, ocr_at = now() WHERE id = $1`,
    [a.id, r.text ? 'done' : 'empty', r.text || null, r.method, r.pages],
  );
  // The smart search picks the new text up on its next run.
  await query(`UPDATE letter_index SET indexed_at = '-infinity' WHERE letter_id = $1`, [a.letter_id]);
  return a;
}

const SUMMARY_SYSTEM =
  'تو دستیار دبیرخانه یک سازمان هستی و برای نامه‌های رسیده «شرح نامه» می‌نویسی: خلاصه‌ای دو تا سه جمله‌ای، رسمی و بی‌طرف، به فارسی. ' +
  'بگو فرستنده چه کسی است، چه موضوعی را مطرح کرده و چه درخواست یا اقدامی خواسته است؛ اگر مهلت، مبلغ یا شماره مهمی آمده آن را بیاور. ' +
  'فقط خود خلاصه را بنویس، بدون عنوان، فهرست یا توضیح اضافه، و چیزی را که در نامه نیست اضافه نکن. متن ممکن است با OCR خوانده شده و غلط تایپی داشته باشد.';

/** Why a letter cannot be summarised by AI, or null when it can. */
export async function summaryBlocker(l: { confidentiality: number }): Promise<string | null> {
  if (l.confidentiality > 0) return 'نامه طبقه‌بندی‌شده به هوش مصنوعی فرستاده نمی‌شود';
  const ai = await loadAi();
  if (!ai?.chatModel) return 'هوش مصنوعی (مدل گفتگو) در «یکپارچه‌سازی» تنظیم نشده است';
  return null;
}

/** Builds the summary prompt from what is known about a letter. */
export function summaryPrompt(l: { subject?: string | null; external_org?: string | null; external_party?: string | null }, text: string) {
  return [
    l.subject ? `موضوع ثبت‌شده: ${l.subject}` : '',
    l.external_org || l.external_party ? `فرستنده: ${[l.external_party, l.external_org].filter(Boolean).join(' — ')}` : '',
    'متن نامه:',
    text.slice(0, 6000),
  ]
    .filter(Boolean)
    .join('\n');
}

export async function summarise(l: { subject?: string | null; external_org?: string | null; external_party?: string | null }, text: string): Promise<string> {
  const ai = await loadAi();
  if (!ai?.chatModel) throw new Error('هوش مصنوعی تنظیم نشده است');
  const s = await chat(ai, SUMMARY_SYSTEM, summaryPrompt(l, text), 300);
  return s.replace(/^(خلاصه|شرح نامه)\s*[:：]\s*/u, '').replace(/\s+\n/g, '\n').trim().slice(0, 2000);
}

/** The full text of an incoming letter: its typed body and the text read from its attachments. */
export async function letterFullText(letterId: string, l: { body: string | null; body_format?: string }) {
  const parts = await query(`${LATEST_OCR_SQL} AND a.letter_id = $1 ORDER BY a.created_at`, [letterId]);
  return [letterText(l), ...parts.map((p) => p.ocr_text)].filter((t) => t?.trim()).join('\n\n');
}

/**
 * Suggests a summary for an unclassified letter and stores it as ai_summary. «شرح نامه» is filled only when empty or
 * still the previous suggestion, so a summary a person wrote or edited is never replaced. Returns null when skipped.
 */
export async function suggestSummary(letterId: string, opts: { fill?: boolean; force?: boolean; userId?: string } = {}) {
  const l = await one(`SELECT * FROM letters WHERE id = $1`, [letterId]);
  if (!l || (await summaryBlocker(l))) return null;
  const userSummary = l.summary && l.summary !== l.ai_summary;
  if (userSummary && !opts.force) return null; // nothing to fill; saves a call to the model
  const text = await letterFullText(l.id, l);
  if (text.replace(/\s/g, '').length < 40) return null;
  const summary = await summarise(l, text);
  if (!summary) return null;
  // Confidentiality is checked again: the letter may have been classified while the model was answering.
  return tx(async (c) => {
    const r = await one(
      `UPDATE letters SET ai_summary = $2, ai_summary_at = now(),
         summary = CASE WHEN $3::boolean AND (summary IS NULL OR summary = '' OR summary = ai_summary) AND status IN ('draft','registered')
           AND NOT EXISTS (SELECT 1 FROM signatures WHERE entity_type = 'letter' AND entity_id = letters.id) THEN $2 ELSE summary END
       WHERE id = $1 AND confidentiality = 0 RETURNING id, summary, ai_summary, ai_summary_at, (summary = $2) AS filled`,
      [l.id, summary, opts.fill !== false],
      c,
    );
    if (r) await audit(c, null, { action: 'letter.ai_summary', entity: 'letter', entityId: l.id, userId: opts.userId ?? null, before: { summary: l.summary }, after: { summary: r.summary, aiSummary: summary } });
    if (r?.filled) await c.query(`UPDATE letter_index SET indexed_at = '-infinity' WHERE letter_id = $1`, [l.id]);
    return r;
  });
}

registerHandler('attachment.ocr', async ({ attachmentId }: { attachmentId: string }) => {
  const a = await ocrAttachment(attachmentId);
  if (!a || a.kind !== 'incoming') return;
  // Waits for the other attachments of the same letter, so the summary is made once from all of them.
  const pending = await one(`SELECT count(*)::int AS n FROM letter_attachments WHERE letter_id = $1 AND ocr_status = 'pending'`, [a.letter_id]);
  if (pending?.n) return;
  await suggestSummary(a.letter_id).catch((e) => logger.warn({ err: e, letter: a.letter_id }, 'AI summary of incoming letter failed'));
});


