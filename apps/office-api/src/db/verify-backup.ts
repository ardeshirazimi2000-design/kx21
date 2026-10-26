/**
 * Checks a restored office automation installation (run with the restored DATABASE_URL, STORAGE_DIR and
 * DATA_ENCRYPTION_KEY): every stored file exists, decrypts with the key and matches its recorded SHA-256, every
 * user signing key decrypts and matches its public key, every signature verifies, and the audit chain is intact.
 * Prints counts only (no content, no secrets); exits 1 when anything fails.
 *
 *   node dist/db/verify-backup.js
 */
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyAuditChain } from '../lib/audit.js';
import { decryptText, sha256 } from '../lib/crypto.js';
import { getFile } from '../lib/storage.js';
import { letterHashes } from '../services/letters.js';
import { verifySignature } from '../services/signatures.js';
import { pool, query } from './pool.js';

export interface BackupReport {
  counts: Record<string, number>;
  failures: string[];
}

export async function verifyBackup(): Promise<BackupReport> {
  const failures: string[] = [];
  const counts: Record<string, number> = {};
  for (const t of ['users', 'letters', 'letter_attachments', 'documents', 'document_versions', 'signatures', 'audit_logs', 'workflow_instances']) {
    counts[t] = (await query(`SELECT count(*)::int AS n FROM ${t}`))[0].n;
  }

  // Files with a recorded hash: the content must be byte-identical.
  const hashed = await query(
    `SELECT 'attachment' AS kind, id, storage_key, sha256 FROM letter_attachments
     UNION ALL SELECT 'document version', id, storage_key, sha256 FROM document_versions WHERE storage_key IS NOT NULL`,
  );
  for (const f of hashed) {
    try {
      if (sha256(await getFile(f.storage_key)) !== f.sha256) failures.push(`${f.kind} ${f.id}: content differs from its recorded hash`);
    } catch {
      failures.push(`${f.kind} ${f.id}: file missing or not decryptable`);
    }
  }
  counts.files_hashed = hashed.length;

  // Other stored files (signature specimens, letterheads): they must exist and decrypt.
  const other = await query(
    `SELECT 'signature specimen' AS kind, id::text, signature_key AS key FROM users WHERE signature_key IS NOT NULL
     UNION ALL SELECT 'signature image', id::text, image_key FROM signatures WHERE image_key IS NOT NULL
     UNION ALL SELECT 'template logo', id::text, logo_key FROM letter_templates WHERE logo_key IS NOT NULL
     UNION ALL SELECT 'template background', id::text, background_key FROM letter_templates WHERE background_key IS NOT NULL`,
  );
  for (const f of other) {
    try {
      await getFile(f.key);
    } catch {
      failures.push(`${f.kind} ${f.id}: file missing or not decryptable`);
    }
  }
  counts.files_other = other.length;

  // Secrets at rest: signing keys and integration secrets need the restored DATA_ENCRYPTION_KEY.
  const keys = await query(`SELECT id, sign_public_key, sign_private_enc FROM users WHERE sign_private_enc IS NOT NULL`);
  for (const k of keys) {
    try {
      const pub = crypto.createPublicKey(decryptText(k.sign_private_enc)).export({ type: 'spki', format: 'pem' }).toString();
      if (pub.trim() !== String(k.sign_public_key).trim()) failures.push(`user ${k.id}: signing key does not match its public key`);
    } catch {
      failures.push(`user ${k.id}: signing key not decryptable`);
    }
  }
  counts.signing_keys = keys.length;
  const secrets = await query(`SELECT id, client_secret_enc, webhook_secret_enc FROM integrations`);
  for (const s of secrets) {
    for (const v of [s.client_secret_enc, s.webhook_secret_enc]) {
      if (!v) continue;
      try {
        decryptText(v);
      } catch {
        failures.push(`integration ${s.id}: secret not decryptable`);
      }
    }
  }

  // Signatures: cryptographically valid, and over the content as it is now.
  const sigs = await query(`SELECT s.*, dv.sha256 AS version_hash FROM signatures s LEFT JOIN document_versions dv ON s.entity_type = 'document_version' AND dv.id = s.entity_id`);
  const hashCache = new Map<string, Record<number, string>>();
  let intact = 0;
  for (const s of sigs) {
    let current: string | undefined;
    if (s.entity_type === 'letter') {
      if (!hashCache.has(s.entity_id)) hashCache.set(s.entity_id, await letterHashes(pool, s.entity_id));
      current = hashCache.get(s.entity_id)![s.hash_version];
    } else current = s.version_hash;
    const v = verifySignature(s, current ?? '');
    if (!v.valid) failures.push(`signature ${s.id}: not valid`);
    if (v.intact) intact++;
  }
  counts.signatures_intact = intact;

  const chain = await verifyAuditChain();
  if (chain.brokenAt !== null) failures.push(`audit chain broken at record ${chain.brokenAt}`);
  return { counts, failures };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  verifyBackup()
    .then(async (r) => {
      console.log(JSON.stringify(r, null, 2));
      await pool.end();
      if (r.failures.length) process.exit(1);
    })
    .catch((e) => {
      console.error(e instanceof Error ? e.message : e);
      process.exit(1);
    });
}
