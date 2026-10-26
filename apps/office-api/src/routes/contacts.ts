import { Router } from 'express';
import { z } from 'zod';
import { currentUser, requirePerm } from '../auth/middleware.js';
import { one, query, tx } from '../db/pool.js';
import { audit } from '../lib/audit.js';
import { conflict, notFound } from '../lib/errors.js';
import { body, param, uuid } from '../lib/validate.js';
import { checkContactParent } from '../services/contacts.js';

export const contactsRouter = Router();

const duplicate = (e: any) => {
  if (e?.code === '23505') throw conflict('این مخاطب قبلاً در همین شاخه ثبت شده است');
  throw e;
};

/** The whole directory (pickers build the tree on the client); inactive entries only for those who maintain it. */
contactsRouter.get('/contacts', async (req, res) => {
  const u = currentUser(req);
  const all = req.query.all === '1' && u.can('contacts.manage');
  res.json(
    await query(
      `SELECT c.id, c.parent_id, c.kind, c.name, c.person_name, c.phone, c.email, c.address, c.notes, c.is_active,
              (SELECT count(*) FROM letters l WHERE l.contact_id = c.id) AS letter_count
         FROM contacts c WHERE $1 OR c.is_active ORDER BY c.kind = 'position', c.name`,
      [all],
    ),
  );
});

const contactSchema = z.object({
  parentId: uuid.nullish(),
  kind: z.enum(['organization', 'unit', 'position']),
  name: z.string().trim().min(2).max(300),
  personName: z.string().trim().max(200).nullish(),
  phone: z.string().trim().max(50).nullish(),
  email: z.string().trim().email().max(200).nullish().or(z.literal('')),
  address: z.string().trim().max(1000).nullish(),
  notes: z.string().trim().max(2000).nullish(),
  isActive: z.boolean().optional(),
});

contactsRouter.post('/contacts', async (req, res) => {
  const u = currentUser(req);
  requirePerm(u, 'contacts.manage');
  const b = body(req, contactSchema);
  const row = await tx(async (c) => {
    await checkContactParent(c, b.kind, b.parentId ?? null);
    const r = await one(
      `INSERT INTO contacts (parent_id, kind, name, person_name, phone, email, address, notes, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [b.parentId ?? null, b.kind, b.name, b.personName || null, b.phone || null, b.email || null, b.address || null, b.notes || null, u.id],
      c,
    ).catch(duplicate);
    await audit(c, req, { action: 'contact.created', entity: 'contact', entityId: r.id, after: r });
    return r;
  });
  res.status(201).json(row);
});

contactsRouter.patch('/contacts/:id', async (req, res) => {
  requirePerm(currentUser(req), 'contacts.manage');
  const id = param(req, 'id');
  const b = body(req, contactSchema.omit({ kind: true }).partial());
  const row = await tx(async (c) => {
    const before = await one('SELECT * FROM contacts WHERE id = $1 FOR UPDATE', [id], c);
    if (!before) throw notFound();
    const parentId = b.parentId !== undefined ? (b.parentId ?? null) : before.parent_id;
    if (parentId !== before.parent_id) await checkContactParent(c, before.kind, parentId, id);
    const opt = (k: keyof typeof b, col: string) => (b[k] !== undefined ? (b[k] as any) || null : before[col]);
    const r = await one(
      `UPDATE contacts SET parent_id = $2, name = $3, person_name = $4, phone = $5, email = $6, address = $7, notes = $8, is_active = $9, updated_at = now()
        WHERE id = $1 RETURNING *`,
      [
        id,
        parentId,
        b.name ?? before.name,
        opt('personName', 'person_name'),
        opt('phone', 'phone'),
        opt('email', 'email'),
        opt('address', 'address'),
        opt('notes', 'notes'),
        b.isActive ?? before.is_active,
      ],
      c,
    ).catch(duplicate);
    await audit(c, req, { action: 'contact.updated', entity: 'contact', entityId: id, before, after: r });
    return r;
  });
  res.json(row);
});

/** Only an entry nothing points at can be removed; one already used on letters is deactivated instead. */
contactsRouter.delete('/contacts/:id', async (req, res) => {
  requirePerm(currentUser(req), 'contacts.manage');
  const id = param(req, 'id');
  await tx(async (c) => {
    const before = await one('SELECT * FROM contacts WHERE id = $1 FOR UPDATE', [id], c);
    if (!before) throw notFound();
    if (await one('SELECT 1 FROM contacts WHERE parent_id = $1', [id], c)) throw conflict('ابتدا زیرمجموعه‌های این مخاطب را حذف یا منتقل کنید');
    if (await one('SELECT 1 FROM letters WHERE contact_id = $1', [id], c))
      throw conflict('این مخاطب در نامه‌ها استفاده شده است؛ به جای حذف، آن را غیرفعال کنید');
    await c.query('DELETE FROM contacts WHERE id = $1', [id]);
    await audit(c, req, { action: 'contact.deleted', entity: 'contact', entityId: id, before });
  });
  res.status(204).end();
});
