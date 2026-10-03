// Cross-cutting platform services shared by all modules: event bus (Kafka stand-in with
// a transactional outbox), append-only audit log, notification dispatch (SMS/Email/Push
// stand-in) and log masking of sensitive fields.
import { EventEmitter } from 'node:events';
import { uuid, nowIso } from './db.js';

export function createPlatform({ db, config }) {
  const bus = new EventEmitter();
  bus.setMaxListeners(50);

  function publish(ctx, topic, payload) {
    db.run(
      'INSERT INTO outbox_events (id, tenant_id, topic, payload, trace_id, created_at) VALUES (?,?,?,?,?,?)',
      uuid(), ctx.tenantId, topic, JSON.stringify(payload), ctx.traceId ?? null, nowIso(),
    );
    // Consumers run after the current call stack so a failing consumer never breaks the producer.
    setImmediate(() => {
      for (const l of bus.listeners(topic)) {
        Promise.resolve()
          .then(() => l({ ...payload, tenant_id: ctx.tenantId }, ctx))
          .catch((e) => console.error(`[event ${topic}] consumer failed`, e));
      }
    });
  }

  const subscribe = (topic, fn) => bus.on(topic, fn);

  function audit(ctx, action, resource, detail) {
    db.run(
      'INSERT INTO audit_logs (tenant_id, actor_id, action, resource, detail, ip, trace_id, ts) VALUES (?,?,?,?,?,?,?,?)',
      ctx.tenantId, ctx.user?.sub ?? null, action, resource,
      detail ? JSON.stringify(maskSensitive(detail)) : null, ctx.ip ?? null, ctx.traceId ?? null, nowIso(),
    );
  }

  function notify(ctx, { userId = null, channel, target, body }) {
    const id = uuid();
    db.run(
      'INSERT INTO notifications (id, tenant_id, user_id, channel, target, body, status, created_at) VALUES (?,?,?,?,?,?,?,?)',
      id, ctx.tenantId, userId, channel, target, body, config.smsProvider ? 'queued' : 'delivered_mock', nowIso(),
    );
    if (config.logNotifications) console.log(`[notify:${channel}] ${maskPhone(target)}: ${body}`);
    return id;
  }

  return { publish, subscribe, audit, notify };
}

const SENSITIVE_KEYS = /national_id|password|code|otp|token|signature|private/i;

export function maskSensitive(v, depth = 0) {
  if (depth > 5 || v == null) return v;
  if (Array.isArray(v)) return v.map((x) => maskSensitive(x, depth + 1));
  if (typeof v === 'object') {
    const out = {};
    for (const [k, val] of Object.entries(v)) {
      out[k] = SENSITIVE_KEYS.test(k) ? '***' : k === 'phone' ? maskPhone(val) : maskSensitive(val, depth + 1);
    }
    return out;
  }
  return v;
}

export const maskPhone = (p) => (typeof p === 'string' && p.length > 6 ? `${p.slice(0, 4)}***${p.slice(-3)}` : p);
