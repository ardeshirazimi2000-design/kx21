import { Router } from 'express';
import { currentUser, requirePerm } from '../auth/middleware.js';
import { query } from '../db/pool.js';
import { verifyAuditChain } from '../lib/audit.js';
import { paged, pageParams } from '../lib/validate.js';

export const auditRouter = Router();

auditRouter.get('/audit', async (req, res) => {
  const u = currentUser(req);
  requirePerm(u, 'audit.view');
  const { page, pageSize, offset, q } = pageParams(req);
  const entity = typeof req.query.entity === 'string' && req.query.entity ? req.query.entity : null;
  const entityId = typeof req.query.entityId === 'string' && req.query.entityId ? req.query.entityId : null;
  const where = `($1::text IS NULL OR a.entity = $1) AND ($2::text IS NULL OR a.entity_id = $2) AND ($3::text IS NULL OR a.action ILIKE '%' || $3 || '%' OR u.full_name ILIKE '%' || $3 || '%')`;
  const params = [entity, entityId, q];
  // The before/after snapshots of a letter or archived document hold its text: hidden above the viewer's clearance.
  const items = await query(
    `SELECT a.id, a.action, a.entity, a.entity_id, a.reason, a.ip, a.created_at, u.full_name AS user_name,
            CASE WHEN classified.level > $4 THEN NULL ELSE a.before END AS before, CASE WHEN classified.level > $4 THEN NULL ELSE a.after END AS after,
            COALESCE(classified.level > $4, false) AS redacted
       FROM audit_logs a LEFT JOIN users u ON u.id = a.user_id
       LEFT JOIN LATERAL (
         SELECT l.confidentiality AS level FROM letters l WHERE a.entity = 'letter' AND l.id::text = a.entity_id
         UNION ALL SELECT d.confidentiality FROM documents d WHERE a.entity = 'document' AND d.id::text = a.entity_id
       ) classified ON true
      WHERE ${where} ORDER BY a.id DESC LIMIT ${pageSize} OFFSET ${offset}`,
    [...params, u.clearance],
  );
  const [{ count }] = await query(`SELECT count(*) FROM audit_logs a LEFT JOIN users u ON u.id = a.user_id WHERE ${where}`, params);
  res.json(paged(items, count, page, pageSize));
});

auditRouter.get('/audit/verify', async (req, res) => {
  requirePerm(currentUser(req), 'audit.view');
  res.json(await verifyAuditChain());
});
