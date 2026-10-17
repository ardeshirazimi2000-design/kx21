/**
 * Letter templates (قالب و سربرگ نامه): the letterhead a letter is typed into and printed on — a drawn header
 * (logo, «بسمه تعالی», organisation name) or a full-page scanned letterhead, margins, footer and starting text.
 * Everyone reads them to write letters; `templates.manage` maintains them.
 */
import { Router } from 'express';
import { z } from 'zod';
import { currentUser, requirePerm } from '../auth/middleware.js';
import { one, query, tx } from '../db/pool.js';
import { audit } from '../lib/audit.js';
import { badRequest, notFound } from '../lib/errors.js';
import { sendFile, upload, uploadedName, validateFile } from '../lib/files.js';
import { sanitizeLetterHtml } from '../lib/html.js';
import { getFile, putFile } from '../lib/storage.js';
import { body, param, uuid } from '../lib/validate.js';

export const templatesRouter = Router();

const COLS = `t.id, t.name, t.description, t.kinds, t.unit_id, ou.name AS unit_name, t.page_size, t.header_text, t.org_name, t.org_subtitle, t.footer_text,
  t.show_logo, t.logo_key IS NOT NULL AS has_logo, t.background_key IS NOT NULL AS has_background, t.margin_top, t.margin_bottom, t.margin_side,
  t.font_size::float AS font_size, t.show_qr, t.body_html, t.is_default, t.is_active, t.updated_at`;

const templateSchema = z.object({
  name: z.string().trim().min(2).max(200),
  description: z.string().max(1000).nullish(),
  kinds: z
    .array(z.enum(['outgoing', 'internal']))
    .min(1)
    .default(['outgoing', 'internal']),
  unitId: uuid.nullish(),
  pageSize: z.enum(['A4', 'A5']).default('A4'),
  headerText: z.string().max(200).nullish(),
  orgName: z.string().max(300).nullish(),
  orgSubtitle: z.string().max(300).nullish(),
  footerText: z.string().max(1000).nullish(),
  showLogo: z.boolean().default(true),
  marginTop: z.number().int().min(0).max(120).default(15),
  marginBottom: z.number().int().min(0).max(120).default(15),
  marginSide: z.number().int().min(0).max(60).default(18),
  fontSize: z.number().min(8).max(24).default(13),
  showQr: z.boolean().default(true),
  bodyHtml: z.string().max(50_000).nullish(),
  isDefault: z.boolean().default(false),
  isActive: z.boolean().default(true),
});

const IMAGE = { logo: { max: 2 * 1024 * 1024, label: 'لوگو' }, background: { max: 5 * 1024 * 1024, label: 'تصویر سربرگ' } } as const;
type ImageKind = keyof typeof IMAGE;
const imageKind = (v: string): ImageKind => {
  if (v !== 'logo' && v !== 'background') throw notFound();
  return v;
};

templatesRouter.get('/letter-templates', async (req, res) => {
  const u = currentUser(req);
  const all = req.query.all === '1' && u.can('templates.manage');
  res.json(
    await query(
      `SELECT ${COLS} FROM letter_templates t LEFT JOIN org_units ou ON ou.id = t.unit_id ${all ? '' : 'WHERE t.is_active'} ORDER BY t.is_default DESC, t.name`,
    ),
  );
});

templatesRouter.get('/letter-templates/:id', async (req, res) => {
  currentUser(req);
  const t = await one(`SELECT ${COLS} FROM letter_templates t LEFT JOIN org_units ou ON ou.id = t.unit_id WHERE t.id = $1`, [param(req, 'id')]);
  if (!t) throw notFound('قالب یافت نشد');
  res.json(t);
});

function values(b: Partial<z.infer<typeof templateSchema>>) {
  return [
    b.name,
    b.description,
    b.kinds,
    b.unitId,
    b.pageSize,
    b.headerText,
    b.orgName,
    b.orgSubtitle,
    b.footerText,
    b.showLogo,
    b.marginTop,
    b.marginBottom,
    b.marginSide,
    b.fontSize,
    b.showQr,
    b.bodyHtml === undefined || b.bodyHtml === null ? b.bodyHtml : sanitizeLetterHtml(b.bodyHtml),
    b.isDefault,
    b.isActive,
  ];
}

templatesRouter.post('/letter-templates', async (req, res) => {
  const u = currentUser(req);
  requirePerm(u, 'templates.manage');
  const b = body(req, templateSchema);
  const row = await tx(async (c) => {
    if (b.isDefault) await c.query('UPDATE letter_templates SET is_default = false WHERE is_default');
    const t = await one(
      `INSERT INTO letter_templates (name, description, kinds, unit_id, page_size, header_text, org_name, org_subtitle, footer_text, show_logo, margin_top,
         margin_bottom, margin_side, font_size, show_qr, body_html, is_default, is_active, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) RETURNING id`,
      [...values(b).map((v) => v ?? null), u.id],
      c,
    );
    await audit(c, req, { action: 'letter_template.created', entity: 'letter_template', entityId: t.id, after: { name: b.name } });
    return t;
  });
  res.status(201).json(await one(`SELECT ${COLS} FROM letter_templates t LEFT JOIN org_units ou ON ou.id = t.unit_id WHERE t.id = $1`, [row.id]));
});

templatesRouter.patch('/letter-templates/:id', async (req, res) => {
  const u = currentUser(req);
  requirePerm(u, 'templates.manage');
  const id = param(req, 'id');
  const b = body(req, templateSchema.partial());
  await tx(async (c) => {
    const before = await one('SELECT * FROM letter_templates WHERE id = $1 FOR UPDATE', [id], c);
    if (!before) throw notFound('قالب یافت نشد');
    if (b.isDefault) await c.query('UPDATE letter_templates SET is_default = false WHERE is_default AND id <> $1', [id]);
    // unitId and the free-text fields may be cleared with null; undefined keeps the current value.
    const v = values(b);
    const keep = (i: number, col: string) => (v[i] === undefined ? before[col] : v[i]);
    await c.query(
      `UPDATE letter_templates SET name = $2, description = $3, kinds = $4, unit_id = $5, page_size = $6, header_text = $7, org_name = $8, org_subtitle = $9,
         footer_text = $10, show_logo = $11, margin_top = $12, margin_bottom = $13, margin_side = $14, font_size = $15, show_qr = $16, body_html = $17,
         is_default = $18, is_active = $19, updated_at = now() WHERE id = $1`,
      [
        id,
        keep(0, 'name'),
        keep(1, 'description'),
        keep(2, 'kinds'),
        keep(3, 'unit_id'),
        keep(4, 'page_size'),
        keep(5, 'header_text'),
        keep(6, 'org_name'),
        keep(7, 'org_subtitle'),
        keep(8, 'footer_text'),
        keep(9, 'show_logo'),
        keep(10, 'margin_top'),
        keep(11, 'margin_bottom'),
        keep(12, 'margin_side'),
        keep(13, 'font_size'),
        keep(14, 'show_qr'),
        keep(15, 'body_html'),
        keep(16, 'is_default'),
        keep(17, 'is_active'),
      ],
    );
    await audit(c, req, { action: 'letter_template.updated', entity: 'letter_template', entityId: id, before: { name: before.name }, after: b });
  });
  res.json(await one(`SELECT ${COLS} FROM letter_templates t LEFT JOIN org_units ou ON ou.id = t.unit_id WHERE t.id = $1`, [id]));
});

/** Deletes an unused template; one that letters already use is deactivated so they keep printing on it. */
templatesRouter.delete('/letter-templates/:id', async (req, res) => {
  const u = currentUser(req);
  requirePerm(u, 'templates.manage');
  const id = param(req, 'id');
  const outcome = await tx(async (c) => {
    const t = await one('SELECT id, name FROM letter_templates WHERE id = $1 FOR UPDATE', [id], c);
    if (!t) throw notFound('قالب یافت نشد');
    const used = await one('SELECT 1 FROM letters WHERE template_id = $1 LIMIT 1', [id], c);
    if (used) await c.query('UPDATE letter_templates SET is_active = false, is_default = false, updated_at = now() WHERE id = $1', [id]);
    else await c.query('DELETE FROM letter_templates WHERE id = $1', [id]);
    await audit(c, req, {
      action: used ? 'letter_template.deactivated' : 'letter_template.deleted',
      entity: 'letter_template',
      entityId: id,
      before: { name: t.name },
    });
    return used ? 'deactivated' : 'deleted';
  });
  res.json({ outcome });
});

templatesRouter.post('/letter-templates/:id/:image', upload.single('file'), async (req, res) => {
  const u = currentUser(req);
  requirePerm(u, 'templates.manage');
  const id = param(req, 'id');
  const kind = imageKind(String(req.params.image));
  if (!req.file) throw badRequest('فایل تصویر ارسال نشده است');
  const mime = validateFile(uploadedName(req.file), req.file.buffer);
  if (!['image/png', 'image/jpeg'].includes(mime)) throw badRequest(`${IMAGE[kind].label} باید PNG یا JPG باشد`);
  if (req.file.size > IMAGE[kind].max) throw badRequest(`حجم ${IMAGE[kind].label} حداکثر ${kind === 'logo' ? '۲' : '۵'} مگابایت است`);
  const stored = await putFile('templates', req.file.buffer);
  await tx(async (c) => {
    const r = await c.query(`UPDATE letter_templates SET ${kind}_key = $2, ${kind}_mime = $3, updated_at = now() WHERE id = $1`, [id, stored.storageKey, mime]);
    if (!r.rowCount) throw notFound('قالب یافت نشد');
    await audit(c, req, {
      action: `letter_template.${kind}_set`,
      entity: 'letter_template',
      entityId: id,
      after: { sha256: stored.sha256, size: stored.size },
    });
  });
  res.status(204).end();
});

templatesRouter.delete('/letter-templates/:id/:image', async (req, res) => {
  const u = currentUser(req);
  requirePerm(u, 'templates.manage');
  const id = param(req, 'id');
  const kind = imageKind(String(req.params.image));
  await tx(async (c) => {
    const r = await c.query(
      `UPDATE letter_templates SET ${kind}_key = NULL, ${kind}_mime = NULL, updated_at = now() WHERE id = $1 AND ${kind}_key IS NOT NULL`,
      [id],
    );
    if (r.rowCount) await audit(c, req, { action: `letter_template.${kind}_removed`, entity: 'letter_template', entityId: id });
  });
  res.status(204).end();
});

templatesRouter.get('/letter-templates/:id/:image', async (req, res) => {
  currentUser(req);
  const kind = imageKind(String(req.params.image));
  const t = await one(`SELECT ${kind}_key AS key, ${kind}_mime AS mime FROM letter_templates WHERE id = $1`, [param(req, 'id')]);
  if (!t?.key) throw notFound('تصویری ثبت نشده است');
  sendFile(res, await getFile(t.key), kind, t.mime, true);
});
