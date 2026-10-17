import { Router } from 'express';
import { currentUser, requirePerm } from '../auth/middleware.js';
import { query } from '../db/pool.js';
import { verifyAuditChain } from '../lib/audit.js';
import { paged, pageParams } from '../lib/validate.js';

export const auditRouter = Router();

auditRouter.get('/audit', async (req, res) => {
  requirePerm(currentUser(req), 'audit.view');
  const { page, pageSize, offset, q } = pageParams(req);
  const entity = typeof req.query.entity === 'string' && req.query.entity ? req.query.entity : null;
  const entityId = typeof req.query.entityId === 'string' && req.query.entityId ? req.query.entityId : null;
  const where = `($1::text IS NULL OR a.entity = $1) AND ($2::text IS NULL OR a.entity_id = $2) AND ($3::text IS NULL OR a.action ILIKE '%' || $3 || '%' OR u.full_name ILIKE '%' || $3 || '%')`;
  const params = [entity, entityId, q];
  const items = await query(
    `SELECT a.id, a.action, a.entity, a.entity_id, a.reason, a.ip, a.created_at, a.before, a.after, u.full_name AS user_name
       FROM audit_logs a LEFT JOIN users u ON u.id = a.user_id WHERE ${where} ORDER BY a.id DESC LIMIT ${pageSize} OFFSET ${offset}`,
    params,
  );
  const [{ count }] = await query(`SELECT count(*) FROM audit_logs a LEFT JOIN users u ON u.id = a.user_id WHERE ${where}`, params);
  res.json(paged(items, count, page, pageSize));
});

auditRouter.get('/audit/verify', async (req, res) => {
  requirePerm(currentUser(req), 'audit.view');
  res.json(await verifyAuditChain());
});
