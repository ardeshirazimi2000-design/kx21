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
import { paged, pageParams, parse, param, uuid } from '../lib/validate.js';
import { commissionAccess, meetingAccess, meetingIdOfAgendaItem } from '../services/access.js';

export const documentsRouter = Router();

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: config.maxUploadMb * 1024 * 1024, files: 1 } });

/**
 * Allowed file types by extension, with their canonical MIME type and content signatures
 * (null = text, checked for binary content). Browsers and phones often send a generic MIME type
 * (e.g. application/octet-stream for .pptx), so the extension decides and the content is verified.
 */
const ZIP = [[0x50, 0x4b, 0x03, 0x04]];
const OLE = [[0xd0, 0xcf, 0x11, 0xe0]];
const ALLOWED: Record<string, { mime: string; magic: number[][] | null; at?: number; kind: string }> = {
  '.pdf': { mime: 'application/pdf', magic: [[0x25, 0x50, 0x44, 0x46]], kind: 'attachment' },
  '.png': { mime: 'image/png', magic: [[0x89, 0x50, 0x4e, 0x47]], kind: 'photo' },
  '.jpg': { mime: 'image/jpeg', magic: [[0xff, 0xd8, 0xff]], kind: 'photo' },
  '.jpeg': { mime: 'image/jpeg', magic: [[0xff, 0xd8, 0xff]], kind: 'photo' },
  '.webp': { mime: 'image/webp', magic: [[0x52, 0x49, 0x46, 0x46]], kind: 'photo' },
  // iPhone photos: ISO-BMFF "ftyp" box at offset 4
  '.heic': { mime: 'image/heic', magic: [[0x66, 0x74, 0x79, 0x70]], at: 4, kind: 'photo' },
  '.heif': { mime: 'image/heif', magic: [[0x66, 0x74, 0x79, 0x70]], at: 4, kind: 'photo' },
  '.pptx': { mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', magic: ZIP, kind: 'presentation' },
  '.ppsx': { mime: 'application/vnd.openxmlformats-officedocument.presentationml.slideshow', magic: ZIP, kind: 'presentation' },
  '.ppt': { mime: 'application/vnd.ms-powerpoint', magic: OLE, kind: 'presentation' },
  '.docx': { mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', magic: ZIP, kind: 'attachment' },
  '.doc': { mime: 'application/msword', magic: OLE, kind: 'attachment' },
  '.xlsx': { mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', magic: ZIP, kind: 'attachment' },
  '.xls': { mime: 'application/vnd.ms-excel', magic: OLE, kind: 'attachment' },
  '.txt': { mime: 'text/plain', magic: null, kind: 'attachment' },
};

export const ALLOWED_EXTENSIONS = Object.keys(ALLOWED);

/** Validates name + content and returns the canonical MIME type and the default document kind. */
export function validateFile(name: string, _declaredMime: string, buf: Buffer): { mime: string; kind: string } {
  const rule = ALLOWED[path.extname(name).toLowerCase()];
  if (!rule) throw badRequest(`نوع فایل مجاز نیست. فرمت‌های مجاز: ${ALLOWED_EXTENSIONS.join('، ')}`);
  if (rule.magic) {
    const at = rule.at ?? 0;
    const ok = rule.magic.some((sig) => sig.every((b, i) => buf[at + i] === b));
    if (!ok) throw badRequest('محتوای فایل با پسوند آن مطابقت ندارد');
  } else if (buf.subarray(0, 8192).includes(0)) {
    throw badRequest('فایل متنی معتبر نیست');
  }
  return { mime: rule.mime, kind: rule.kind };
}

/**
 * Malware scanning hook. Integrate ClamAV (clamd INSTREAM) or an organisational scanner here;
 * returning 'infected' rejects the upload.
 */
async function scanFile(_buf: Buffer): Promise<'clean' | 'infected'> {
  return 'clean';
}

type Target = { chamberId: string; commissionId: string | null; meetingId: string | null };

async function resolveTarget(u: AuthUser, t: Record<string, string | null | undefined>, write: boolean, kind?: string): Promise<Target> {
  if (t.agendaItemId || t.meetingId) {
    const meetingId = t.meetingId ?? (await meetingIdOfAgendaItem(t.agendaItemId!));
    const a = await meetingAccess(u, meetingId);
    if (t.agendaItemId) {
      const it = await one('SELECT meeting_id FROM agenda_items WHERE id = $1', [t.agendaItemId]);
      if (it?.meeting_id !== meetingId) throw badRequest('دستور جلسه متعلق به این جلسه نیست');
    }
    // Invitees may upload their own introduction letter (معرفی‌نامه نماینده) to the meeting.
    const ownLetter = kind === 'letter' && !t.agendaItemId && !!a.inviteeRole && !a.delegateFor;
    if (write && !ownLetter) a.require('meeting.manage');
    return { chamberId: a.meeting.chamber_id, commissionId: a.meeting.commission_id, meetingId };
  }
  if (t.resolutionId) {
    const r = await one('SELECT chamber_id, commission_id, owner_id FROM resolutions WHERE id = $1', [t.resolutionId]);
    if (!r) throw notFound();
    const ca = await commissionAccess(u, r.commission_id).catch(() => null);
    const allowed = r.owner_id === u.id || (write ? ca?.can('resolution.manage') : ca?.can('commission.browse')) || ca?.can('commission.manage');
    if (!allowed) throw forbidden();
    return { chamberId: r.chamber_id, commissionId: r.commission_id, meetingId: null };
  }
  if (t.issueId) {
    const i = await one('SELECT chamber_id, commission_id FROM issues WHERE id = $1', [t.issueId]);
    if (!i) throw notFound();
    const isExpert = !!(await one('SELECT 1 FROM referrals WHERE issue_id = $1 AND expert_id = $2', [t.issueId, u.id]));
    const ca = await commissionAccess(u, i.commission_id).catch(() => null);
    const allowed = isExpert || (write ? ca?.can('issue.manage') : ca?.can('commission.browse'));
    if (!allowed) throw forbidden();
    return { chamberId: i.chamber_id, commissionId: i.commission_id, meetingId: null };
  }
  if (t.commissionId) {
    const ca = await commissionAccess(u, t.commissionId);
    if (write) ca.require('meeting.manage');
    else if (!ca.can('commission.browse')) throw forbidden();
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
    targetSchema.extend({
      kind: z.enum(['attachment', 'presentation', 'photo', 'letter', 'report', 'evidence']).optional(),
      title: z.string().max(200).nullish(),
    }),
    req.body,
  );
  // multer decodes names as latin1; restore UTF-8 (Persian file names).
  const fileName = Buffer.from(file.originalname, 'latin1').toString('utf8');
  const detected = validateFile(fileName, file.mimetype, file.buffer);
  const kind = meta.kind ?? detected.kind;
  if ((await scanFile(file.buffer)) !== 'clean') throw badRequest('فایل آلوده تشخیص داده شد');
  const target = await resolveTarget(u, meta, true, kind);
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
        meta.issueId ?? null, kind, meta.title ?? null, fileName, detected.mime, file.size, storageKey, sha256, u.id,
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

const INLINE_TYPES = ['application/pdf', 'image/png', 'image/jpeg', 'image/webp'];

async function sendDocument(res: Response, d: any, inline = false) {
  const buf = await readFile(path.join(config.uploadDir, d.storage_key));
  const disposition = inline && INLINE_TYPES.includes(d.mime_type) ? 'inline' : 'attachment';
  res.setHeader('content-type', d.mime_type);
  res.setHeader('content-disposition', `${disposition}; filename*=UTF-8''${encodeURIComponent(d.file_name)}`);
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
  res.json({ url: `${base}/api/files/${d.id}?token=${token}${req.query.inline === '1' ? '&inline=1' : ''}` });
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
  await sendDocument(res, await authorizedDocument(u, id), req.query.inline === '1');
});

/**
 * Document archive of a commission: everything attached to its meetings, agenda items, resolutions,
 * issues and the commission itself, with search and filters.
 */
documentsRouter.get('/documents/archive', async (req, res) => {
  const u = currentUser(req);
  const ca = await commissionAccess(u, uuid.parse(req.query.commissionId));
  if (!ca.can('commission.browse')) throw forbidden();
  const { page, pageSize, offset, q } = pageParams(req);
  const kind = typeof req.query.kind === 'string' && req.query.kind ? req.query.kind : null;
  const meetingId = req.query.meetingId ? uuid.parse(req.query.meetingId) : null;
  const where = `d.commission_id = $1 AND ($2::text IS NULL OR d.kind = $2)
    AND ($3::text IS NULL OR d.file_name ILIKE '%' || $3 || '%' OR d.title ILIKE '%' || $3 || '%' OR m.title ILIKE '%' || $3 || '%' OR ai.title ILIKE '%' || $3 || '%')
    AND ($4::uuid IS NULL OR d.meeting_id = $4 OR ai.meeting_id = $4)`;
  const from = `FROM documents d
      LEFT JOIN agenda_items ai ON ai.id = d.agenda_item_id
      LEFT JOIN meetings m ON m.id = COALESCE(d.meeting_id, ai.meeting_id)
      LEFT JOIN resolutions r ON r.id = d.resolution_id
      LEFT JOIN users o ON o.id = d.owner_id`;
  const params = [ca.commission.id, kind, q, meetingId];
  const items = await query(
    `SELECT d.id, d.kind, d.title, d.file_name, d.mime_type, d.size_bytes, d.created_at, o.full_name AS owner_name,
            m.id AS meeting_id, m.number AS meeting_number, m.title AS meeting_title, m.scheduled_at AS meeting_date,
            ai.title AS agenda_title, r.number AS resolution_number
       ${from} WHERE ${where} ORDER BY COALESCE(m.scheduled_at, d.created_at) DESC, d.created_at DESC
       LIMIT ${pageSize} OFFSET ${offset}`,
    params,
  );
  const [{ count }] = await query(`SELECT count(*) ${from} WHERE ${where}`, params);
  const kinds = await query(`SELECT kind, count(*) FROM documents WHERE commission_id = $1 GROUP BY kind`, [ca.commission.id]);
  res.json({ ...paged(items, count, page, pageSize), kinds });
});
