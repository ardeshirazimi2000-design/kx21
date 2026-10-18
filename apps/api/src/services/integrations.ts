import crypto from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { one, pool, query } from '../db/pool.js';
import { forbidden, unauthorized } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { decryptSecret, sha256Hex, signWebhook } from '../lib/secrets.js';

export const INTEGRATION_SCOPES = [
  'meetings:read',
  'resolutions:read',
  'resolutions:feedback',
  'referrals:write',
  'documents:read',
  'documents:write',
  'events:read',
] as const;
export type IntegrationScope = (typeof INTEGRATION_SCOPES)[number];

export const INTEGRATION_EVENTS = [
  'resolution.created',
  'resolution.updated',
  'meeting.updated',
  'referral.updated',
  'meeting.invitation_letters_requested',
] as const;

export interface IntegrationClient {
  id: string;
  chamberId: string;
  name: string;
  scopes: string[];
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      integration?: IntegrationClient;
    }
  }
}

/** API key format: kxi_<prefix>_<secret>. Only the sha256 of the whole key is stored. */
export function generateApiKey() {
  const prefix = crypto.randomBytes(6).toString('hex');
  const key = `kxi_${prefix}_${crypto.randomBytes(32).toString('base64url')}`;
  return { key, prefix, hash: sha256Hex(key) };
}

async function clientByKey(key: string): Promise<IntegrationClient | null> {
  const m = /^kxi_([0-9a-f]{12})_[A-Za-z0-9_-]{20,}$/.exec(key);
  if (!m) return null;
  const row = await one('SELECT id, chamber_id, name, scopes, key_hash, is_active FROM integration_clients WHERE key_prefix = $1', [m[1]]);
  if (!row || !row.is_active) return null;
  const a = Buffer.from(row.key_hash, 'hex');
  const b = Buffer.from(sha256Hex(key), 'hex');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  return { id: row.id, chamberId: row.chamber_id, name: row.name, scopes: row.scopes };
}

async function clientById(id: string): Promise<IntegrationClient | null> {
  const row = await one('SELECT id, chamber_id, name, scopes, is_active FROM integration_clients WHERE id = $1', [id]);
  return row?.is_active ? { id: row.id, chamberId: row.chamber_id, name: row.name, scopes: row.scopes } : null;
}

/** OAuth2 client credentials: client_id = client UUID, client_secret = API key. */
export async function issueClientToken(clientId: string, clientSecret: string) {
  const c = await clientByKey(clientSecret);
  if (!c || c.id !== clientId) return null;
  const expiresIn = 3600;
  const token = jwt.sign({ sub: c.id, typ: 'integration', scope: c.scopes.join(' ') }, config.jwtSecret, { expiresIn, issuer: 'kx-api' });
  return { access_token: token, token_type: 'Bearer', expires_in: expiresIn, scope: c.scopes.join(' ') };
}

/** Accepts `X-Api-Key: kxi_…` or `Authorization: Bearer <client-credentials token>`. */
export async function authenticateIntegration(req: Request, _res: Response, next: NextFunction) {
  const apiKey = req.headers['x-api-key'];
  let client: IntegrationClient | null = null;
  if (typeof apiKey === 'string') {
    client = await clientByKey(apiKey);
  } else if (req.headers.authorization?.startsWith('Bearer ')) {
    try {
      const p = jwt.verify(req.headers.authorization.slice(7), config.jwtSecret, { issuer: 'kx-api' }) as { sub: string; typ: string };
      if (p.typ === 'integration') client = await clientById(p.sub);
    } catch {
      client = null;
    }
  }
  if (!client) throw unauthorized('کلید یا توکن یکپارچه‌سازی نامعتبر است');
  req.integration = client;
  void pool.query('UPDATE integration_clients SET last_used_at = now() WHERE id = $1', [client.id]).catch(() => undefined);
  next();
}

export function requireScope(scope: IntegrationScope) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.integration?.scopes.includes(scope)) throw forbidden(`دسترسی ${scope} برای این سامانه فعال نیست`);
    next();
  };
}

export function integrationClient(req: Request): IntegrationClient {
  if (!req.integration) throw unauthorized();
  return req.integration;
}

// ─────────────────────────────── Outbox delivery ───────────────────────────────

const MAX_ATTEMPTS = 12;
const backoffSeconds = (attempt: number) => Math.min(6 * 3600, 15 * 2 ** (attempt - 1));

export function eventEnvelope(e: { id: number | string; event: string; created_at: Date | string; payload: unknown; chamber_id: string }) {
  return {
    id: String(e.id),
    type: e.event,
    occurredAt: new Date(e.created_at).toISOString(),
    chamberId: e.chamber_id,
    data: e.payload,
  };
}

async function postWebhook(url: string, secret: string, body: string, eventId: string, eventType: string) {
  const ts = Math.floor(Date.now() / 1000);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10_000);
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'user-agent': 'kx-commissions-webhook/1',
        'x-kx-event': eventType,
        'x-kx-delivery': eventId,
        'x-kx-signature': signWebhook(secret, ts, body),
      },
      body,
      signal: ctrl.signal,
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Delivers due outbox rows to the clients' webhooks. Rows of clients without a webhook stay
 * available for polling and are marked skipped. Safe to run concurrently (SKIP LOCKED).
 */
export async function deliverIntegrationEvents(limit = 50): Promise<number> {
  // Lease due rows (short lock), then deliver outside any transaction.
  const rows = await query(
    `WITH due AS (
       SELECT id FROM integration_events WHERE status = 'pending' AND next_attempt_at <= now() ORDER BY id LIMIT $1 FOR UPDATE SKIP LOCKED
     )
     UPDATE integration_events e SET next_attempt_at = now() + interval '2 minutes' FROM due WHERE e.id = due.id
     RETURNING e.*`,
    [limit],
  );
  if (!rows.length) return 0;
  const clients = new Map(
    (await query('SELECT id, webhook_url, webhook_secret_enc FROM integration_clients WHERE id = ANY($1::uuid[])', [[...new Set(rows.map((r) => r.client_id))]])).map(
      (c) => [c.id, c],
    ),
  );
  let delivered = 0;
  for (const e of rows.sort((a, b) => Number(a.id) - Number(b.id))) {
    const ic = clients.get(e.client_id);
    if (!ic?.webhook_url || !ic.webhook_secret_enc) {
      await query(`UPDATE integration_events SET status = 'skipped' WHERE id = $1`, [e.id]);
      continue;
    }
    const body = JSON.stringify(eventEnvelope(e));
    try {
      await postWebhook(ic.webhook_url, decryptSecret(ic.webhook_secret_enc), body, String(e.id), e.event);
      await query(`UPDATE integration_events SET status = 'delivered', attempts = attempts + 1, delivered_at = now(), last_error = NULL WHERE id = $1`, [e.id]);
      delivered++;
    } catch (err) {
      const attempts = e.attempts + 1;
      await query(
        `UPDATE integration_events SET attempts = $2, last_error = $3, status = $4, next_attempt_at = now() + make_interval(secs => $5) WHERE id = $1`,
        [e.id, attempts, String((err as Error).message).slice(0, 500), attempts >= MAX_ATTEMPTS ? 'failed' : 'pending', backoffSeconds(attempts)],
      );
      logger.warn({ eventId: e.id, attempts, err: (err as Error).message }, 'webhook delivery failed');
    }
  }
  return delivered;
}

export function startIntegrationWorker(): () => void {
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    deliverIntegrationEvents()
      .catch((e) => logger.error({ err: e }, 'integration worker failed'))
      .finally(() => {
        running = false;
      });
  }, config.integrationWorkerIntervalSeconds * 1000);
  timer.unref();
  return () => clearInterval(timer);
}

/** Events for polling clients, after a cursor (event id). */
export async function eventsAfter(clientId: string, after: number, limit: number) {
  const rows = await query(
    `SELECT id, event, created_at, payload, chamber_id FROM integration_events WHERE client_id = $1 AND id > $2 ORDER BY id LIMIT $3`,
    [clientId, after, limit],
  );
  return rows.map(eventEnvelope);
}
