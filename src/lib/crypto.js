// Security primitives: JWT (HS256), envelope encryption for sensitive columns,
// HMAC lookup hashes and Ed25519 prescription signatures.
import crypto from 'node:crypto';

export function createKeyring(config) {
  // In production these come from KMS / Vault. Locally they are derived from one secret.
  const root = config.masterSecret;
  const derive = (label) => crypto.createHmac('sha256', root).update(label).digest();
  return {
    jwtKey: derive('jwt'),
    kek: derive('kek-v1'), // key-encryption key ("KMS master key")
    kekId: 'local-kek-v1',
    hmacKey: derive('lookup-hmac'),
    livekitKey: derive('livekit'),
  };
}

const b64u = (b) => Buffer.from(b).toString('base64url');

export function signJwt(keys, claims, ttlSeconds) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = b64u(JSON.stringify({ iat: now, exp: now + ttlSeconds, ...claims }));
  const sig = crypto.createHmac('sha256', keys.jwtKey).update(`${header}.${payload}`).digest('base64url');
  return `${header}.${payload}.${sig}`;
}

export function verifyJwt(keys, token, key = keys.jwtKey) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return null;
  const [h, p, s] = parts;
  const expected = crypto.createHmac('sha256', key).update(`${h}.${p}`).digest();
  const got = Buffer.from(s, 'base64url');
  if (got.length !== expected.length || !crypto.timingSafeEqual(got, expected)) return null;
  try {
    const claims = JSON.parse(Buffer.from(p, 'base64url').toString());
    if (claims.exp && claims.exp < Math.floor(Date.now() / 1000)) return null;
    return claims;
  } catch {
    return null;
  }
}

// Envelope encryption: random DEK per value (AES-256-GCM), DEK wrapped by the KEK.
// Output layout (JSON, stored as BLOB): { k: kekId, w: wrappedDek, i: iv, t: tag, c: ciphertext }
export function seal(keys, plaintext) {
  const dek = crypto.randomBytes(32);
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', dek, iv);
  const ct = Buffer.concat([c.update(String(plaintext), 'utf8'), c.final()]);
  const tag = c.getAuthTag();

  const wiv = crypto.randomBytes(12);
  const w = crypto.createCipheriv('aes-256-gcm', keys.kek, wiv);
  const wrapped = Buffer.concat([wiv, w.update(dek), w.final(), w.getAuthTag()]);
  return Buffer.from(JSON.stringify({ k: keys.kekId, w: b64u(wrapped), i: b64u(iv), t: b64u(tag), c: b64u(ct) }));
}

export function unseal(keys, blob) {
  const env = JSON.parse(Buffer.from(blob).toString());
  const wrapped = Buffer.from(env.w, 'base64url');
  const w = crypto.createDecipheriv('aes-256-gcm', keys.kek, wrapped.subarray(0, 12));
  w.setAuthTag(wrapped.subarray(wrapped.length - 16));
  const dek = Buffer.concat([w.update(wrapped.subarray(12, wrapped.length - 16)), w.final()]);
  const d = crypto.createDecipheriv('aes-256-gcm', dek, Buffer.from(env.i, 'base64url'));
  d.setAuthTag(Buffer.from(env.t, 'base64url'));
  return Buffer.concat([d.update(Buffer.from(env.c, 'base64url')), d.final()]).toString('utf8');
}

export const lookupHash = (keys, value) =>
  crypto.createHmac('sha256', keys.hmacKey).update(String(value)).digest();

export const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

export function randomDigits(n) {
  let s = '';
  for (let i = 0; i < n; i++) s += crypto.randomInt(0, 10);
  return s;
}

export function safeEqualHex(a, b) {
  const x = Buffer.from(String(a), 'hex');
  const y = Buffer.from(String(b), 'hex');
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}

// Prescription signing keys (one Ed25519 pair per doctor; private key sealed at rest).
export function newSigningKeyPair(keys) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return {
    publicPem: publicKey.export({ type: 'spki', format: 'pem' }),
    privateSealed: seal(keys, privateKey.export({ type: 'pkcs8', format: 'pem' })),
  };
}

export function signPayload(keys, privateSealed, payload) {
  const pem = unseal(keys, privateSealed);
  return crypto.sign(null, Buffer.from(payload), crypto.createPrivateKey(pem));
}

export function verifyPayload(publicPem, payload, signature) {
  return crypto.verify(null, Buffer.from(payload), crypto.createPublicKey(publicPem), Buffer.from(signature));
}

// Deterministic JSON for signing.
export function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}
