// File storage (object-storage stand-in): doctor photos, medical-council cards and patients'
// medical documents. Content is envelope-encrypted at rest; downloads use short-lived signed
// URLs (design doc §5/§8) so <img> tags work without exposing a bearer token.
import crypto from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { open, readFile } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { join } from 'node:path';
import { ApiError, badRequest, notFound } from '../lib/http.js';
import { sealBuffer, unsealBuffer, fileDecipher } from '../lib/crypto.js';
import { uuid, nowIso } from '../lib/db.js';
import { requireUser } from './auth.js';

const MAX_BYTES = 8 * 1024 * 1024;
const URL_TTL_S = 10 * 60;
const PURPOSES = { doctor_photo: ['image'], license_card: ['image', 'pdf'], medical_record: ['image', 'pdf'] };

// Trust the bytes, not the client's Content-Type.
export function sniff(buf) {
  if (buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { mime: 'image/jpeg', kind: 'image' };
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { mime: 'image/png', kind: 'image' };
  if (buf.subarray(0, 4).toString() === 'RIFF' && buf.subarray(8, 12).toString() === 'WEBP') return { mime: 'image/webp', kind: 'image' };
  if (buf.subarray(0, 5).toString() === '%PDF-') return { mime: 'application/pdf', kind: 'pdf' };
  return null;
}

export function createFilesDomain({ db, keys, config }) {
  const dir = config.filesDir;
  mkdirSync(dir, { recursive: true });

  function store(ctx, { purpose, buffer }) {
    if (!PURPOSES[purpose]) throw badRequest('نوع فایل نامعتبر است');
    if (!buffer.length) throw badRequest('فایل خالی است');
    if (buffer.length > MAX_BYTES) throw new ApiError(413, 'file_too_large', 'حداکثر حجم فایل ۸ مگابایت است');
    const t = sniff(buffer);
    if (!t || !PURPOSES[purpose].includes(t.kind)) {
      throw badRequest(PURPOSES[purpose].includes('pdf') ? 'فقط تصویر (JPG، PNG، WEBP) یا PDF مجاز است' : 'فقط تصویر (JPG، PNG، WEBP) مجاز است', 'unsupported_file_type');
    }
    const id = uuid();
    const key = join(id.slice(0, 2), `${id}.bin`);
    mkdirSync(join(dir, id.slice(0, 2)), { recursive: true });
    writeFileSync(join(dir, key), sealBuffer(keys, buffer), { mode: 0o600 });
    db.run(
      'INSERT INTO files (id, tenant_id, owner_user_id, purpose, mime, size, sha256, storage_key, created_at) VALUES (?,?,?,?,?,?,?,?,?)',
      id, ctx.tenantId, ctx.user.sub, purpose, t.mime, buffer.length,
      crypto.createHash('sha256').update(buffer).digest('hex'), key, nowIso(),
    );
    return { id, mime: t.mime, size: buffer.length };
  }

  const sign = (id, exp) => crypto.createHmac('sha256', keys.fileUrlKey).update(`${id}:${exp}`).digest('base64url');
  // Callers must have authorised access before asking for a URL.
  function signedUrl(id) {
    if (!id) return null;
    const exp = Math.floor(Date.now() / 1000) + URL_TTL_S;
    return `/v1/files/${id}?exp=${exp}&sig=${sign(id, exp)}`;
  }
  const meta = (id) => db.get('SELECT id, owner_user_id, purpose, mime, size, created_at FROM files WHERE id = ?', id);

  // Streams the decrypted file to an HTTP response in small chunks, so large downloads never hold
  // up other requests. Headers are written by the caller-supplied function once the size is known.
  async function send(row, res, headers) {
    const fh = await open(join(dir, row.storage_key), 'r');
    let stream;
    try {
      const { size } = await fh.stat();
      const len = Buffer.alloc(4);
      await fh.read(len, 0, 4, 0);
      const n = len.readUInt32BE(0);
      const head = Buffer.alloc(n);
      await fh.read(head, 0, n, 4);
      const decipher = fileDecipher(keys, JSON.parse(head.toString()));
      stream = fh.createReadStream({ start: 4 + n, highWaterMark: 64 * 1024 });
      res.writeHead(200, { ...headers, 'Content-Length': size - 4 - n });
      await pipeline(stream, decipher, res);
    } catch (e) {
      if (stream) stream.destroy(); else await fh.close();
      if (!res.headersSent) throw e;
      res.destroy(); // altered file or client gone: cut the response off
    }
  }

  return { store, signedUrl, meta, sign, send, read: async (row) => unsealBuffer(keys, await readFile(join(dir, row.storage_key))) };
}

export function register(router, { db, platform, domain }) {
  const files = domain.files;

  // Raw upload: body is the file itself (Content-Type image/* or application/pdf).
  router.post('/v1/files', async (ctx) => {
    requireUser(ctx);
    const purpose = ctx.query.purpose;
    const chunks = [];
    let size = 0;
    for await (const c of ctx.req) {
      size += c.length;
      if (size > MAX_BYTES) throw new ApiError(413, 'file_too_large', 'حداکثر حجم فایل ۸ مگابایت است');
      chunks.push(c);
    }
    const f = files.store(ctx, { purpose, buffer: Buffer.concat(chunks) });
    platform.audit(ctx, 'file.upload', `file:${f.id}`, { purpose, size: f.size, mime: f.mime });
    return { status: 201, body: { ...f, url: files.signedUrl(f.id) } };
  });

  router.get('/v1/files/:id', async (ctx) => {
    const row = db.get('SELECT * FROM files WHERE id = ?', ctx.params.id);
    if (!row) throw notFound('فایل');
    const exp = Number(ctx.query.exp);
    const sig = String(ctx.query.sig ?? '');
    const good = files.sign(row.id, exp);
    const valid = exp > Date.now() / 1000 && sig.length === good.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good));
    if (!valid) throw new ApiError(403, 'invalid_signature', 'لینک فایل منقضی یا نامعتبر است');
    await files.send(row, ctx.res, {
      'Content-Type': row.mime, 'Cache-Control': 'private, max-age=300', 'Content-Disposition': 'inline',
      'Content-Security-Policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'",
    });
    return null;
  });
}
