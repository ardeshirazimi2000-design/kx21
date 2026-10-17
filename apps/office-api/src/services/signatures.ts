import crypto from 'node:crypto';
import { one, query, type Db } from '../db/pool.js';
import { decryptText, encryptText } from '../lib/crypto.js';

/**
 * Digital signatures with per-user Ed25519 keys. The private key never leaves the server unencrypted
 * (AES-256-GCM at rest); the public key is stored with every signature so it can be verified later
 * even after a key rotation. An HSM / national PKI (گواهی امضای دیجیتال) can replace signDigest().
 */
async function userKeys(userId: string, db: Db) {
  const u = await one('SELECT sign_public_key, sign_private_enc FROM users WHERE id = $1 FOR UPDATE', [userId], db);
  if (u?.sign_public_key && u.sign_private_enc) return { publicKey: u.sign_public_key as string, privateKey: decryptText(u.sign_private_enc) };
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  await query('UPDATE users SET sign_public_key = $2, sign_private_enc = $3 WHERE id = $1', [userId, publicKey, encryptText(privateKey)], db);
  return { publicKey, privateKey };
}

export async function signContent(
  db: Db,
  input: { userId: string; entityType: 'letter' | 'document_version'; entityId: string; contentHash: string; hashVersion?: number; positionTitle?: string | null },
) {
  const keys = await userKeys(input.userId, db);
  const specimen = await one('SELECT signature_key, signature_mime FROM users WHERE id = $1', [input.userId], db);
  const message = Buffer.from(`${input.entityType}:${input.entityId}:${input.contentHash}`);
  const signature = crypto.sign(null, message, keys.privateKey).toString('base64');
  return one(
    `INSERT INTO signatures (entity_type, entity_id, user_id, position_title, content_hash, signature, public_key, image_key, image_mime, hash_version)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id, entity_type, entity_id, user_id, position_title, algorithm, content_hash, signed_at`,
    [
      input.entityType, input.entityId, input.userId, input.positionTitle ?? null, input.contentHash, signature, keys.publicKey,
      specimen?.signature_key ?? null, specimen?.signature_mime ?? null, input.hashVersion ?? 1,
    ],
    db,
  );
}

/** valid = cryptographically valid; intact = the signed content is unchanged. */
export function verifySignature(s: { entity_type: string; entity_id: string; content_hash: string; signature: string; public_key: string }, currentHash: string) {
  const message = Buffer.from(`${s.entity_type}:${s.entity_id}:${s.content_hash}`);
  let valid = false;
  try {
    valid = crypto.verify(null, message, s.public_key, Buffer.from(s.signature, 'base64'));
  } catch {
    valid = false;
  }
  return { valid, intact: valid && s.content_hash === currentHash };
}

/** currentHash: the entity's hash now, or (letters) its hash per hash version. */
export async function signaturesOf(entityType: string, entityId: string, currentHash: string | Record<number, string>, db: Db) {
  const rows = await query(
    `SELECT s.*, u.full_name FROM signatures s JOIN users u ON u.id = s.user_id WHERE s.entity_type = $1 AND s.entity_id = $2 ORDER BY s.signed_at`,
    [entityType, entityId],
    db,
  );
  return rows.map(({ signature, public_key, image_key, image_mime: _m, hash_version, ...r }) => ({
    ...r,
    has_image: !!image_key,
    ...verifySignature({ ...r, signature, public_key }, typeof currentHash === 'string' ? currentHash : currentHash[hash_version]),
  }));
}
