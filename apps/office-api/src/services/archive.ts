import type { Request } from 'express';
import type { AuthUser } from '../auth/middleware.js';
import { one, query, type Db } from '../db/pool.js';
import { audit } from '../lib/audit.js';
import { badRequest, conflict } from '../lib/errors.js';
import { deleteFile } from '../lib/storage.js';

/** retention_until for a document created now under a policy (null = keep forever / no policy). */
export async function retentionUntil(db: Db, policyId: string | null): Promise<string | null> {
  if (!policyId) return null;
  const p = await one('SELECT retain_years, action FROM retention_policies WHERE id = $1', [policyId], db);
  if (!p) throw badRequest('سیاست نگهداری یافت نشد');
  if (p.action === 'permanent') return null;
  const r = await one(`SELECT (current_date + make_interval(years => $1))::date AS d`, [p.retain_years], db);
  return r!.d;
}

/** Folder policy, inherited from the nearest ancestor that has one. */
export async function folderPolicy(db: Db, folderId: string): Promise<string | null> {
  const r = await one(
    `WITH RECURSIVE up AS (SELECT id, parent_id, retention_policy_id, 0 AS depth FROM archive_folders WHERE id = $1
       UNION ALL SELECT f.id, f.parent_id, f.retention_policy_id, up.depth + 1 FROM archive_folders f JOIN up ON f.id = up.parent_id)
     SELECT retention_policy_id FROM up WHERE retention_policy_id IS NOT NULL ORDER BY depth LIMIT 1`,
    [folderId],
    db,
  );
  return r?.retention_policy_id ?? null;
}

/** Default folder for a letter: the owner unit's folder (created on demand under «مکاتبات»). */
async function defaultFolder(db: Db, letter: any): Promise<string> {
  let root = await one(`SELECT id FROM archive_folders WHERE parent_id IS NULL AND name = 'مکاتبات'`, [], db);
  root ??= await one(`INSERT INTO archive_folders (name, code) VALUES ('مکاتبات', 'LTR') RETURNING id`, [], db);
  if (!letter.owner_unit_id) return root!.id;
  const unit = await one('SELECT name, code FROM org_units WHERE id = $1', [letter.owner_unit_id], db);
  const f =
    (await one('SELECT id FROM archive_folders WHERE parent_id = $1 AND unit_id = $2', [root!.id, letter.owner_unit_id], db)) ??
    (await one(
      `INSERT INTO archive_folders (parent_id, name, code, unit_id) VALUES ($1,$2,$3,$4)
       ON CONFLICT (parent_id, name) DO UPDATE SET unit_id = EXCLUDED.unit_id RETURNING id`,
      [root!.id, unit.name, unit.code, letter.owner_unit_id],
      db,
    ));
  return f!.id;
}

/** Files a letter in the archive (بایگانی): one document linked to the letter. */
export async function archiveLetter(db: Db, req: Request | null, u: AuthUser, letter: any, folderId: string | null) {
  if (letter.status === 'cancelled') throw conflict('نامه ابطال‌شده بایگانی نمی‌شود');
  const existing = await one('SELECT * FROM documents WHERE letter_id = $1', [letter.id], db);
  if (existing) return existing;
  const folder = folderId ?? (await defaultFolder(db, letter));
  if (!(await one('SELECT 1 FROM archive_folders WHERE id = $1', [folder], db))) throw badRequest('پرونده بایگانی یافت نشد');
  const policy = await folderPolicy(db, folder);
  const doc = await one(
    `INSERT INTO documents (folder_id, letter_id, title, doc_type, confidentiality, retention_policy_id, retention_until, created_by)
     VALUES ($1,$2,$3,'letter',$4,$5,$6,$7) RETURNING *`,
    [folder, letter.id, `${letter.number ?? ''} ${letter.subject}`.trim(), letter.confidentiality, policy, await retentionUntil(db, policy), u.id],
    db,
  );
  await query(`UPDATE letters SET status = 'archived', archived_at = now(), updated_at = now() WHERE id = $1`, [letter.id], db);
  await query(
    `UPDATE letter_routing SET status = 'done', done_at = now(), done_by = $2 WHERE letter_id = $1 AND status IN ('pending','seen') AND workflow_step_id IS NULL`,
    [letter.id, u.id],
    db,
  );
  await audit(db, req, { action: 'letter.archived', entity: 'letter', entityId: letter.id, after: { documentId: doc.id, folderId: folder } });
  return doc;
}

/** امحا: files are deleted from storage, metadata and audit trail stay. */
export async function disposeDocument(db: Db, req: Request | null, doc: any, reason: string) {
  if (doc.status === 'disposed') throw conflict('این سند قبلاً امحا شده است');
  if (doc.legal_hold) throw conflict('سند در توقیف قانونی (Legal hold) است و امحا نمی‌شود');
  const versions = await query('SELECT id, storage_key FROM document_versions WHERE document_id = $1 AND storage_key IS NOT NULL', [doc.id], db);
  await query('UPDATE document_versions SET storage_key = NULL WHERE document_id = $1', [doc.id], db);
  const row = await one(
    `UPDATE documents SET status = 'disposed', disposed_at = now(), disposed_by = $2, dispose_reason = $3, updated_at = now() WHERE id = $1 RETURNING *`,
    [doc.id, req?.user?.id ?? null, reason],
    db,
  );
  await audit(db, req, { action: 'document.disposed', entity: 'document', entityId: doc.id, before: doc, after: row, reason });
  // Physical deletion after the metadata change is recorded.
  return { row, deleteFiles: () => Promise.all(versions.map((v) => deleteFile(v.storage_key))) };
}
