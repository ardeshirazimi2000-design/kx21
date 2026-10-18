import { Router } from 'express';
import { z } from 'zod';
import { currentUser, requirePerm, type AuthUser } from '../auth/middleware.js';
import { one, pool, query, tx, type Db } from '../db/pool.js';
import { audit } from '../lib/audit.js';
import { sha256 } from '../lib/crypto.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { scanFile, sendFile, upload, uploadedName, validateFile } from '../lib/files.js';
import { getFile, putFile } from '../lib/storage.js';
import { body, paged, pageParams, param, parse, uuid } from '../lib/validate.js';
import { documentVisibleSql } from '../services/access.js';
import { disposeDocument, folderPolicy, retentionUntil } from '../services/archive.js';
import { signaturesOf, signContent } from '../services/signatures.js';

export const archiveRouter = Router();

function requireArchiveRead(u: AuthUser) {
  if (!u.can('archive.read') && !u.can('archive.manage') && !u.managedUnits.size) throw forbidden();
}

// ─────────────── Retention policies (سیاست نگهداری و امحا) ───────────────

archiveRouter.get('/archive/policies', async (_req, res) => {
  res.json(await query('SELECT * FROM retention_policies ORDER BY retain_years, name'));
});

const policySchema = z.object({
  name: z.string().min(2).max(200),
  retainYears: z.number().int().min(0).max(200),
  action: z.enum(['destroy', 'review', 'permanent']),
  description: z.string().max(1000).nullish(),
});

archiveRouter.post('/archive/policies', async (req, res) => {
  requirePerm(currentUser(req), 'archive.dispose');
  const b = body(req, policySchema);
  const row = await tx(async (c) => {
    const r = await one('INSERT INTO retention_policies (name, retain_years, action, description) VALUES ($1,$2,$3,$4) RETURNING *', [b.name, b.retainYears, b.action, b.description ?? null], c);
    await audit(c, req, { action: 'retention.created', entity: 'retention_policy', entityId: r.id, after: r });
    return r;
  });
  res.status(201).json(row);
});

archiveRouter.patch('/archive/policies/:id', async (req, res) => {
  requirePerm(currentUser(req), 'archive.dispose');
  const b = body(req, policySchema.partial());
  const row = await tx(async (c) => {
    const before = await one('SELECT * FROM retention_policies WHERE id = $1', [param(req, 'id')], c);
    if (!before) throw notFound();
    const r = await one(
      `UPDATE retention_policies SET name = COALESCE($2, name), retain_years = COALESCE($3, retain_years), action = COALESCE($4, action),
         description = COALESCE($5, description) WHERE id = $1 RETURNING *`,
      [before.id, b.name, b.retainYears, b.action, b.description],
      c,
    );
    await audit(c, req, { action: 'retention.updated', entity: 'retention_policy', entityId: r.id, before, after: r });
    return r;
  });
  res.json(row);
});

// ─────────────── Folders (ساختار درختی) ───────────────

archiveRouter.get('/archive/folders', async (req, res) => {
  requireArchiveRead(currentUser(req));
  res.json(
    await query(
      `SELECT f.*, ou.name AS unit_name, rp.name AS policy_name,
         (SELECT count(*) FROM documents d WHERE d.folder_id = f.id AND d.status = 'active') AS document_count
         FROM archive_folders f LEFT JOIN org_units ou ON ou.id = f.unit_id LEFT JOIN retention_policies rp ON rp.id = f.retention_policy_id
        ORDER BY f.parent_id NULLS FIRST, f.name`,
    ),
  );
});

const folderSchema = z.object({
  name: z.string().min(1).max(200),
  code: z.string().max(50).nullish(),
  parentId: uuid.nullish(),
  unitId: uuid.nullish(),
  retentionPolicyId: uuid.nullish(),
});

archiveRouter.post('/archive/folders', async (req, res) => {
  requirePerm(currentUser(req), 'archive.manage');
  const b = body(req, folderSchema);
  const row = await tx(async (c) => {
    if (await one('SELECT 1 FROM archive_folders WHERE parent_id IS NOT DISTINCT FROM $1 AND name = $2', [b.parentId ?? null, b.name], c)) {
      throw conflict('پرونده‌ای با این نام در این شاخه وجود دارد');
    }
    const r = await one(
      `INSERT INTO archive_folders (parent_id, name, code, unit_id, retention_policy_id, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [b.parentId ?? null, b.name, b.code ?? null, b.unitId ?? null, b.retentionPolicyId ?? null, req.user!.id],
      c,
    );
    await audit(c, req, { action: 'folder.created', entity: 'archive_folder', entityId: r.id, after: r });
    return r;
  });
  res.status(201).json(row);
});

archiveRouter.patch('/archive/folders/:id', async (req, res) => {
  requirePerm(currentUser(req), 'archive.manage');
  const id = param(req, 'id');
  const b = body(req, folderSchema.partial());
  const row = await tx(async (c) => {
    const before = await one('SELECT * FROM archive_folders WHERE id = $1', [id], c);
    if (!before) throw notFound();
    if (b.parentId) {
      const cyc = await one(
        `WITH RECURSIVE t AS (SELECT id FROM archive_folders WHERE id = $1 UNION SELECT f.id FROM archive_folders f JOIN t ON f.parent_id = t.id) SELECT 1 FROM t WHERE id = $2`,
        [id, b.parentId],
        c,
      );
      if (cyc) throw badRequest('پرونده نمی‌تواند زیرمجموعه خودش باشد');
    }
    const r = await one(
      `UPDATE archive_folders SET name = COALESCE($2, name), code = COALESCE($3, code), parent_id = CASE WHEN $4::boolean THEN $5 ELSE parent_id END,
         unit_id = CASE WHEN $6::boolean THEN $7 ELSE unit_id END, retention_policy_id = CASE WHEN $8::boolean THEN $9 ELSE retention_policy_id END
       WHERE id = $1 RETURNING *`,
      [id, b.name, b.code, b.parentId !== undefined, b.parentId ?? null, b.unitId !== undefined, b.unitId ?? null, b.retentionPolicyId !== undefined, b.retentionPolicyId ?? null],
      c,
    );
    await audit(c, req, { action: 'folder.updated', entity: 'archive_folder', entityId: id, before, after: r });
    return r;
  });
  res.json(row);
});

// ─────────────── Documents ───────────────

async function loadDocument(u: AuthUser, id: string, db: Db = pool, lock = false) {
  const params: unknown[] = [id];
  const d = await one(
    `SELECT d.*, f.name AS folder_name, f.unit_id FROM documents d JOIN archive_folders f ON f.id = d.folder_id
      WHERE d.id = $1 AND ${documentVisibleSql(u, params)}${lock ? ' FOR UPDATE OF d' : ''}`,
    params,
    db,
  );
  if (!d) throw notFound('سند یافت نشد');
  return d;
}

archiveRouter.get('/archive/documents', async (req, res) => {
  const u = currentUser(req);
  requireArchiveRead(u);
  const { page, pageSize, offset, q } = pageParams(req);
  const f = parse(z.object({ folderId: uuid.optional(), recursive: z.enum(['true', 'false']).default('true'), status: z.enum(['active', 'disposed', 'all']).default('active'), due: z.enum(['true', 'false']).optional() }), req.query);
  const params: unknown[] = [];
  const add = (v: unknown) => (params.push(v), `$${params.length}`);
  const where = [documentVisibleSql(u, params)];
  if (f.folderId) {
    where.push(
      f.recursive === 'true'
        ? `d.folder_id IN (WITH RECURSIVE t AS (SELECT id FROM archive_folders WHERE id = ${add(f.folderId)} UNION SELECT x.id FROM archive_folders x JOIN t ON x.parent_id = t.id) SELECT id FROM t)`
        : `d.folder_id = ${add(f.folderId)}`,
    );
  }
  if (f.status !== 'all') where.push(`d.status = ${add(f.status)}`);
  if (f.due === 'true') where.push(`d.status = 'active' AND NOT d.legal_hold AND d.retention_until IS NOT NULL AND d.retention_until <= current_date`);
  if (q) {
    const terms = q.replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean).map((t) => `${t}:*`).join(' & ');
    where.push(`(d.search @@ to_tsquery('simple', fa_normalize(${add(terms || q)})) OR l.number = ${add(q)})`);
  }
  const w = where.join(' AND ');
  const from = `FROM documents d JOIN archive_folders f ON f.id = d.folder_id LEFT JOIN letters l ON l.id = d.letter_id LEFT JOIN retention_policies rp ON rp.id = d.retention_policy_id`;
  const items = await query(
    `SELECT d.id, d.title, d.doc_type, d.status, d.confidentiality, d.retention_until, d.legal_hold, d.created_at, d.letter_id, l.number AS letter_number,
            f.name AS folder_name, rp.name AS policy_name, rp.action AS policy_action,
            (SELECT count(*) FROM document_versions v WHERE v.document_id = d.id) AS version_count
       ${from} WHERE ${w} ORDER BY d.created_at DESC LIMIT ${pageSize} OFFSET ${offset}`,
    params,
  );
  const [{ count }] = await query(`SELECT count(*) ${from} WHERE ${w}`, params);
  res.json(paged(items, count, page, pageSize));
});

archiveRouter.post('/archive/documents', upload.single('file'), async (req, res) => {
  const u = currentUser(req);
  requirePerm(u, 'archive.manage');
  const b = parse(
    z.object({
      folderId: uuid,
      title: z.string().min(2).max(500),
      description: z.string().max(5000).nullish(),
      docType: z.string().max(50).default('general'),
      confidentiality: z.coerce.number().int().min(0).max(2).default(0),
      retentionPolicyId: uuid.nullish(),
      note: z.string().max(500).nullish(),
    }),
    req.body,
  );
  if (b.confidentiality > u.clearance) throw forbidden('سطح محرمانگی بالاتر از مجوز شماست');
  let stored: Awaited<ReturnType<typeof putFile>> | null = null;
  let name = '';
  let mime = '';
  if (req.file) {
    name = uploadedName(req.file);
    mime = validateFile(name, req.file.buffer);
    if ((await scanFile(req.file.buffer)) !== 'clean') throw badRequest('فایل آلوده تشخیص داده شد');
    stored = await putFile('archive', req.file.buffer);
  }
  const row = await tx(async (c) => {
    if (!(await one('SELECT 1 FROM archive_folders WHERE id = $1', [b.folderId], c))) throw badRequest('پرونده یافت نشد');
    const policy = b.retentionPolicyId ?? (await folderPolicy(c, b.folderId));
    const d = await one(
      `INSERT INTO documents (folder_id, title, description, doc_type, confidentiality, retention_policy_id, retention_until, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [b.folderId, b.title, b.description ?? null, b.docType, b.confidentiality, policy, await retentionUntil(c, policy), u.id],
      c,
    );
    if (stored) {
      await c.query(
        `INSERT INTO document_versions (document_id, version, file_name, mime_type, size_bytes, storage_key, sha256, note, created_by) VALUES ($1,1,$2,$3,$4,$5,$6,$7,$8)`,
        [d.id, name, mime, stored.size, stored.storageKey, stored.sha256, b.note ?? null, u.id],
      );
    }
    await audit(c, req, { action: 'document.created', entity: 'document', entityId: d.id, after: d });
    return d;
  });
  res.status(201).json(row);
});

archiveRouter.get('/archive/documents/:id', async (req, res) => {
  const u = currentUser(req);
  const d = await loadDocument(u, param(req, 'id'));
  const versions = await query(
    `SELECT v.id, v.version, v.file_name, v.mime_type, v.size_bytes, v.sha256, v.note, v.created_at, (v.storage_key IS NOT NULL) AS available, us.full_name AS created_by_name
       FROM document_versions v LEFT JOIN users us ON us.id = v.created_by WHERE v.document_id = $1 ORDER BY v.version DESC`,
    [d.id],
  );
  const sigs = [];
  for (const v of versions) sigs.push(...(await signaturesOf('document_version', v.id, v.sha256, pool)).map((s) => ({ ...s, version: v.version })));
  const [letter, policy] = await Promise.all([
    d.letter_id ? one('SELECT id, number, subject, kind FROM letters WHERE id = $1', [d.letter_id]) : null,
    d.retention_policy_id ? one('SELECT * FROM retention_policies WHERE id = $1', [d.retention_policy_id]) : null,
  ]);
  res.json({ ...d, versions, signatures: sigs, letter, policy, canManage: u.can('archive.manage'), canDispose: u.can('archive.dispose') });
});

archiveRouter.patch('/archive/documents/:id', async (req, res) => {
  const u = currentUser(req);
  requirePerm(u, 'archive.manage');
  const b = body(
    req,
    z.object({
      title: z.string().min(2).max(500).optional(),
      description: z.string().max(5000).nullish(),
      folderId: uuid.optional(),
      retentionPolicyId: uuid.nullish(),
      legalHold: z.boolean().optional(),
    }),
  );
  const row = await tx(async (c) => {
    const d = await loadDocument(u, param(req, 'id'), c, true);
    if (d.status === 'disposed') throw conflict('سند امحاشده قابل ویرایش نیست');
    if (b.legalHold !== undefined && !u.can('archive.dispose')) throw forbidden('تغییر توقیف قانونی نیازمند مجوز امحا است');
    const until = b.retentionPolicyId !== undefined ? await retentionUntil(c, b.retentionPolicyId ?? null) : d.retention_until;
    const r = await one(
      `UPDATE documents SET title = COALESCE($2, title), description = COALESCE($3, description), folder_id = COALESCE($4, folder_id),
         retention_policy_id = CASE WHEN $5::boolean THEN $6 ELSE retention_policy_id END, retention_until = $7,
         legal_hold = COALESCE($8, legal_hold), updated_at = now() WHERE id = $1 RETURNING *`,
      [d.id, b.title, b.description, b.folderId, b.retentionPolicyId !== undefined, b.retentionPolicyId ?? null, until, b.legalHold],
      c,
    );
    await audit(c, req, { action: 'document.updated', entity: 'document', entityId: d.id, before: d, after: r });
    return r;
  });
  res.json(row);
});

/** New version (کنترل نسخه). */
archiveRouter.post('/archive/documents/:id/versions', upload.single('file'), async (req, res) => {
  const u = currentUser(req);
  requirePerm(u, 'archive.manage');
  if (!req.file) throw badRequest('فایلی ارسال نشده است');
  const note = parse(z.object({ note: z.string().max(500).nullish() }), req.body).note;
  const name = uploadedName(req.file);
  const mime = validateFile(name, req.file.buffer);
  if ((await scanFile(req.file.buffer)) !== 'clean') throw badRequest('فایل آلوده تشخیص داده شد');
  const stored = await putFile('archive', req.file.buffer);
  const row = await tx(async (c) => {
    const d = await loadDocument(u, param(req, 'id'), c, true);
    if (d.status === 'disposed') throw conflict('سند امحا شده است');
    const last = await one('SELECT COALESCE(max(version), 0) AS v FROM document_versions WHERE document_id = $1', [d.id], c);
    const v = await one(
      `INSERT INTO document_versions (document_id, version, file_name, mime_type, size_bytes, storage_key, sha256, note, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id, version, file_name, mime_type, size_bytes, sha256, note, created_at`,
      [d.id, last!.v + 1, name, mime, stored.size, stored.storageKey, stored.sha256, note ?? null, u.id],
      c,
    );
    await c.query('UPDATE documents SET updated_at = now() WHERE id = $1', [d.id]);
    await audit(c, req, { action: 'document.version_added', entity: 'document', entityId: d.id, after: v });
    return v;
  });
  res.status(201).json(row);
});

archiveRouter.get('/archive/versions/:id/download', async (req, res) => {
  const u = currentUser(req);
  const v = await one('SELECT * FROM document_versions WHERE id = $1', [param(req, 'id')]);
  if (!v) throw notFound();
  await loadDocument(u, v.document_id);
  if (!v.storage_key) throw conflict('فایل این نسخه امحا شده است');
  sendFile(res, await getFile(v.storage_key), v.file_name, v.mime_type, req.query.inline === '1');
});

/** Digital signature of a document version. */
archiveRouter.post('/archive/versions/:id/sign', async (req, res) => {
  const u = currentUser(req);
  const row = await tx(async (c) => {
    const v = await one('SELECT * FROM document_versions WHERE id = $1', [param(req, 'id')], c);
    if (!v) throw notFound();
    const d = await loadDocument(u, v.document_id, c);
    requirePerm(u, 'letter.sign', d.unit_id);
    if (!v.storage_key) throw conflict('فایل این نسخه امحا شده است');
    // Re-hash the stored file so the signature covers what is really stored.
    if (sha256(await getFile(v.storage_key)) !== v.sha256) throw conflict('فایل ذخیره‌شده با هش ثبت‌شده مطابقت ندارد');
    const s = await signContent(c, { userId: u.id, entityType: 'document_version', entityId: v.id, contentHash: v.sha256, positionTitle: u.positions[0]?.title });
    await audit(c, req, { action: 'document.signed', entity: 'document', entityId: d.id, after: { versionId: v.id, signatureId: s.id } });
    return s;
  });
  res.status(201).json(row);
});

archiveRouter.post('/archive/documents/:id/dispose', async (req, res) => {
  const u = currentUser(req);
  requirePerm(u, 'archive.dispose');
  const b = body(req, z.object({ reason: z.string().min(5), force: z.boolean().default(false) }));
  const out = await tx(async (c) => {
    const d = await loadDocument(u, param(req, 'id'), c, true);
    if (!b.force && (!d.retention_until || d.retention_until > new Date().toISOString().slice(0, 10))) {
      throw conflict('دوره نگهداری این سند هنوز به پایان نرسیده است');
    }
    return disposeDocument(c, req, d, b.reason);
  });
  await out.deleteFiles();
  res.json(out.row);
});
