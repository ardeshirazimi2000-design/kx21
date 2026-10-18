import { SOCKET_EVENTS } from '@kx/shared';
import { Router } from 'express';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { currentUser, type AuthUser } from '../auth/middleware.js';
import { config } from '../config.js';
import { one, pool, query } from '../db/pool.js';
import { audit } from '../lib/audit.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { body, param, uuid } from '../lib/validate.js';
import { emitToMeeting } from '../realtime.js';
import { meetingAccess } from '../services/access.js';
import { IMAGES, OFFICE, PRESENTABLE, pageCountOf, pageImage, pdfKeyOf, popplerAvailable } from '../services/presentable.js';
import { authorizedDocument } from './documents.js';

/**
 * Live presentation of meeting documents (ارائه مستقیم): the chair or secretary opens a PDF, image or
 * PowerPoint/Word file (converted to PDF) from the meeting's documents and turns the pages; every participant
 * — in the room or in the webinar — follows the same page in the meeting page.
 */
export const presentationRouter = Router();

/**
 * What participants load to see a document: page images rendered on the server (`pages`), or — without
 * Poppler on the server — the PDF itself (`pdf`), or the picture (`image`). Links live for a meeting.
 */
presentationRouter.post('/documents/:id/present-link', async (req, res) => {
  const u = currentUser(req);
  const d = await authorizedDocument(u, param(req, 'id'));
  if (!PRESENTABLE.includes(d.mime_type)) throw badRequest('این نوع فایل قابل ارائه نیست');
  const token = jwt.sign({ sub: u.id, doc: d.id, typ: 'file' }, config.jwtSecret, { expiresIn: '4h', issuer: 'kx-api' });
  const base = `/api/files/${d.id}?token=${token}&inline=1`;
  if (IMAGES.includes(d.mime_type)) return void res.json({ type: 'image', url: base, pages: 1 });
  await pdfKeyOf(d);
  if (await popplerAvailable()) return void res.json({ type: 'pages', url: `${base}&page=`, pages: await pageCountOf(d) });
  res.json({ type: 'pdf', url: `${base}${OFFICE.includes(d.mime_type) ? '&pdf=1' : ''}`, pages: null });
});

/** Page image served by the signed-link route (/files/:id?page=N). */
export async function sendPageImage(res: import('express').Response, d: any, page: number) {
  if (!PRESENTABLE.includes(d.mime_type) || IMAGES.includes(d.mime_type)) throw notFound();
  const n = await pageCountOf(d);
  if (page < 1 || page > n) throw notFound('صفحه یافت نشد');
  const file = await pageImage(d, page);
  res.setHeader('content-type', 'image/png');
  res.setHeader('cache-control', 'private, max-age=86400');
  res.setHeader('x-content-type-options', 'nosniff');
  // Shown by the mobile app as well (another origin when it runs as a web build); the link itself is the access token.
  res.setHeader('cross-origin-resource-policy', 'cross-origin');
  res.sendFile(file, { dotfiles: 'allow' });
}

interface PresentationState {
  documentId: string;
  page: number;
  presenterId: string;
  presenterName: string;
  startedAt: string;
}

async function stateOf(meetingId: string) {
  const r = await one<{ presentation: PresentationState | null }>('SELECT presentation FROM meetings WHERE id = $1', [meetingId]);
  const p = r?.presentation;
  if (!p) return null;
  const d = await one('SELECT id, file_name, title, mime_type, kind FROM documents WHERE id = $1', [p.documentId]);
  return d ? { ...p, document: d } : null;
}

const canPresent = (a: Awaited<ReturnType<typeof meetingAccess>>) => a.can('meeting.manage') || a.can('meeting.control');

presentationRouter.get('/meetings/:id/presentation', async (req, res) => {
  const a = await meetingAccess(currentUser(req), param(req, 'id'));
  res.json({ presentation: await stateOf(a.meeting.id), canPresent: canPresent(a) });
});

/** Start or move the presentation (document and page). */
presentationRouter.put('/meetings/:id/presentation', async (req, res) => {
  const u: AuthUser = currentUser(req);
  const a = await meetingAccess(u, param(req, 'id'));
  if (!canPresent(a)) throw forbidden('فقط رئیس و دبیر جلسه می‌توانند ارائه را اداره کنند');
  const b = body(req, z.object({ documentId: uuid, page: z.number().int().min(1).max(5000).default(1) }));
  const d = await one(
    `SELECT d.* FROM documents d LEFT JOIN agenda_items ai ON ai.id = d.agenda_item_id
      WHERE d.id = $1 AND (d.meeting_id = $2 OR ai.meeting_id = $2)`,
    [b.documentId, a.meeting.id],
  );
  if (!d) throw notFound('سند در مستندات این جلسه نیست');
  if (!PRESENTABLE.includes(d.mime_type)) throw badRequest('این نوع فایل قابل ارائه نیست');
  // Convert and render before telling everyone, so participants do not all wait on the first page.
  if (!IMAGES.includes(d.mime_type)) {
    await pdfKeyOf(d);
    if (await popplerAvailable()) {
      const n = await pageCountOf(d);
      if (b.page > n) throw badRequest('شماره صفحه بیشتر از تعداد صفحات فایل است');
      await pageImage(d, b.page);
      // Prepare the next slide while the presenter speaks.
      if (b.page < n) void pageImage(d, b.page + 1).catch(() => undefined);
    }
  }
  const prev = await one<{ presentation: PresentationState | null }>('SELECT presentation FROM meetings WHERE id = $1', [a.meeting.id]);
  const same = prev?.presentation?.documentId === d.id;
  const me = await one<{ full_name: string }>('SELECT full_name FROM users WHERE id = $1', [u.id]);
  const state: PresentationState = {
    documentId: d.id,
    page: b.page,
    presenterId: u.id,
    presenterName: me!.full_name,
    startedAt: same ? prev!.presentation!.startedAt : new Date().toISOString(),
  };
  await query('UPDATE meetings SET presentation = $2 WHERE id = $1', [a.meeting.id, JSON.stringify(state)]);
  if (!same) {
    await audit(pool, req, { chamberId: a.meeting.chamber_id, action: 'presentation.started', entity: 'meeting', entityId: a.meeting.id, after: { documentId: d.id, fileName: d.file_name } });
  }
  const full = await stateOf(a.meeting.id);
  emitToMeeting(a.meeting.id, SOCKET_EVENTS.presentationUpdated, { meetingId: a.meeting.id, presentation: full });
  res.json({ presentation: full });
});

presentationRouter.delete('/meetings/:id/presentation', async (req, res) => {
  const a = await meetingAccess(currentUser(req), param(req, 'id'));
  if (!canPresent(a)) throw forbidden('فقط رئیس و دبیر جلسه می‌توانند ارائه را اداره کنند');
  await query('UPDATE meetings SET presentation = NULL WHERE id = $1', [a.meeting.id]);
  emitToMeeting(a.meeting.id, SOCKET_EVENTS.presentationUpdated, { meetingId: a.meeting.id, presentation: null });
  res.status(204).end();
});
