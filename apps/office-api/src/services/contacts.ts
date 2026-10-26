import { one, type Db } from '../db/pool.js';
import { badRequest } from '../lib/errors.js';

export interface ContactText {
  externalOrg: string;
  externalParty: string | null;
}

/**
 * The sender / recipient text stored on a letter for a picked contact: the organisation and unit path goes to
 * external_org and a position (with its holder) to external_party, e.g. «سازمان صمت — اداره کل بازرگانی» and
 * «علی رضایی — مدیرکل».
 */
export async function contactText(c: Db, contactId: string): Promise<ContactText> {
  const path = (
    await c.query(
      `WITH RECURSIVE up AS (
         SELECT id, parent_id, kind, name, person_name, is_active, 0 AS depth FROM contacts WHERE id = $1
         UNION ALL SELECT p.id, p.parent_id, p.kind, p.name, p.person_name, p.is_active, up.depth + 1 FROM contacts p JOIN up ON p.id = up.parent_id)
       SELECT * FROM up ORDER BY depth DESC`,
      [contactId],
    )
  ).rows;
  const self = path[path.length - 1];
  if (!self) throw badRequest('مخاطب انتخاب‌شده یافت نشد');
  if (path.some((p) => !p.is_active)) throw badRequest('مخاطب انتخاب‌شده غیرفعال است');
  const orgs = path.filter((p) => p.kind !== 'position').map((p) => p.name);
  const party = self.kind === 'position' ? [self.person_name, self.name].filter(Boolean).join(' — ') : null;
  return { externalOrg: orgs.join(' — '), externalParty: party };
}

/** Kind rules: organisations are roots, units sit under an organisation or unit, positions under either and have no children. */
export async function checkContactParent(c: Db, kind: string, parentId: string | null, selfId?: string) {
  if (kind === 'organization') {
    if (parentId) throw badRequest('سازمان در ریشه ساختار قرار می‌گیرد');
    return;
  }
  if (!parentId) throw badRequest('واحد یا سمت باید زیرمجموعه یک سازمان یا واحد باشد');
  const parent = await one('SELECT kind FROM contacts WHERE id = $1', [parentId], c);
  if (!parent) throw badRequest('مخاطب بالادستی یافت نشد');
  if (parent.kind === 'position') throw badRequest('سمت زیرمجموعه ندارد');
  if (selfId) {
    const cyc = await one(
      `WITH RECURSIVE t AS (SELECT id FROM contacts WHERE id = $1 UNION SELECT x.id FROM contacts x JOIN t ON x.parent_id = t.id) SELECT 1 FROM t WHERE id = $2`,
      [selfId, parentId],
      c,
    );
    if (cyc) throw badRequest('مخاطب نمی‌تواند زیرمجموعه خودش باشد');
  }
}
