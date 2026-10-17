import crypto from 'node:crypto';
import { toJalali } from '@kx/shared';
import { one, query, type Db } from '../db/pool.js';
import { canonical, sha256 } from '../lib/crypto.js';

export const LETTER_PREFIX: Record<string, string> = {
  incoming: process.env.LETTER_PREFIX_INCOMING ?? 'و',
  outgoing: process.env.LETTER_PREFIX_OUTGOING ?? 'ص',
  internal: process.env.LETTER_PREFIX_INTERNAL ?? 'د',
};

/** Indicator number {prefix}/{jalali year}/{sequence}, gap-free per kind and year (row lock on the sequence). */
export async function nextLetterNumber(db: Db, kind: string, at = new Date()) {
  const [jy] = toJalali(at.getFullYear(), at.getMonth() + 1, at.getDate());
  const r = await one<{ last_seq: number }>(
    `INSERT INTO number_sequences (kind, year, last_seq) VALUES ($1, $2, 1)
     ON CONFLICT (kind, year) DO UPDATE SET last_seq = number_sequences.last_seq + 1 RETURNING last_seq`,
    [kind, jy],
    db,
  );
  const seq = r!.last_seq;
  return { number: `${LETTER_PREFIX[kind]}/${jy}/${String(seq).padStart(5, '0')}`, year: jy, seq };
}

/** 12-digit tracking code printed as barcode/QR on the letter. */
export async function newTrackingCode(db: Db): Promise<string> {
  for (;;) {
    const code = String(crypto.randomInt(1, 10)) + String(crypto.randomInt(0, 1e11)).padStart(11, '0');
    if (!(await one('SELECT 1 FROM letters WHERE tracking_code = $1', [code], db))) return code;
  }
}

/** Hash of what a signature on a letter covers: identity, text and the latest version of each attachment. */
export async function letterContentHash(db: Db, letterId: string): Promise<string> {
  const l = await one('SELECT id, kind, number, subject, body, external_party, external_org, external_number, external_date FROM letters WHERE id = $1', [letterId], db);
  const atts = await query(
    `SELECT DISTINCT ON (group_id) group_id, sha256 FROM letter_attachments WHERE letter_id = $1 ORDER BY group_id, version DESC`,
    [letterId],
    db,
  );
  return sha256(canonical({ ...l, attachments: atts.map((a) => a.sha256).sort() }));
}

export async function primaryUnitOf(userId: string, db: Db): Promise<string | null> {
  const r = await one(
    `SELECT p.unit_id FROM user_positions up JOIN positions p ON p.id = up.position_id
      WHERE up.user_id = $1 AND (up.end_date IS NULL OR up.end_date >= current_date) ORDER BY up.is_primary DESC LIMIT 1`,
    [userId],
    db,
  );
  return r?.unit_id ?? null;
}

/** Manager position of a unit (or of the nearest ancestor that has one). */
export async function managerPositionOf(unitId: string, db: Db): Promise<string | null> {
  const r = await one(
    `WITH RECURSIVE up AS (SELECT id, parent_id, 0 AS depth FROM org_units WHERE id = $1
       UNION ALL SELECT o.id, o.parent_id, up.depth + 1 FROM org_units o JOIN up ON o.id = up.parent_id)
     SELECT p.id FROM up JOIN positions p ON p.unit_id = up.id AND p.is_manager ORDER BY up.depth LIMIT 1`,
    [unitId],
    db,
  );
  return r?.id ?? null;
}
