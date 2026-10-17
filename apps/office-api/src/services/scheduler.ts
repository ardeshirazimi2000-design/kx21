import { config } from '../config.js';
import { pool, query, tx } from '../db/pool.js';
import { loadIntegration, pollEvents } from '../integration/meetings.js';
import { logger } from '../lib/logger.js';
import { notify } from './notifications.js';
import { embedPending, refreshIndex } from './search.js';
import { runWorkflowTimers } from './workflow.js';

/**
 * Periodic jobs: workflow SLA reminders/escalations, polling the meetings system (when enabled),
 * daily notice of documents at the end of their retention period, and the smart-search index. Run on one instance only
 * (SCHEDULER_ENABLED=false on the others).
 */
export async function runScheduledJobs() {
  const timers = await tx((c) => runWorkflowTimers(c));
  let polled = 0;
  const i = await loadIntegration().catch(() => null);
  if (i?.settings.poll) {
    polled = await pollEvents().catch(async (e) => {
      await query(`UPDATE integrations SET last_error = $1 WHERE kind = 'meetings'`, [(e as Error).message.slice(0, 500)]);
      return 0;
    });
  }
  // Retention: once a day tell archive officers how many documents are due.
  const due = await query(
    `SELECT count(*)::int AS n FROM documents WHERE status = 'active' AND NOT legal_hold AND retention_until <= current_date
       AND NOT EXISTS (SELECT 1 FROM notifications WHERE event = 'archive.retention_due' AND created_at > now() - interval '1 day')`,
  );
  if (due[0].n > 0) {
    const officers = await query(
      `SELECT DISTINCT ur.user_id FROM user_roles ur JOIN role_permissions rp ON rp.role_id = ur.role_id WHERE rp.permission_key = 'archive.dispose'`,
    );
    await notify({ userIds: officers.map((o) => o.user_id), event: 'archive.retention_due', vars: { count: due[0].n } }, pool);
  }
  // Smart search: index changed letters, then embed them when an AI model is configured.
  const indexed = await refreshIndex(5000).catch((e) => (logger.error({ err: e }, 'search indexing failed'), 0));
  const embedded = await embedPending().catch((e) => (logger.warn({ err: e }, 'letter embedding failed'), 0));
  if (timers.reminded || timers.escalated || polled || indexed || embedded) logger.info({ ...timers, polled, indexed, embedded }, 'scheduled jobs ran');
  return { ...timers, polled, retentionDue: due[0].n, indexed, embedded };
}

export function startScheduler(): () => void {
  const t = setInterval(() => {
    runScheduledJobs().catch((e) => logger.error({ err: e }, 'scheduler failed'));
  }, config.schedulerIntervalSeconds * 1000);
  t.unref();
  return () => clearInterval(t);
}
