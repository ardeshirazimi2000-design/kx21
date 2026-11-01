import { Router } from 'express';
import { z } from 'zod';
import { currentUser } from '../auth/middleware.js';
import { one, query, tx } from '../db/pool.js';
import { audit } from '../lib/audit.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { body, param, uuid } from '../lib/validate.js';
import { meetingAccess } from '../services/access.js';
import { withDiscussionSection } from '../services/minutes.js';
import { aiCapabilities, cancelRunningTranscript, draftingEnabled, kickTranscriptWorker, transcriptionEnabled } from '../services/transcripts.js';
import { broadcastMeeting } from '../services/meetings.js';

/**
 * «پیش‌نویس از فایل صوتی»: the secretary turns the meeting's recording into text and a draft of the minutes text and
 * resolutions (services/transcripts.ts). Only the meeting's officers see transcripts; every request is audited.
 */
export const transcriptsRouter = Router();

/** Meetings that have been held (the recording exists) and whose minutes are not yet approved. */
const HELD = ['in_progress', 'agenda_processing', 'minutes_draft', 'pending_approval'];

const COLUMNS = `t.id, t.meeting_id, t.document_id, t.source, t.status, t.transcript, t.discussion, t.resolutions, t.error, t.stt_model, t.llm_model,
  t.created_at, t.started_at, t.finished_at, t.applied_at, d.file_name, u.full_name AS created_by_name`;
const FROM = `FROM meeting_transcripts t LEFT JOIN documents d ON d.id = t.document_id LEFT JOIN users u ON u.id = t.created_by`;

transcriptsRouter.get('/ai/capabilities', (_req, res) => {
  res.json(aiCapabilities());
});

transcriptsRouter.get('/meetings/:id/transcripts', async (req, res) => {
  const a = await meetingAccess(currentUser(req), param(req, 'id'));
  a.require('meeting.manage');
  const rows = await query(`SELECT ${COLUMNS} ${FROM} WHERE t.meeting_id = $1 ORDER BY t.created_at DESC LIMIT 20`, [a.meeting.id]);
  res.json({ items: rows, ...aiCapabilities() });
});

transcriptsRouter.post('/meetings/:id/transcripts', async (req, res) => {
  const u = currentUser(req);
  const b = body(
    req,
    z
      .object({ documentId: uuid.optional(), text: z.string().trim().min(50, 'متن جلسه کوتاه است').max(500_000).optional() })
      .refine((v) => !!v.documentId !== !!v.text, 'یک فایل جلسه را انتخاب کنید یا متن پیاده‌شده را وارد کنید'),
  );
  const row = await tx(async (c) => {
    const a = await meetingAccess(u, param(req, 'id'), c, { forUpdate: true });
    a.require('meeting.manage');
    if (!HELD.includes(a.meeting.status)) throw conflict('پیش‌نویس از فایل صوتی فقط برای جلسهٔ برگزارشده‌ای که صورتجلسه‌اش تأیید نشده است ممکن است', 'meeting_state');
    let source: 'recording' | 'text' = 'text';
    if (b.documentId) {
      const d = await one(
        `SELECT d.id, d.kind, d.mime_type FROM documents d LEFT JOIN agenda_items ai ON ai.id = d.agenda_item_id
          WHERE d.id = $1 AND (d.meeting_id = $2 OR ai.meeting_id = $2)`,
        [b.documentId, a.meeting.id],
        c,
      );
      if (!d) throw notFound('فایل در مستندات این جلسه نیست');
      if (d.kind === 'recording') source = 'recording';
      else if (d.mime_type !== 'text/plain') throw badRequest('فایل صوتی یا تصویری جلسه، یا فایل متنی (txt) پیاده‌شدهٔ آن را انتخاب کنید');
    }
    if (source === 'recording' && !transcriptionEnabled()) {
      throw conflict('موتور تبدیل گفتار به متن هنوز روی سرور راه‌اندازی نشده است (راهنما: deploy/ai/README-stt.md)', 'stt_not_configured');
    }
    if (source === 'text' && !draftingEnabled()) {
      throw conflict('مدل زبانی برای تهیهٔ پیش‌نویس روی سرور راه‌اندازی نشده است (AI_CHAT_MODEL)', 'llm_not_configured');
    }
    const open = await one(`SELECT 1 FROM meeting_transcripts WHERE meeting_id = $1 AND status IN ('queued','transcribing','drafting')`, [a.meeting.id], c);
    if (open) throw conflict('برای این جلسه یک پردازش در جریان است؛ پس از پایان آن دوباره تلاش کنید', 'transcript_running');
    const r = await one(
      `INSERT INTO meeting_transcripts (chamber_id, meeting_id, document_id, source, transcript, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, status, source`,
      [a.meeting.chamber_id, a.meeting.id, b.documentId ?? null, source, b.text ?? null, u.id],
      c,
    );
    await audit(c, req, {
      chamberId: a.meeting.chamber_id,
      action: 'transcript.requested',
      entity: 'meeting',
      entityId: a.meeting.id,
      after: { transcriptId: r.id, source, documentId: b.documentId ?? null },
    });
    return r;
  });
  kickTranscriptWorker();
  res.status(201).json(row);
});

async function transcriptAndAccess(req: any, c?: any) {
  const t = await one(`SELECT * FROM meeting_transcripts WHERE id = $1${c ? ' FOR UPDATE' : ''}`, [param(req, 'id')], c);
  if (!t) throw notFound();
  const a = await meetingAccess(currentUser(req), t.meeting_id, c, c ? { forUpdate: true } : undefined);
  a.require('meeting.manage');
  return { t, a };
}

transcriptsRouter.get('/transcripts/:id', async (req, res) => {
  const { t } = await transcriptAndAccess(req);
  res.json(await one(`SELECT ${COLUMNS} ${FROM} WHERE t.id = $1`, [t.id]));
});

transcriptsRouter.post('/transcripts/:id/cancel', async (req, res) => {
  const t = await tx(async (c) => {
    const { t, a } = await transcriptAndAccess(req, c);
    if (!['queued', 'transcribing', 'drafting'].includes(t.status)) throw conflict('این پردازش در جریان نیست');
    await c.query(`UPDATE meeting_transcripts SET status = 'cancelled', finished_at = now() WHERE id = $1`, [t.id]);
    await audit(c, req, { chamberId: a.meeting.chamber_id, action: 'transcript.cancelled', entity: 'meeting', entityId: a.meeting.id, after: { transcriptId: t.id } });
    return t;
  });
  cancelRunningTranscript(t.id);
  res.status(204).end();
});

/** Runs a failed or cancelled job again; a transcript already made is kept and only the drafting is repeated. */
transcriptsRouter.post('/transcripts/:id/retry', async (req, res) => {
  await tx(async (c) => {
    const { t, a } = await transcriptAndAccess(req, c);
    if (!['failed', 'cancelled', 'done'].includes(t.status)) throw conflict('این پردازش هنوز در جریان است');
    if (!HELD.includes(a.meeting.status)) throw conflict('صورتجلسهٔ این جلسه تأیید شده است', 'meeting_state');
    if (!t.transcript && t.source === 'recording' && !transcriptionEnabled()) throw conflict('موتور تبدیل گفتار به متن راه‌اندازی نشده است', 'stt_not_configured');
    if (t.transcript && !draftingEnabled()) throw conflict('مدل زبانی برای تهیهٔ پیش‌نویس راه‌اندازی نشده است', 'llm_not_configured');
    const open = await one(`SELECT 1 FROM meeting_transcripts WHERE meeting_id = $1 AND id <> $2 AND status IN ('queued','transcribing','drafting')`, [t.meeting_id, t.id], c);
    if (open) throw conflict('برای این جلسه یک پردازش دیگر در جریان است', 'transcript_running');
    await c.query(
      `UPDATE meeting_transcripts SET status = 'queued', error = NULL, discussion = NULL, resolutions = '[]', started_at = NULL, finished_at = NULL, created_at = now() WHERE id = $1`,
      [t.id],
    );
    await audit(c, req, { chamberId: a.meeting.chamber_id, action: 'transcript.requested', entity: 'meeting', entityId: a.meeting.id, after: { transcriptId: t.id, retry: true } });
  });
  kickTranscriptWorker();
  res.status(204).end();
});

/** Puts the reviewed «شرح مذاکرات جلسه» into the draft minutes, as a new version. */
transcriptsRouter.post('/transcripts/:id/apply', async (req, res) => {
  const b = body(req, z.object({ discussion: z.string().trim().min(10, 'متن شرح مذاکرات خالی است').max(200_000) }));
  const row = await tx(async (c) => {
    const { t, a } = await transcriptAndAccess(req, c);
    if (a.meeting.status !== 'minutes_draft') throw conflict('صورتجلسه فقط در وضعیت پیش‌نویس قابل ویرایش است', 'minutes_locked');
    if (t.status !== 'done') throw conflict('پردازش این فایل تمام نشده است');
    const m = await one('SELECT * FROM minutes WHERE meeting_id = $1 FOR UPDATE', [a.meeting.id], c);
    if (!m) throw notFound('صورتجلسه هنوز ایجاد نشده است');
    const r = await one(
      `UPDATE minutes SET body = $2, version = version + 1, status = 'draft', updated_at = now() WHERE id = $1 RETURNING *`,
      [m.id, withDiscussionSection(m.body, b.discussion)],
      c,
    );
    await c.query('INSERT INTO minutes_versions (minutes_id, version, body, edited_by) VALUES ($1,$2,$3,$4)', [r.id, r.version, r.body, currentUser(req).id]);
    await c.query(`UPDATE meeting_transcripts SET applied_at = now() WHERE id = $1`, [t.id]);
    await audit(c, req, { chamberId: a.meeting.chamber_id, action: 'minutes.transcript_applied', entity: 'minutes', entityId: r.id, after: { version: r.version, transcriptId: t.id } });
    return r;
  });
  broadcastMeeting(row.meeting_id, {});
  res.json(row);
});
