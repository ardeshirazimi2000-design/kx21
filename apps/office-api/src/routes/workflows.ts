import { Router } from 'express';
import { z } from 'zod';
import { currentUser, requirePerm } from '../auth/middleware.js';
import { one, query, tx } from '../db/pool.js';
import { audit } from '../lib/audit.js';
import { notFound } from '../lib/errors.js';
import { loadVisibleLetter } from '../services/access.js';
import { body, param, parse } from '../lib/validate.js';
import { definitionSchema } from '../services/workflow.js';

export const workflowsRouter = Router();

/** Latest version of each definition (+ version history on the detail endpoint). */
workflowsRouter.get('/workflows', async (_req, res) => {
  res.json(
    await query(
      `SELECT DISTINCT ON (d.key) d.*, (SELECT count(*) FROM workflow_instances wi JOIN workflow_definitions x ON x.id = wi.definition_id
          WHERE x.key = d.key AND wi.status = 'running') AS running
         FROM workflow_definitions d ORDER BY d.key, d.version DESC`,
    ),
  );
});

workflowsRouter.get('/workflows/:key', async (req, res) => {
  const versions = await query(
    `SELECT d.*, u.full_name AS created_by_name, (SELECT count(*) FROM workflow_instances wi WHERE wi.definition_id = d.id) AS instance_count
       FROM workflow_definitions d LEFT JOIN users u ON u.id = d.created_by WHERE d.key = $1 ORDER BY d.version DESC`,
    [req.params.key],
  );
  if (!versions.length) throw notFound();
  res.json({ latest: versions[0], versions });
});

const upsertSchema = z.object({
  key: z.string().regex(/^[a-z0-9_-]{2,60}$/, 'کلید فقط حروف کوچک لاتین، عدد، - و _'),
  name: z.string().min(2).max(200),
  description: z.string().max(2000).nullish(),
  appliesTo: z.array(z.enum(['incoming', 'outgoing', 'internal'])).min(1).default(['incoming', 'outgoing', 'internal']),
  definition: definitionSchema,
});

/** Creates version 1, or a new version of an existing key (running instances keep their version). */
workflowsRouter.post('/workflows', async (req, res) => {
  const u = currentUser(req);
  requirePerm(u, 'workflow.manage');
  const b = body(req, upsertSchema);
  const row = await tx(async (c) => {
    await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`wf:${b.key}`]);
    const last = await one('SELECT max(version) AS v FROM workflow_definitions WHERE key = $1', [b.key], c);
    const version = (last?.v ?? 0) + 1;
    await c.query('UPDATE workflow_definitions SET is_active = false WHERE key = $1', [b.key]);
    const r = await one(
      `INSERT INTO workflow_definitions (key, version, name, description, applies_to, definition, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [b.key, version, b.name, b.description ?? null, b.appliesTo, JSON.stringify(b.definition), u.id],
      c,
    );
    await audit(c, req, { action: 'workflow.definition_saved', entity: 'workflow_definition', entityId: r.id, after: r });
    return r;
  });
  res.status(201).json(row);
});

/** Activate a specific version (rollback) or deactivate the definition. */
workflowsRouter.post('/workflows/:key/activate', async (req, res) => {
  const u = currentUser(req);
  requirePerm(u, 'workflow.manage');
  const b = parse(z.object({ version: z.number().int().positive().nullable() }), req.body);
  await tx(async (c) => {
    await c.query('UPDATE workflow_definitions SET is_active = false WHERE key = $1', [req.params.key]);
    if (b.version !== null) {
      const r = await one('UPDATE workflow_definitions SET is_active = true WHERE key = $1 AND version = $2 RETURNING id', [req.params.key, b.version], c);
      if (!r) throw notFound('نسخه یافت نشد');
    }
    await audit(c, req, { action: 'workflow.definition_activated', entity: 'workflow_definition', entityId: String(req.params.key), after: b });
  });
  res.status(204).end();
});

workflowsRouter.get('/workflow-instances/:id', async (req, res) => {
  const inst = await one(
    `SELECT wi.*, d.name, d.key, d.version, d.definition FROM workflow_instances wi JOIN workflow_definitions d ON d.id = wi.definition_id WHERE wi.id = $1`,
    [param(req, 'id')],
  );
  if (!inst) throw notFound();
  // Visibility follows the letter.
  await loadVisibleLetter(currentUser(req), inst.letter_id);
  const steps = await query(
    `SELECT ws.*, au.full_name AS assignee_name, p.title AS assignee_position, xu.full_name AS acted_by_name FROM workflow_steps ws
       LEFT JOIN users au ON au.id = ws.assignee_user_id LEFT JOIN positions p ON p.id = ws.assignee_position_id LEFT JOIN users xu ON xu.id = ws.acted_by
      WHERE ws.instance_id = $1 ORDER BY ws.created_at`,
    [inst.id],
  );
  res.json({ ...inst, steps });
});
