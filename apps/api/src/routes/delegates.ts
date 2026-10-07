import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { isEditable, isLive } from '@kx/shared';
import { Router } from 'express';
import { z } from 'zod';
import { currentUser } from '../auth/middleware.js';
import { one, query, tx } from '../db/pool.js';
import { audit } from '../lib/audit.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { body, param, uuid } from '../lib/validate.js';
import { meetingAccess } from '../services/access.js';
import { broadcastMeeting } from '../services/meetings.js';
import { notify } from '../services/notifications.js';
import { createPerson, personSchema } from './structure.js';

/**
 * Representatives (نماینده): an invitee — typically the head of an organisation — sends someone to the
 * meeting in their place. The representative attends, checks in and (if the commission allows) votes on
 * the invitee's behalf; responsibility for resolutions stays with the invitee.
 */
export const delegatesRouter = Router();

/** Readable temporary password (no ambiguous characters). */
function tempPassword() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  return Array.from(crypto.randomBytes(10), (b) => alphabet[b % alphabet.length]).join('');
}

export async function listDelegates(meetingId: string) {
  return query(
    `SELECT d.id, d.principal_id, p.full_name AS principal_name, p.organization AS principal_organization,
            d.delegate_id, u.full_name AS delegate_name, u.mobile AS delegate_mobile, u.identity_verified_at AS delegate_verified_at,
            d.letter_document_id, d.note, d.created_at, cb.full_name AS created_by_name
       FROM meeting_delegates d JOIN users p ON p.id = d.principal_id JOIN users u ON u.id = d.delegate_id
       LEFT JOIN users cb ON cb.id = d.created_by
      WHERE d.meeting_id = $1 AND d.status = 'active' ORDER BY p.full_name`,
    [meetingId],
  );
}

delegatesRouter.post('/meetings/:id/delegates', async (req, res) => {
  const u = currentUser(req);
  const id = param(req, 'id');
  const b = body(
    req,
    z
      .object({
        principalId: uuid.optional(),
        delegateUserId: uuid.optional(),
        person: personSchema.omit({ password: true }).optional(),
        letterDocumentId: uuid.nullish(),
        note: z.string().max(300).nullish(),
      })
      .refine((v) => v.delegateUserId || v.person, 'مشخصات نماینده لازم است'),
  );
  const result = await tx(async (c) => {
    const a = await meetingAccess(u, id, c, { forUpdate: true });
    if (a.delegateFor) throw forbidden('نماینده نمی‌تواند نماینده دیگری معرفی کند');
    const principalId = b.principalId ?? u.id;
    if (principalId !== u.id) a.require('meeting.manage');
    if (!isEditable(a.meeting.status) && !isLive(a.meeting.status)) throw conflict('معرفی نماینده برای این جلسه دیگر ممکن نیست');
    if (!a.settings.allowProxy) throw forbidden('حضور نماینده در این کمیسیون مجاز نیست');
    const principal = await one(
      `SELECT i.user_id, u.full_name, i.role FROM meeting_invitees i JOIN users u ON u.id = i.user_id WHERE i.meeting_id = $1 AND i.user_id = $2`,
      [id, principalId],
      c,
    );
    if (!principal) throw badRequest('فقط برای دعوت‌شدگان این جلسه می‌توان نماینده معرفی کرد');

    if (b.letterDocumentId) {
      const d = await one('SELECT meeting_id FROM documents WHERE id = $1', [b.letterDocumentId], c);
      if (!d || d.meeting_id !== id) throw badRequest('معرفی‌نامه متعلق به این جلسه نیست');
    } else if (a.settings.requireDelegateLetter) {
      throw badRequest('بارگذاری معرفی‌نامه رسمی برای معرفی نماینده الزامی است');
    }

    // The representative: an existing person of the chamber, a person found by national code, or a new person.
    let delegateId = b.delegateUserId ?? null;
    if (delegateId) {
      const p = await one('SELECT chamber_id FROM users WHERE id = $1 AND is_active', [delegateId], c);
      if (!p || p.chamber_id !== a.meeting.chamber_id) throw badRequest('این شخص متعلق به این اتاق نیست');
    } else if (b.person!.nationalId) {
      delegateId = (await one('SELECT id FROM users WHERE chamber_id = $1 AND national_id = $2', [a.meeting.chamber_id, b.person!.nationalId], c))?.id ?? null;
    }
    if (!delegateId) {
      if (!b.person!.mobile && !b.person!.email) throw badRequest('شماره موبایل نماینده برای ورود به سامانه لازم است');
      delegateId = (await createPerson(c, req, a.meeting.chamber_id, b.person!)).id as string;
    }
    if (delegateId === principalId) throw badRequest('شخص دعوت‌شده نمی‌تواند نماینده خودش باشد');
    if (await one('SELECT 1 FROM meeting_invitees WHERE meeting_id = $1 AND user_id = $2', [id, delegateId], c)) {
      throw conflict('این شخص خودش به جلسه دعوت شده است');
    }
    const busy = await one(`SELECT 1 FROM meeting_delegates WHERE meeting_id = $1 AND delegate_id = $2 AND status = 'active'`, [id, delegateId], c);
    if (busy) throw conflict('این شخص در این جلسه نماینده فرد دیگری است');

    // Replace a previous representative of the same invitee.
    await c.query(
      `UPDATE meeting_delegates SET status = 'revoked', revoked_by = $3, revoked_at = now(), revoke_reason = 'جایگزینی نماینده'
        WHERE meeting_id = $1 AND principal_id = $2 AND status = 'active'`,
      [id, principalId, u.id],
    );
    const row = await one(
      `INSERT INTO meeting_delegates (chamber_id, meeting_id, principal_id, delegate_id, letter_document_id, note, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [a.meeting.chamber_id, id, principalId, delegateId, b.letterDocumentId ?? null, b.note ?? null, u.id],
      c,
    );

    // A representative without an account gets a temporary password to log into the app.
    let password: string | null = null;
    const account = await one('SELECT password_hash, full_name, mobile, email FROM users WHERE id = $1', [delegateId], c);
    if (!account.password_hash) {
      password = tempPassword();
      await c.query('UPDATE users SET password_hash = $2 WHERE id = $1', [delegateId, await bcrypt.hash(password, 10)]);
    }
    await audit(c, req, {
      chamberId: a.meeting.chamber_id,
      action: 'meeting.delegate_added',
      entity: 'meeting',
      entityId: id,
      after: { principalId, delegateId, letter: b.letterDocumentId ?? null, accountCreated: !!password },
    });
    return { row, meeting: a.meeting, principal, account, password };
  });

  await notify({
    chamberId: result.meeting.chamber_id,
    userIds: [result.row.delegate_id],
    event: 'meeting.invited',
    title: `معرفی شما به‌عنوان نماینده: ${result.meeting.title}`,
    body: `شما به نمایندگی از ${result.principal.full_name} در این جلسه حضور خواهید داشت.`,
    data: { meetingId: id },
  });
  if (result.row.principal_id !== u.id) {
    await notify({
      chamberId: result.meeting.chamber_id,
      userIds: [result.row.principal_id],
      event: 'meeting.changed',
      title: `ثبت نماینده شما: ${result.meeting.title}`,
      body: `${result.account.full_name} به‌عنوان نماینده شما ثبت شد.`,
      data: { meetingId: id },
    });
  }
  broadcastMeeting(id, { delegatesChanged: true });
  res.status(201).json({
    id: result.row.id,
    delegateId: result.row.delegate_id,
    delegateName: result.account.full_name,
    // Shown once to whoever introduced the representative, to hand over for the first login.
    login: result.password ? { username: result.account.mobile ?? result.account.email, temporaryPassword: result.password } : null,
  });
});

delegatesRouter.delete('/meetings/:id/delegates/:delegationId', async (req, res) => {
  const u = currentUser(req);
  const id = param(req, 'id');
  const delegationId = param(req, 'delegationId');
  const b = body(req, z.object({ reason: z.string().max(300).optional() }));
  await tx(async (c) => {
    const a = await meetingAccess(u, id, c, { forUpdate: true });
    const d = await one(`SELECT * FROM meeting_delegates WHERE id = $1 AND meeting_id = $2 AND status = 'active'`, [delegationId, id], c);
    if (!d) throw notFound('نماینده یافت نشد');
    if (d.principal_id !== u.id) a.require('meeting.manage');
    await c.query(`UPDATE meeting_delegates SET status = 'revoked', revoked_by = $2, revoked_at = now(), revoke_reason = $3 WHERE id = $1`, [
      delegationId, u.id, b.reason ?? null,
    ]);
    await audit(c, req, { chamberId: a.meeting.chamber_id, action: 'meeting.delegate_revoked', entity: 'meeting', entityId: id, before: d, reason: b.reason });
  });
  broadcastMeeting(id, { delegatesChanged: true });
  res.status(204).end();
});
