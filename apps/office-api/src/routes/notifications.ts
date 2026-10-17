import { Router } from 'express';
import { z } from 'zod';
import { currentUser, requirePerm } from '../auth/middleware.js';
import { query, tx } from '../db/pool.js';
import { audit } from '../lib/audit.js';
import { badRequest } from '../lib/errors.js';
import { body, paged, pageParams } from '../lib/validate.js';
import { DEFAULT_TEMPLATES, NOTIFICATION_EVENTS } from '../services/notifications.js';

export const notificationsRouter = Router();

notificationsRouter.get('/notifications', async (req, res) => {
  const u = currentUser(req);
  const { page, pageSize, offset } = pageParams(req);
  const unread = req.query.unread === 'true';
  const where = `user_id = $1 AND (NOT $2 OR read_at IS NULL)`;
  const items = await query(`SELECT * FROM notifications WHERE ${where} ORDER BY created_at DESC LIMIT ${pageSize} OFFSET ${offset}`, [u.id, unread]);
  const [{ count }] = await query(`SELECT count(*) FROM notifications WHERE ${where}`, [u.id, unread]);
  res.json(paged(items, count, page, pageSize));
});

notificationsRouter.post('/notifications/read', async (req, res) => {
  const u = currentUser(req);
  const b = body(req, z.object({ ids: z.array(z.string().uuid()).optional() }));
  await query(`UPDATE notifications SET read_at = now() WHERE user_id = $1 AND read_at IS NULL AND ($2::uuid[] IS NULL OR id = ANY($2))`, [u.id, b.ids ?? null]);
  res.status(204).end();
});

/** Templates: stored overrides merged over the built-in defaults. */
notificationsRouter.get('/notification-templates', async (req, res) => {
  requirePerm(currentUser(req), 'notifications.manage');
  const rows = await query('SELECT * FROM notification_templates');
  const out = [];
  for (const [event, label] of Object.entries(NOTIFICATION_EVENTS)) {
    for (const channel of ['in_app', 'email', 'sms'] as const) {
      const stored = rows.find((r) => r.event === event && r.channel === channel);
      const def = DEFAULT_TEMPLATES[event as keyof typeof DEFAULT_TEMPLATES][channel];
      out.push({
        event, label, channel,
        subject: stored?.subject ?? def?.subject ?? null,
        body: stored?.body ?? def?.body ?? '',
        enabled: stored ? stored.enabled : !!def,
        customized: !!stored,
      });
    }
  }
  res.json(out);
});

notificationsRouter.put('/notification-templates/:event/:channel', async (req, res) => {
  requirePerm(currentUser(req), 'notifications.manage');
  const event = String(req.params.event);
  const channel = String(req.params.channel);
  if (!(event in NOTIFICATION_EVENTS) || !['in_app', 'email', 'sms'].includes(channel)) throw badRequest('رویداد یا کانال نامعتبر است');
  const b = body(req, z.object({ subject: z.string().max(300).nullish(), body: z.string().min(1).max(4000), enabled: z.boolean().default(true) }));
  await tx(async (c) => {
    await c.query(
      `INSERT INTO notification_templates (event, channel, subject, body, enabled) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (event, channel) DO UPDATE SET subject = EXCLUDED.subject, body = EXCLUDED.body, enabled = EXCLUDED.enabled, updated_at = now()`,
      [event, channel, b.subject ?? null, b.body, b.enabled],
    );
    await audit(c, req, { action: 'notification_template.updated', entity: 'notification_template', entityId: `${event}:${channel}`, after: b });
  });
  res.status(204).end();
});

notificationsRouter.delete('/notification-templates/:event/:channel', async (req, res) => {
  requirePerm(currentUser(req), 'notifications.manage');
  await query('DELETE FROM notification_templates WHERE event = $1 AND channel = $2', [req.params.event, req.params.channel]);
  res.status(204).end();
});

