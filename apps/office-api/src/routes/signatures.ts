/**
 * Specimen signatures (نمونه امضا). The secretariat registers a scanned signature image for a person
 * (`signatures.manage`); anyone may register their own. The image in use is copied onto every
 * digital signature at signing time and printed under the letter.
 */
import { Router } from 'express';
import { currentUser } from '../auth/middleware.js';
import { one, query, tx } from '../db/pool.js';
import { audit } from '../lib/audit.js';
import { badRequest, forbidden, notFound } from '../lib/errors.js';
import { sendFile, upload, uploadedName, validateFile } from '../lib/files.js';
import { getFile, putFile } from '../lib/storage.js';
import { paged, pageParams, param } from '../lib/validate.js';
import { loadVisibleLetter } from '../services/access.js';

export const signaturesRouter = Router();

const MAX_BYTES = 1024 * 1024;

function requireSelfOrManager(req: any, userId: string) {
  const u = currentUser(req);
  if (u.id !== userId && !u.can('signatures.manage') && !u.can('users.manage')) throw forbidden();
  return u;
}

/** People and whether their specimen signature is registered (secretariat page «نمونه امضاها»). */
signaturesRouter.get('/signatures', async (req, res) => {
  const u = currentUser(req);
  if (!u.can('signatures.manage')) throw forbidden();
  const { page, pageSize, offset, q } = pageParams(req);
  const where = `u.username <> 'system' AND u.is_active AND ($1::text IS NULL OR u.full_name ILIKE '%' || $1 || '%' OR u.username ILIKE '%' || $1 || '%')`;
  const items = await query(
    `SELECT u.id, u.username, u.full_name, u.signature_key IS NOT NULL AS has_signature, u.signature_updated_at, sb.full_name AS signature_updated_by,
       (SELECT string_agg(p.title || ' — ' || ou.name, '، ' ORDER BY up.is_primary DESC)
          FROM user_positions up JOIN positions p ON p.id = up.position_id JOIN org_units ou ON ou.id = p.unit_id
         WHERE up.user_id = u.id AND (up.end_date IS NULL OR up.end_date >= current_date)) AS positions,
       EXISTS (SELECT 1 FROM user_roles ur JOIN role_permissions rp ON rp.role_id = ur.role_id WHERE ur.user_id = u.id AND rp.permission_key = 'letter.sign') AS can_sign
     FROM users u LEFT JOIN users sb ON sb.id = u.signature_updated_by
     WHERE ${where} ORDER BY can_sign DESC, u.full_name LIMIT ${pageSize} OFFSET ${offset}`,
    [q],
  );
  const [{ count }] = await query(`SELECT count(*) FROM users u WHERE ${where}`, [q]);
  res.json(paged(items, count, page, pageSize));
});

signaturesRouter.post('/users/:id/signature', upload.single('file'), async (req, res) => {
  const id = param(req, 'id');
  const u = currentUser(req);
  if (u.id !== id && !u.can('signatures.manage')) throw forbidden();
  if (!req.file) throw badRequest('فایل تصویر امضا ارسال نشده است');
  const mime = validateFile(uploadedName(req.file), req.file.buffer);
  if (!['image/png', 'image/jpeg'].includes(mime)) throw badRequest('تصویر امضا باید PNG یا JPG باشد');
  if (req.file.size > MAX_BYTES) throw badRequest('حجم تصویر امضا حداکثر ۱ مگابایت است');
  // Old images stay in storage: earlier signatures still point at them.
  const stored = await putFile('signatures', req.file.buffer);
  await tx(async (c) => {
    const before = await one(`SELECT id, signature_key FROM users WHERE id = $1 AND username <> 'system' FOR UPDATE`, [id], c);
    if (!before) throw notFound();
    await c.query(
      `UPDATE users SET signature_key = $2, signature_mime = $3, signature_updated_at = now(), signature_updated_by = $4, updated_at = now() WHERE id = $1`,
      [id, stored.storageKey, mime, u.id],
    );
    await audit(c, req, {
      action: 'user.signature_set',
      entity: 'user',
      entityId: id,
      after: { sha256: stored.sha256, size: stored.size },
    });
  });
  res.status(204).end();
});

signaturesRouter.delete('/users/:id/signature', async (req, res) => {
  const id = param(req, 'id');
  const u = currentUser(req);
  if (u.id !== id && !u.can('signatures.manage')) throw forbidden();
  await tx(async (c) => {
    const r = await c.query(
      `UPDATE users SET signature_key = NULL, signature_mime = NULL, signature_updated_at = now(), signature_updated_by = $2 WHERE id = $1 AND signature_key IS NOT NULL`,
      [id, u.id],
    );
    if (r.rowCount)
      await audit(c, req, {
        action: 'user.signature_removed',
        entity: 'user',
        entityId: id,
      });
  });
  res.status(204).end();
});

signaturesRouter.get('/users/:id/signature', async (req, res) => {
  const id = param(req, 'id');
  requireSelfOrManager(req, id);
  const row = await one('SELECT signature_key, signature_mime FROM users WHERE id = $1', [id]);
  if (!row?.signature_key) throw notFound('نمونه امضا ثبت نشده است');
  sendFile(res, await getFile(row.signature_key), 'signature', row.signature_mime, true);
});

/** The specimen image captured with a letter's signature (for printing). */
signaturesRouter.get('/letters/:id/signatures/:sigId/image', async (req, res) => {
  const l = await loadVisibleLetter(currentUser(req), param(req, 'id'));
  const s = await one(`SELECT image_key, image_mime FROM signatures WHERE id = $1 AND entity_type = 'letter' AND entity_id = $2`, [param(req, 'sigId'), l.id]);
  if (!s?.image_key) throw notFound('برای این امضا تصویری ثبت نشده است');
  sendFile(res, await getFile(s.image_key), 'signature', s.image_mime, true);
});
