// Minimal HTTP toolkit: router, JSON I/O, standard error shape { code, message, trace_id },
// rate limiting and SSE. Plays the role of the API Gateway in the design doc.
import { randomUUID } from 'node:crypto';

export class ApiError extends Error {
  constructor(status, code, message, extra) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

export const badRequest = (msg, code = 'validation_error') => new ApiError(422, code, msg);
export const notFound = (what = 'منبع') => new ApiError(404, 'not_found', `${what} پیدا نشد`);
export const forbidden = (msg = 'دسترسی مجاز نیست', code = 'forbidden') => new ApiError(403, code, msg);
export const conflict = (msg, code = 'conflict') => new ApiError(409, code, msg);

export class Router {
  constructor() {
    this.routes = [];
  }
  add(method, path, handler) {
    const keys = [];
    const pattern = new RegExp(
      '^' + path.replace(/:(\w+)/g, (_, k) => (keys.push(k), '([^/]+)')) + '/?$',
    );
    this.routes.push({ method, pattern, keys, handler });
  }
  get(p, h) { this.add('GET', p, h); }
  post(p, h) { this.add('POST', p, h); }
  put(p, h) { this.add('PUT', p, h); }
  delete(p, h) { this.add('DELETE', p, h); }

  match(method, pathname) {
    let pathMatched = false;
    for (const r of this.routes) {
      const m = r.pattern.exec(pathname);
      if (!m) continue;
      pathMatched = true;
      if (r.method !== method) continue;
      const params = {};
      r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
      return { handler: r.handler, params };
    }
    return pathMatched ? 'method' : null;
  }
}

export async function readJson(req, limit = 256 * 1024) {
  if (req.method === 'GET' || req.method === 'HEAD') return {};
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new ApiError(413, 'payload_too_large', 'حجم درخواست بیش از حد مجاز است');
    chunks.push(c);
  }
  if (!size) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw badRequest('بدنه درخواست JSON معتبر نیست', 'invalid_json');
  }
}

export function sendJson(res, status, body, headers = {}) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(data),
    ...headers,
  });
  res.end(data);
}

export function sendError(res, err, traceId) {
  if (!(err instanceof ApiError)) {
    console.error(`[${traceId}]`, err);
    err = new ApiError(500, 'internal_error', 'خطای داخلی سرور');
  }
  if (res.headersSent) {
    // Streaming already started (SSE): surface the error as a terminal event.
    try {
      res.write(`event: error\ndata: ${JSON.stringify({ code: err.code, message: err.message, trace_id: traceId })}\n\n`);
      res.end();
    } catch { /* socket gone */ }
    return;
  }
  sendJson(res, err.status, { code: err.code, message: err.message, trace_id: traceId, ...(err.extra || {}) });
}

export function openSse(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  return {
    send(event, data) {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    },
    end() { res.end(); },
  };
}

// Fixed-window limiter keyed per user / tenant / ip (gateway rate limiting).
export class RateLimiter {
  constructor() { this.buckets = new Map(); }
  hit(key, limit, windowMs, now = Date.now()) {
    let b = this.buckets.get(key);
    if (!b || now >= b.reset) {
      b = { count: 0, reset: now + windowMs };
      this.buckets.set(key, b);
    }
    b.count++;
    if (b.count > limit) {
      throw new ApiError(429, 'rate_limited', 'تعداد درخواست‌ها بیش از حد مجاز است؛ کمی بعد دوباره تلاش کنید', {
        retry_after_s: Math.ceil((b.reset - now) / 1000),
      });
    }
    if (this.buckets.size > 50_000) this.sweep(now);
  }
  sweep(now = Date.now()) {
    for (const [k, b] of this.buckets) if (now >= b.reset) this.buckets.delete(k);
  }
}

export const newTraceId = () => randomUUID().replace(/-/g, '');

export function requireFields(body, fields) {
  for (const f of fields) {
    if (body[f] === undefined || body[f] === null || body[f] === '') {
      throw badRequest(`فیلد ${f} الزامی است`);
    }
  }
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function requireUuid(v, name) {
  if (typeof v !== 'string' || !UUID_RE.test(v)) throw badRequest(`${name} باید UUID معتبر باشد`);
  return v;
}

// Cursor pagination: opaque base64url of "created_at|id".
export const encodeCursor = (row) =>
  row ? Buffer.from(`${row.created_at}|${row.id}`).toString('base64url') : null;
export function decodeCursor(c) {
  if (!c) return null;
  const [created_at, id] = Buffer.from(String(c), 'base64url').toString().split('|');
  if (!created_at || !id) throw badRequest('cursor نامعتبر است', 'invalid_cursor');
  return { created_at, id };
}
