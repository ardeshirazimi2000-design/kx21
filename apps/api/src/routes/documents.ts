import crypto from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Router, type Response } from 'express';
import jwt from 'jsonwebtoken';
import multer from 'multer';
import { z } from 'zod';
import { currentUser, loadAuthUser, type AuthUser } from '../auth/middleware.js';
import { config } from '../config.js';
import { one, query, tx } from '../db/pool.js';
import { audit } from '../lib/audit.js';
import { badRequest, forbidden, notFound } from '../lib/errors.js';
import { parse, param, uuid } from '../lib/validate.js';
import { commissionAccess, meetingAccess, meetingIdOfAgendaItem } from '../services/access.js';

export const documentsRouter = Router();

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: config.maxUploadMb * 1024 * 1024, files: 1 } });

/** Allowed types with their magic-byte signatures (null = text, checked for binary content). */
const ALLOWED: Record<string, { ext: string[]; magic: number[][] | null }> = {
  'application/pdf': { ext: ['.pdf'], magic: [[0x25, 0x50, 0x44, 0x46]] },
  'image/png': { ext: ['.png'], magic: [[0x89, 0x50, 0x4e, 0x47]] },
  'image/jpeg': { ext: ['.jpg', '.jpeg'], magic: [[0xff, 0xd8, 0xff]] },
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': { ext: ['.docx'], magic: [[0x50, 0x4b, 0x03, 0x04]] },
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': { ext: ['.xlsx'], magic: [[0x50, 0x4b, 0x03, 0x04]] },
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': { ext: ['.pptx'], magic: [[0x50, 0x4b, 0x03, 0x04]] },
  'application/msword': { ext: ['.doc'], magic: [[0xd0, 0xcf, 0x11, 0xe0]] },
  'application/vnd.ms-excel': { ext: ['.xls'], magic: [[0xd0, 0xcf, 0x11, 0xe0]] },
  'text/plain': { ext: ['.txt'], magic: null },
};

export function validateFile(name: string, mime: string, buf: Buffer): void {
  const rule = ALLOWED[mime];
  if (!rule) throw badRequest('نوع فایل مجاز نیست');
  if (!rule.ext.includes(path.extname(name).toLowerCase())) throw badRequest('پسوند فایل با نوع آن مطابقت ندارد');
  if (rule.magic) {
    const ok = rule.magic.some((sig) => sig.every((b, i) => buf[i] === b));
    if (!ok) throw badRequest('محتوای فایل با نوع اعلام‌شده مطابقت ندارد');
  } else if (buf.subarray(0, 8192).includes(0)) {
    throw badRequest('فایل متنی معتبر نیست');
  }
}

/**
 * Malware scanning hook. Integrate ClamAV (clamd INSTREAM) or an organisational scanner here;
 * returning 'infected' rejects the upload.
 */
async function scanFile(_buf: Buffer): Promise<'clean' | 'infected'> {
  return 'clean';
}

type Target = { chamberId: string; commissionId: string | null; meetingId: string | null };

async function resolveTarget(u: AuthUser, t: Record<string, string | null | undefined>, write: boolean): Promise<Target> {
  if (t.agendaItemId || t.meetingId) {
    const meetingId = t.meetingId ?? (await meetingIdOfAgendaItem(t.agendaItemId!));
    const a = await meetingAccess(u, meetingId);
    if (t.agendaItemId) {
      const it = await one('SELECT meeting_id FROM agenda_items WHERE id = $1', [t.agendaItemId]);
      if (it?.meeting_id !== meetingId) throw badRequest('دستور جلسه متعلق به این جلسه نیست');
    }
    if (write) a.require('meeting.manage');
    return { chamberId: a.meeting.chamber_id, commissionId: a.meeting.commission_id, meetingId };
  }
  if (t.resolutionId) {
    const r = await one('SELECT chamber_id, commission_id, owner_id FROM resolutions WHERE id = $1', [t.resolutionId]);
    if (!r) throw notFound();
    const ca = await commissionAccess(u, r.commission_id).catch(() => null);
    const allowed = r.owner_id === u.id || (write ? ca?.can('resolution.manage') : ca && ca.position !== 'expert') || ca?.can('commission.manage');
    if (!allowed) throw forbidden();
    return { chamberId: r.chamber_id, commissionId: r.commission_id, meetingId: null };
  }
  if (t.issueId) {
    const i = await one('SELECT chamber_id, commission_id FROM issues WHERE id = $1', [t.issueId]);
    if (!i) throw notFound();
    const isExpert = !!(await one('SELECT 1 FROM referrals WHERE issue_id = $1 AND expert_id = $2', [t.issueId, u.id]));
    const ca = await commissionAccess(u, i.commission_id).catch(() => null);
    const allowed = isExpert || (write ? ca?.can('issue.manage') : ca && ca.position !== 'expert');
    if (!allowed) throw forbidden();
    return { chamberId: i.chamber_id, commissionId: i.commission_id, meetingId: null };
  }
  if (t.commissionId) {
    const ca = await commissionAccess(u, t.commissionId);
    if (write) ca.require('meeting.manage');
    else if (ca.position === 'expert') throw forbidden();
    return { chamberId: ca.commission.chamber_id, commissionId: ca.commission.id, meetingId: null };
  }
  throw badRequest('مقصد سند (جلسه، دستور جلسه، مصوبه، موضوع یا کمیسیون) مشخص نشده است');
}

const targetSchema = z.object({
  meetingId: uuid.nullish(),
  agendaItemId: uuid.nullish(),
  resolutionId: uuid.nullish(),
  issueId: uuid.nullish(),
  commissionId: uuid.nullish(),
});

documentsRouter.post('/documents', upload.single('file'), async (req, res) => {
  const u = currentUser(req);
  const file = req.file;
  if (!file) throw badRequest('فایلی ارسال نشده است');
  const meta = parse(
    targetSchema.extend({ kind: z.enum(['attachment', 'letter', 'report', 'evidence']).default('attachment'), title: z.string().max(200).nullish() }),
    req.body,
  );
  // multer decodes names as latin1; restore UTF-8 (Persian file names).
  const fileName = Buffer.from(file.originalname, 'latin1').toString('utf8');
  validateFile(fileName, file.mimetype, file.buffer);
  if ((await scanFile(file.buffer)) !== 'clean') throw badRequest('فایل آلوده تشخیص داده شد');
  const target = await resolveTarget(u, meta, true);
  const sha256 = crypto.createHash('sha256').update(file.buffer).digest('hex');
  const id = crypto.randomUUID();
  const storageKey = path.join(target.chamberId, id);
  const full = path.join(config.uploadDir, storageKey);
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, file.buffer, { mode: 0o600 });
  const row = await tx(async (c) => {
    const r = await one(
      `INSERT INTO documents (id, chamber_id, commission_id, meeting_id, agenda_item_id, resolution_id, issue_id, kind, title, file_name,
          mime_type, size_bytes, storage_key, sha256, owner_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       RETURNING id, kind, title, file_name, mime_type, size_bytes, sha256, created_at`,
      [
        id, target.chamberId, target.commissionId, meta.agendaItemId ? null : target.meetingId, meta.agendaItemId ?? null, meta.resolutionId ?? null,
        meta.issueId ?? null, meta.kind, meta.title ?? null, fileName, file.mimetype, file.size, storageKey, sha256, u.id,
      ],
      c,
    );
    await audit(c, req, { chamberId: target.chamberId, action: 'document.uploaded', entity: 'document', entityId: id, after: r });
    return r;
  });
  res.status(201).json(row);
});

documentsRouter.get('/documents', async (req, res) => {
  const u = currentUser(req);
  const t = parse(targetSchema, req.query);
  await resolveTarget(u, t, false);
  const rows = await query(
    `SELECT d.id, d.kind, d.title, d.file_name, d.mime_type, d.size_bytes, d.created_at, d.meeting_id, d.agenda_item_id, d.resolution_id, d.issue_id,
            u.full_name AS owner_name
       FROM documents d LEFT JOIN users u ON u.id = d.owner_id
      WHERE ($1::uuid IS NULL OR d.meeting_id = $1 OR d.agenda_item_id IN (SELECT id FROM agenda_items WHERE meeting_id = $1))
        AND ($2::uuid IS NULL OR d.agenda_item_id = $2) AND ($3::uuid IS NULL OR d.resolution_id = $3)
        AND ($4::uuid IS NULL OR d.issue_id = $4)
        AND ($5::uuid IS NULL OR (d.commission_id = $5 AND d.meeting_id IS NULL AND d.agenda_item_id IS NULL AND d.resolution_id IS NULL AND d.issue_id IS NULL))
      ORDER BY d.created_at DESC`,
    [t.meetingId ?? null, t.agendaItemId ?? null, t.resolutionId ?? null, t.issueId ?? null, t.commissionId ?? null],
  );
  res.json(rows);
});

async function authorizedDocument(u: AuthUser, id: string) {
  const d = await one('SELECT * FROM documents WHERE id = $1', [id]);
  if (!d) throw notFound();
  await resolveTarget(
    u,
    { meetingId: d.meeting_id, agendaItemId: d.agenda_item_id, resolutionId: d.resolution_id, issueId: d.issue_id, commissionId: d.commission_id },
    false,
  ).catch(() => {
    throw notFound();
  });
  return d;
}

async function sendDocument(res: Response, d: any) {
  const buf = await readFile(path.join(config.uploadDir, d.storage_key));
  res.setHeader('content-type', d.mime_type);
  res.setHeader('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(d.file_name)}`);
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('cache-control', 'private, no-store');
  res.send(buf);
}

documentsRouter.get('/documents/:id/download', async (req, res) => {
  await sendDocument(res, await authorizedDocument(currentUser(req), param(req, 'id')));
});

/**
 * Short-lived (2 min) signed link, so mobile clients can open a document in the system viewer
 * without putting the access token in a URL.
 */
documentsRouter.post('/documents/:id/link', async (req, res) => {
  const u = currentUser(req);
  const d = await authorizedDocument(u, param(req, 'id'));
  const token = jwt.sign({ sub: u.id, doc: d.id, typ: 'file' }, config.jwtSecret, { expiresIn: '2m', issuer: 'kx-api' });
  const base = `${req.protocol}://${req.get('host')}`;
  res.json({ url: `${base}/api/files/${d.id}?token=${token}` });
});

/** Public route (mounted before authentication) serving a document for a valid signed link. */
export const filesRouter = Router();
filesRouter.get('/files/:id', async (req, res) => {
  const id = param(req, 'id');
  let payload: any;
  try {
    payload = jwt.verify(String(req.query.token ?? ''), config.jwtSecret, { issuer: 'kx-api' });
  } catch {
    throw notFound();
  }
  if (payload.typ !== 'file' || payload.doc !== id) throw notFound();
  const u = await loadAuthUser(payload.sub);
  if (!u) throw notFound();
  await sendDocument(res, await authorizedDocument(u, id));
});
