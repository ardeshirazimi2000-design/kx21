import { config } from '../config.js';
import { pool, query, type Db } from '../db/pool.js';
import { logger } from '../lib/logger.js';
import { inc } from '../lib/metrics.js';

/**
 * Durable job queue on PostgreSQL (the "message queue" of the architecture): producers enqueue inside
 * their own transaction, workers lease jobs with FOR UPDATE SKIP LOCKED and retry with backoff.
 * A broker (RabbitMQ/Kafka) can replace it behind enqueue()/registerHandler() without touching callers.
 */
type Handler = (payload: any) => Promise<void>;
const handlers = new Map<string, Handler>();

export function registerHandler(kind: string, fn: Handler) {
  handlers.set(kind, fn);
}

export async function enqueue(kind: string, payload: unknown, db: Db = pool, opts: { delaySeconds?: number; maxAttempts?: number } = {}) {
  await query(
    `INSERT INTO jobs (kind, payload, run_at, max_attempts) VALUES ($1, $2, now() + make_interval(secs => $3), $4)`,
    [kind, JSON.stringify(payload), opts.delaySeconds ?? 0, opts.maxAttempts ?? 8],
    db,
  );
}

const backoff = (attempt: number) => Math.min(3600, 10 * 2 ** (attempt - 1));

export async function processJobs(limit = 20): Promise<number> {
  // Jobs left "running" by a crashed worker go back to the queue.
  await query(`UPDATE jobs SET status = 'queued', locked_at = NULL WHERE status = 'running' AND locked_at < now() - interval '10 minutes'`);
  const jobs = await query(
    `WITH due AS (SELECT id FROM jobs WHERE status = 'queued' AND run_at <= now() ORDER BY run_at, id LIMIT $1 FOR UPDATE SKIP LOCKED)
     UPDATE jobs j SET status = 'running', locked_at = now(), attempts = attempts + 1 FROM due WHERE j.id = due.id RETURNING j.*`,
    [limit],
  );
  for (const j of jobs.sort((a, b) => Number(a.id) - Number(b.id))) {
    const h = handlers.get(j.kind);
    try {
      if (!h) throw new Error(`no handler for ${j.kind}`);
      await h(j.payload);
      await query(`UPDATE jobs SET status = 'done', finished_at = now(), last_error = NULL WHERE id = $1`, [j.id]);
      inc('jobs_processed_total', `kind="${j.kind}",result="done"`);
    } catch (e) {
      const failed = j.attempts >= j.max_attempts;
      await query(
        `UPDATE jobs SET status = $2, last_error = $3, run_at = now() + make_interval(secs => $4), locked_at = NULL,
           finished_at = CASE WHEN $2 = 'failed' THEN now() END WHERE id = $1`,
        [j.id, failed ? 'failed' : 'queued', String((e as Error).message).slice(0, 1000), backoff(j.attempts)],
      );
      inc('jobs_processed_total', `kind="${j.kind}",result="${failed ? 'failed' : 'retry'}"`);
      logger.warn({ job: j.id, kind: j.kind, attempts: j.attempts, err: (e as Error).message }, 'job failed');
    }
  }
  return jobs.length;
}

/** Runs queued jobs until the queue is empty (tests and the "sync now" button). */
export async function drainJobs(max = 200) {
  let total = 0;
  for (let i = 0; i < max; i++) {
    const n = await processJobs();
    total += n;
    if (!n) break;
  }
  return total;
}

export function startWorker(): () => void {
  let running = false;
  const t = setInterval(() => {
    if (running) return;
    running = true;
    processJobs()
      .catch((e) => logger.error({ err: e }, 'worker failed'))
      .finally(() => (running = false));
  }, config.workerIntervalSeconds * 1000);
  t.unref();
  return () => clearInterval(t);
}
