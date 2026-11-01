import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { mergeSecurityPolicy, passwordProblems, type SecurityPolicy } from '@kx/shared';
import { one, type Db, pool } from '../db/pool.js';
import { badRequest } from '../lib/errors.js';

// ─────────────────────────────── Policy ───────────────────────────────

let cached: { at: number; policy: SecurityPolicy } | null = null;

/** The system's security policy (app_settings key `security`), cached for a few seconds. */
export async function securityPolicy(db: Db = pool): Promise<SecurityPolicy> {
  if (cached && Date.now() - cached.at < 5000) return cached.policy;
  const row = await one<{ value: unknown }>(`SELECT value FROM app_settings WHERE key = 'security'`, [], db);
  const policy = mergeSecurityPolicy(row?.value);
  cached = { at: Date.now(), policy };
  return policy;
}

export function invalidateSecurityPolicy() {
  cached = null;
}

// ─────────────────────────────── Failed sign-ins per address ───────────────────────────────

/**
 * Failed sign-ins from one address in the last 15 minutes, so a CAPTCHA is also asked when someone tries many
 * different accounts (or accounts that do not exist) from the same place.
 */
const failuresByIp = new Map<string, number[]>();
const WINDOW_MS = 15 * 60_000;

export function recordIpFailure(ip: string | undefined) {
  if (!ip) return;
  const now = Date.now();
  const list = (failuresByIp.get(ip) ?? []).filter((t) => now - t < WINDOW_MS);
  list.push(now);
  failuresByIp.set(ip, list);
  if (failuresByIp.size > 10_000) failuresByIp.delete(failuresByIp.keys().next().value!);
}

export function ipFailures(ip: string | undefined): number {
  if (!ip) return 0;
  const now = Date.now();
  return (failuresByIp.get(ip) ?? []).filter((t) => now - t < WINDOW_MS).length;
}

/** For tests: forgets the failures of every address. */
export function clearIpFailuresForTest() {
  failuresByIp.clear();
}

// ─────────────────────────────── CAPTCHA ───────────────────────────────

/**
 * A self-hosted image CAPTCHA (no outside service: the system also runs on servers without internet). Five digits
 * are drawn as strokes — never as text — each scaled, slanted and shifted at random, over noise lines, into a PNG
 * that web and mobile show alike. An answer is accepted once, within five minutes.
 */
const challenges = new Map<string, { answerHash: string; expires: number }>();
const TTL_MS = 5 * 60_000;
const W = 180;
const H = 60;

// Digit strokes on a 0..10 × 0..16 grid (polylines).
const DIGITS: number[][][] = [
  [[2, 1, 8, 1, 9, 3, 9, 13, 8, 15, 2, 15, 1, 13, 1, 3, 2, 1]],
  [[3, 4, 6, 1, 6, 15], [3, 15, 9, 15]],
  [[1, 4, 3, 1, 7, 1, 9, 4, 8, 8, 1, 15, 9, 15]],
  [[1, 2, 8, 1, 9, 4, 6, 8, 9, 11, 8, 15, 1, 14], [4, 8, 6, 8]],
  [[7, 15, 7, 1, 1, 11, 9, 11]],
  [[9, 1, 2, 1, 1, 7, 7, 6, 9, 9, 8, 14, 1, 15]],
  [[8, 1, 3, 2, 1, 8, 1, 13, 3, 15, 7, 15, 9, 12, 8, 9, 3, 8, 1, 10]],
  [[1, 1, 9, 1, 4, 15], [3, 8, 8, 8]],
  [[5, 8, 2, 6, 2, 2, 5, 1, 8, 2, 8, 6, 5, 8, 1, 11, 2, 15, 8, 15, 9, 11, 5, 8]],
  [[9, 6, 7, 8, 3, 8, 1, 6, 1, 3, 3, 1, 7, 1, 9, 3, 9, 10, 7, 15, 2, 15]],
];

const rand = (lo: number, hi: number) => lo + crypto.randomInt(0, 10_000) / 10_000 * (hi - lo);

function rasterize(answer: string): Buffer {
  const px = new Uint8Array(W * H).fill(255);
  const dot = (x: number, y: number, r: number, shade: number) => {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        const xx = Math.round(x + dx);
        const yy = Math.round(y + dy);
        if (xx >= 0 && yy >= 0 && xx < W && yy < H && dx * dx + dy * dy <= r * r) px[yy * W + xx] = Math.min(px[yy * W + xx], shade);
      }
    }
  };
  const line = (x0: number, y0: number, x1: number, y1: number, r: number, shade: number) => {
    const steps = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0)));
    for (let i = 0; i <= steps; i++) dot(x0 + ((x1 - x0) * i) / steps, y0 + ((y1 - y0) * i) / steps, r, shade);
  };
  // Noise curves behind and across the digits.
  for (let n = 0; n < 6; n++) {
    let x = rand(0, W);
    let y = rand(0, H);
    for (let s = 0; s < 6; s++) {
      const nx = x + rand(-40, 40);
      const ny = y + rand(-15, 15);
      line(x, y, nx, ny, 0, Math.round(rand(110, 170)));
      x = nx;
      y = ny;
    }
  }
  [...answer].forEach((ch, i) => {
    const scale = rand(2.2, 2.7);
    const slant = rand(-0.35, 0.35);
    const ox = 10 + i * 33 + rand(-3, 3);
    const oy = rand(3, H - 16 * scale - 3);
    const tx = (x: number, y: number): [number, number] => [ox + (x + slant * (16 - y)) * scale, oy + y * scale];
    for (const stroke of DIGITS[Number(ch)]) {
      for (let k = 0; k + 3 < stroke.length; k += 2) {
        const [ax, ay] = tx(stroke[k] + rand(-0.3, 0.3), stroke[k + 1] + rand(-0.3, 0.3));
        const [bx, by] = tx(stroke[k + 2] + rand(-0.3, 0.3), stroke[k + 3] + rand(-0.3, 0.3));
        line(ax, ay, bx, by, 1.5, 40);
      }
    }
  });
  // Speckles.
  for (let n = 0; n < 250; n++) dot(rand(0, W), rand(0, H), 0, Math.round(rand(80, 200)));
  return png(px);
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf: Buffer) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Buffer) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
/** An 8-bit greyscale PNG. */
function png(px: Uint8Array): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(H, 4);
  ihdr.writeUInt8(8, 8); // bit depth
  ihdr.writeUInt8(0, 9); // greyscale
  const raw = Buffer.alloc((W + 1) * H);
  for (let y = 0; y < H; y++) {
    raw[y * (W + 1)] = 0; // filter: none
    Buffer.from(px.buffer, px.byteOffset + y * W, W).copy(raw, y * (W + 1) + 1);
  }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const hashAnswer = (id: string, answer: string) => crypto.createHash('sha256').update(`${id}:${answer}`).digest('hex');

export function createCaptcha(): { id: string; image: string } {
  const now = Date.now();
  for (const [k, v] of challenges) if (v.expires < now) challenges.delete(k);
  if (challenges.size > 20_000) challenges.delete(challenges.keys().next().value!);
  const id = crypto.randomUUID();
  const answer = Array.from({ length: 5 }, () => crypto.randomInt(0, 10)).join('');
  challenges.set(id, { answerHash: hashAnswer(id, answer), expires: now + TTL_MS });
  return { id, image: `data:image/png;base64,${rasterize(answer).toString('base64')}` };
}

/** Checks and consumes a challenge: each one is good for a single attempt. Persian and Arabic digits are accepted. */
export function verifyCaptcha(id: string | undefined, answer: string | undefined): boolean {
  if (!id || !answer) return false;
  const c = challenges.get(id);
  challenges.delete(id);
  if (!c || c.expires < Date.now()) return false;
  const normalized = answer.trim().replace(/[۰-۹]/g, (d) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d))).replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)));
  return crypto.timingSafeEqual(Buffer.from(hashAnswer(id, normalized)), Buffer.from(c.answerHash));
}

/** For tests only: the answer of a challenge, read back from its hash by trying all 100 000 candidates. */
export function solveCaptchaForTest(id: string): string | null {
  const c = challenges.get(id);
  if (!c) return null;
  for (let n = 0; n < 100_000; n++) {
    const a = String(n).padStart(5, '0');
    if (hashAnswer(id, a) === c.answerHash) return a;
  }
  return null;
}

// ─────────────────────────────── Passwords ───────────────────────────────

/** Refuses a password the policy does not allow, naming the first rule it breaks (all of them in `details`). */
export async function assertPasswordAllowed(password: string, context: { email?: string | null; mobile?: string | null } = {}, db: Db = pool) {
  const problems = passwordProblems(password, (await securityPolicy(db)).password, context);
  if (problems.length) throw badRequest(problems[0], problems.map((message) => ({ path: 'password', message })));
}
