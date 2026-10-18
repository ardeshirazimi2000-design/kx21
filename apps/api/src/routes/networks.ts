import { NETWORK_PROPOSAL_STATUSES } from '@kx/shared';
import { Router } from 'express';
import { z } from 'zod';
import { currentUser, type AuthUser } from '../auth/middleware.js';
import { one, query, tx, type Db, pool } from '../db/pool.js';
import { audit } from '../lib/audit.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { body, dateStr, param, uuid } from '../lib/validate.js';
import { commissionAccess, isChamberAdmin, requireSuperAdmin } from '../services/access.js';
import { notify } from '../services/notifications.js';
import { buildLetterDocx, draftLetter, loadLetterData } from '../services/proposalLetter.js';
import { engineInfo, similarPairs } from '../services/similarity.js';

/**
 * Thematic networks of commissions (شبکه‌های موضوعی کمیسیون‌ها). The Super Admin defines networks and their
 * coordinators (دبیر شبکه); chamber admins join their commissions. Members of a network's commissions see the
 * network and what its commissions share; nothing of a commission is visible to others unless shared.
 */
export const networksRouter = Router();

const HELD = `('minutes_draft','pending_approval','approved','archived')`;
const OFFICERS = `('chair','vice_chair','secretary')`;

interface NetworkAccess {
  network: any;
  isCoordinator: boolean;
  /** Super Admin or coordinator: manages proposals and sees the comparative dashboard. */
  isNational: boolean;
  /** Network commissions the user may act for (officer with resolution.manage, or chamber admin). */
  actFor: string[];
  canDashboard: boolean;
}

/** Commission ids (among `ids`) the user may act for in the network: share and endorse. */
async function actingCommissions(u: AuthUser, ids: string[], db: Db = pool): Promise<string[]> {
  const out: string[] = [];
  for (const id of ids) {
    const ca = await commissionAccess(u, id, db).catch(() => null);
    if (ca && (ca.can('resolution.manage') || isChamberAdmin(u, ca.commission.chamber_id))) out.push(id);
  }
  return out;
}

async function networkAccess(u: AuthUser, id: string, db: Db = pool): Promise<NetworkAccess> {
  const network = await one('SELECT * FROM networks WHERE id = $1', [id], db);
  if (!network) throw notFound('شبکه یافت نشد');
  const isCoordinator = !!(await one('SELECT 1 FROM network_coordinators WHERE network_id = $1 AND user_id = $2', [id, u.id], db));
  const members = await query<{ commission_id: string; chamber_id: string; is_member: boolean }>(
    `SELECT nc.commission_id, c.chamber_id,
       EXISTS (SELECT 1 FROM commission_memberships m WHERE m.commission_id = c.id AND m.user_id = $2 AND m.status = 'active') AS is_member
     FROM network_commissions nc JOIN commissions c ON c.id = nc.commission_id WHERE nc.network_id = $1`,
    [id, u.id],
    db,
  );
  const adminOfMember = members.some((m) => u.adminChambers.includes(m.chamber_id));
  const memberOfMember = members.some((m) => m.is_member);
  if (!u.isSuperAdmin && !isCoordinator && !adminOfMember && !memberOfMember) throw notFound('شبکه یافت نشد');
  const isNational = u.isSuperAdmin || isCoordinator;
  return {
    network,
    isCoordinator,
    isNational,
    actFor: await actingCommissions(u, members.map((m) => m.commission_id), db),
    canDashboard: isNational || adminOfMember,
  };
}

/** Users holding an officer position in the given commissions. */
async function officersOf(commissionIds: string[], db: Db = pool): Promise<string[]> {
  if (!commissionIds.length) return [];
  const rows = await query<{ user_id: string }>(
    `SELECT DISTINCT user_id FROM commission_memberships WHERE commission_id = ANY($1) AND status = 'active' AND position IN ${OFFICERS}`,
    [commissionIds],
    db,
  );
  return rows.map((r) => r.user_id);
}

async function nationalUsers(networkId: string, db: Db = pool): Promise<string[]> {
  const rows = await query<{ id: string }>(
    `SELECT user_id AS id FROM network_coordinators WHERE network_id = $1 UNION SELECT id FROM users WHERE is_super_admin AND is_active`,
    [networkId],
    db,
  );
  return rows.map((r) => r.id);
}

// ─────────────────────────────── Networks ───────────────────────────────

const networkSchema = z.object({
  name: z.string().min(3),
  description: z.string().nullish(),
  endorseThreshold: z.number().int().min(2).max(40).default(3),
  status: z.enum(['active', 'archived']).default('active'),
});

networksRouter.get('/networks', async (req, res) => {
  const u = currentUser(req);
  const rows = await query(
    `SELECT n.*,
       (SELECT count(*) FROM network_commissions nc WHERE nc.network_id = n.id) AS commission_count,
       (SELECT count(DISTINCT c.chamber_id) FROM network_commissions nc JOIN commissions c ON c.id = nc.commission_id WHERE nc.network_id = n.id) AS chamber_count,
       (SELECT count(*) FROM resolutions r JOIN network_commissions nc ON nc.commission_id = r.commission_id
          WHERE nc.network_id = n.id AND r.shared_at IS NOT NULL) AS shared_count,
       (SELECT count(*) FROM network_proposals p WHERE p.network_id = n.id) AS proposal_count,
       EXISTS (SELECT 1 FROM network_coordinators k WHERE k.network_id = n.id AND k.user_id = $1) AS is_coordinator
     FROM networks n
     WHERE $2::boolean
        OR EXISTS (SELECT 1 FROM network_coordinators k WHERE k.network_id = n.id AND k.user_id = $1)
        OR EXISTS (SELECT 1 FROM network_commissions nc JOIN commissions c ON c.id = nc.commission_id
                    WHERE nc.network_id = n.id AND (c.chamber_id = ANY($3::uuid[])
                      OR EXISTS (SELECT 1 FROM commission_memberships m WHERE m.commission_id = c.id AND m.user_id = $1 AND m.status = 'active')))
     ORDER BY n.status, n.name`,
    [u.id, u.isSuperAdmin, u.adminChambers],
  );
  res.json(rows);
});

networksRouter.post('/networks', async (req, res) => {
  const u = currentUser(req);
  requireSuperAdmin(u);
  const b = body(req, networkSchema);
  const row = await tx(async (c) => {
    const r = await one(
      `INSERT INTO networks (name, description, endorse_threshold, status, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [b.name, b.description ?? null, b.endorseThreshold, b.status, u.id],
      c,
    );
    await audit(c, req, { chamberId: null, action: 'network.created', entity: 'network', entityId: r.id, after: r });
    return r;
  }).catch((e) => {
    if (e.code === '23505') throw conflict('شبکه‌ای با این نام وجود دارد');
    throw e;
  });
  res.status(201).json(row);
});

networksRouter.patch('/networks/:id', async (req, res) => {
  const u = currentUser(req);
  requireSuperAdmin(u);
  const id = param(req, 'id');
  const b = body(req, networkSchema.partial());
  const row = await tx(async (c) => {
    const before = await one('SELECT * FROM networks WHERE id = $1 FOR UPDATE', [id], c);
    if (!before) throw notFound('شبکه یافت نشد');
    const after = await one(
      `UPDATE networks SET name = COALESCE($2, name), description = COALESCE($3, description),
         endorse_threshold = COALESCE($4, endorse_threshold), status = COALESCE($5, status), updated_at = now()
       WHERE id = $1 RETURNING *`,
      [id, b.name, b.description, b.endorseThreshold, b.status],
      c,
    );
    await audit(c, req, { chamberId: null, action: 'network.updated', entity: 'network', entityId: id, before, after });
    return after;
  }).catch((e) => {
    if (e.code === '23505') throw conflict('شبکه‌ای با این نام وجود دارد');
    throw e;
  });
  res.json(row);
});

/** Map of all networks the user can see: networks and the chambers taking part in each (with commission counts). */
networksRouter.get('/networks/map', async (req, res) => {
  const u = currentUser(req);
  const networks = await query(
    `SELECT n.id, n.name, n.status,
       (SELECT count(*) FROM resolutions r JOIN network_commissions nc ON nc.commission_id = r.commission_id
          WHERE nc.network_id = n.id AND r.shared_at IS NOT NULL)::int AS shared_count,
       (SELECT count(*) FROM network_proposals p WHERE p.network_id = n.id)::int AS proposal_count
     FROM networks n
     WHERE $2::boolean
        OR EXISTS (SELECT 1 FROM network_coordinators k WHERE k.network_id = n.id AND k.user_id = $1)
        OR EXISTS (SELECT 1 FROM network_commissions nc JOIN commissions c ON c.id = nc.commission_id
                    WHERE nc.network_id = n.id AND (c.chamber_id = ANY($3::uuid[])
                      OR EXISTS (SELECT 1 FROM commission_memberships m WHERE m.commission_id = c.id AND m.user_id = $1 AND m.status = 'active')))
     ORDER BY n.name`,
    [u.id, u.isSuperAdmin, u.adminChambers],
  );
  const ids = networks.map((n: any) => n.id);
  const links = ids.length
    ? await query(
        `SELECT nc.network_id, c.chamber_id, count(*)::int AS commissions
           FROM network_commissions nc JOIN commissions c ON c.id = nc.commission_id
          WHERE nc.network_id = ANY($1) GROUP BY nc.network_id, c.chamber_id`,
        [ids],
      )
    : [];
  const chamberIds = [...new Set(links.map((l: any) => l.chamber_id))];
  const chambers = chamberIds.length
    ? await query(
        `SELECT ch.id, ch.name, ch.province, ($2::boolean OR ch.id = ANY($3::uuid[]) OR ch.id = $4) AS mine
           FROM chambers ch WHERE ch.id = ANY($1) ORDER BY ch.province`,
        [chamberIds, u.isSuperAdmin, u.adminChambers, u.chamberId],
      )
    : [];
  res.json({ networks, chambers, links });
});

networksRouter.get('/networks/:id', async (req, res) => {
  const u = currentUser(req);
  const a = await networkAccess(u, param(req, 'id'));
  const commissions = await query(
    `SELECT c.id, c.name, c.code, c.domain, c.status, c.chamber_id, ch.name AS chamber_name, ch.province, t.title AS term_title, nc.added_at,
       (SELECT count(*) FROM commission_memberships m WHERE m.commission_id = c.id AND m.status = 'active') AS member_count,
       (SELECT u.full_name FROM commission_memberships m JOIN users u ON u.id = m.user_id
          WHERE m.commission_id = c.id AND m.status = 'active' AND m.position = 'chair' LIMIT 1) AS chair_name,
       (SELECT u.full_name FROM commission_memberships m JOIN users u ON u.id = m.user_id
          WHERE m.commission_id = c.id AND m.status = 'active' AND m.position = 'secretary' LIMIT 1) AS secretary_name,
       (SELECT count(*) FROM resolutions r WHERE r.commission_id = c.id AND r.shared_at IS NOT NULL) AS shared_count,
       ($2::boolean OR c.chamber_id = ANY($3::uuid[])
          OR EXISTS (SELECT 1 FROM commission_memberships m WHERE m.commission_id = c.id AND m.user_id = $4 AND m.status = 'active')) AS can_open
     FROM network_commissions nc JOIN commissions c ON c.id = nc.commission_id JOIN chambers ch ON ch.id = c.chamber_id
     JOIN terms t ON t.id = c.term_id
     WHERE nc.network_id = $1 ORDER BY ch.province, c.name`,
    [a.network.id, u.isSuperAdmin, u.adminChambers, u.id],
  );
  // Endorsements between the network's commissions (supporter → originating commission), for the network map.
  const links = await query(
    `SELECT e.commission_id AS source, r.commission_id AS target, count(*)::int AS count
       FROM resolution_endorsements e JOIN resolutions r ON r.id = e.resolution_id
      WHERE e.commission_id IN (SELECT commission_id FROM network_commissions WHERE network_id = $1)
        AND r.commission_id IN (SELECT commission_id FROM network_commissions WHERE network_id = $1)
      GROUP BY e.commission_id, r.commission_id`,
    [a.network.id],
  );
  const coordinators = await query(
    `SELECT u.id, u.full_name, u.organization, ch.name AS chamber_name FROM network_coordinators k JOIN users u ON u.id = k.user_id
       LEFT JOIN chambers ch ON ch.id = u.chamber_id WHERE k.network_id = $1 ORDER BY u.full_name`,
    [a.network.id],
  );
  // Commissions of the caller's chambers that can still join (chamber admins / Super Admin pick them in the UI).
  const joinable = u.isSuperAdmin || u.adminChambers.length
    ? await query(
        `SELECT c.id, c.name, ch.name AS chamber_name FROM commissions c JOIN chambers ch ON ch.id = c.chamber_id JOIN terms t ON t.id = c.term_id
          WHERE c.status = 'active' AND t.status = 'active' AND ($2::boolean OR c.chamber_id = ANY($3::uuid[]))
            AND NOT EXISTS (SELECT 1 FROM network_commissions nc WHERE nc.network_id = $1 AND nc.commission_id = c.id)
          ORDER BY ch.name, c.name`,
        [a.network.id, u.isSuperAdmin, u.adminChambers],
      )
    : [];
  res.json({
    ...a.network,
    commissions,
    links,
    coordinators,
    joinable,
    permissions: {
      manage: u.isSuperAdmin,
      national: a.isNational,
      dashboard: a.canDashboard,
      actFor: a.actFor,
      removable: commissions.filter((c: any) => u.isSuperAdmin || u.adminChambers.includes(c.chamber_id)).map((c: any) => c.id),
    },
  });
});

networksRouter.post('/networks/:id/commissions', async (req, res) => {
  const u = currentUser(req);
  const id = param(req, 'id');
  const b = body(req, z.object({ commissionId: uuid }));
  await tx(async (c) => {
    const n = await one('SELECT status FROM networks WHERE id = $1', [id], c);
    if (!n) throw notFound('شبکه یافت نشد');
    if (n.status !== 'active') throw conflict('این شبکه بایگانی شده است');
    const k = await one('SELECT chamber_id FROM commissions WHERE id = $1', [b.commissionId], c);
    if (!k) throw notFound('کمیسیون یافت نشد');
    if (!isChamberAdmin(u, k.chamber_id)) throw forbidden();
    await c.query('INSERT INTO network_commissions (network_id, commission_id, added_by) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [id, b.commissionId, u.id]);
    await audit(c, req, { chamberId: k.chamber_id, action: 'network.commission_added', entity: 'network', entityId: id, after: { commissionId: b.commissionId } });
  });
  res.status(201).json({ ok: true });
});

networksRouter.delete('/networks/:id/commissions/:commissionId', async (req, res) => {
  const u = currentUser(req);
  const id = param(req, 'id');
  const commissionId = param(req, 'commissionId');
  await tx(async (c) => {
    const k = await one('SELECT chamber_id FROM commissions WHERE id = $1', [commissionId], c);
    if (!k) throw notFound('کمیسیون یافت نشد');
    if (!isChamberAdmin(u, k.chamber_id)) throw forbidden();
    await c.query('DELETE FROM network_commissions WHERE network_id = $1 AND commission_id = $2', [id, commissionId]);
    await audit(c, req, { chamberId: k.chamber_id, action: 'network.commission_removed', entity: 'network', entityId: id, before: { commissionId } });
  });
  res.status(204).end();
});

networksRouter.post('/networks/:id/coordinators', async (req, res) => {
  const u = currentUser(req);
  requireSuperAdmin(u);
  const id = param(req, 'id');
  const b = body(req, z.object({ userId: uuid }));
  await tx(async (c) => {
    if (!(await one('SELECT 1 FROM networks WHERE id = $1', [id], c))) throw notFound('شبکه یافت نشد');
    if (!(await one('SELECT 1 FROM users WHERE id = $1', [b.userId], c))) throw notFound('شخص یافت نشد');
    await c.query('INSERT INTO network_coordinators (network_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [id, b.userId]);
    await audit(c, req, { chamberId: null, action: 'network.coordinator_added', entity: 'network', entityId: id, after: { userId: b.userId } });
  });
  res.status(201).json({ ok: true });
});

networksRouter.delete('/networks/:id/coordinators/:userId', async (req, res) => {
  const u = currentUser(req);
  requireSuperAdmin(u);
  const id = param(req, 'id');
  const userId = param(req, 'userId');
  await tx(async (c) => {
    await c.query('DELETE FROM network_coordinators WHERE network_id = $1 AND user_id = $2', [id, userId]);
    await audit(c, req, { chamberId: null, action: 'network.coordinator_removed', entity: 'network', entityId: id, before: { userId } });
  });
  res.status(204).end();
});

// ─────────────────────────────── Shared resolutions & endorsements ───────────────────────────────

/** Shared resolutions of the network's commissions, with endorsements and national-proposal state. */
networksRouter.get('/networks/:id/resolutions', async (req, res) => {
  const u = currentUser(req);
  const a = await networkAccess(u, param(req, 'id'));
  const q = typeof req.query.q === 'string' && req.query.q.trim() ? req.query.q.trim() : null;
  const proposalsOnly = req.query.proposals === 'true';
  const rows = await query(
    `SELECT r.id, r.number, r.text, r.status, r.progress, r.due_date, r.addressee, r.shared_at, r.share_note,
            c.id AS commission_id, c.name AS commission_name, ch.id AS chamber_id, ch.name AS chamber_name, ch.province,
            su.full_name AS shared_by_name,
            COALESCE((SELECT json_agg(json_build_object(
                 'commission_id', e.commission_id, 'commission_name', ec.name, 'chamber_name', ech.name, 'province', ech.province,
                 'comment', e.comment, 'user_name', eu.full_name, 'created_at', e.created_at) ORDER BY e.created_at)
               FROM resolution_endorsements e JOIN commissions ec ON ec.id = e.commission_id JOIN chambers ech ON ech.id = e.chamber_id
               LEFT JOIN users eu ON eu.id = e.user_id
              WHERE e.resolution_id = r.id AND e.commission_id IN (SELECT commission_id FROM network_commissions WHERE network_id = $1)), '[]') AS endorsements,
            (SELECT count(DISTINCT x.chamber_id) FROM (
               SELECT r.chamber_id UNION ALL
               SELECT e.chamber_id FROM resolution_endorsements e
                WHERE e.resolution_id = r.id AND e.commission_id IN (SELECT commission_id FROM network_commissions WHERE network_id = $1)) x) AS chamber_support,
            (SELECT json_build_object('status', p.status, 'response', p.response, 'reached_at', p.reached_at, 'updated_at', p.updated_at)
               FROM network_proposals p WHERE p.network_id = $1 AND p.resolution_id = r.id) AS proposal
       FROM resolutions r JOIN network_commissions nc ON nc.commission_id = r.commission_id AND nc.network_id = $1
       JOIN commissions c ON c.id = r.commission_id JOIN chambers ch ON ch.id = r.chamber_id LEFT JOIN users su ON su.id = r.shared_by
      WHERE r.shared_at IS NOT NULL
        AND ($2::text IS NULL OR r.text ILIKE '%' || $2 || '%' OR r.number ILIKE '%' || $2 || '%' OR c.name ILIKE '%' || $2 || '%')
        AND (NOT $3::boolean OR EXISTS (SELECT 1 FROM network_proposals p WHERE p.network_id = $1 AND p.resolution_id = r.id))
      ORDER BY ${proposalsOnly ? 'chamber_support DESC, r.shared_at DESC' : 'r.shared_at DESC'} LIMIT 200`,
    [a.network.id, q, proposalsOnly],
  );
  res.json({ threshold: a.network.endorse_threshold, items: rows });
});

/** Networks a resolution's commission belongs to, with its sharing state (shown on the resolution page). */
networksRouter.get('/resolutions/:id/networks', async (req, res) => {
  const u = currentUser(req);
  const r = await one('SELECT id, commission_id, chamber_id, shared_at, share_note FROM resolutions WHERE id = $1', [param(req, 'id')]);
  if (!r) throw notFound('مصوبه یافت نشد');
  const ca = await commissionAccess(u, r.commission_id).catch(() => null);
  if (!ca) throw notFound('مصوبه یافت نشد');
  const networks = await query(
    `SELECT n.id, n.name, n.endorse_threshold,
       (SELECT count(*) FROM resolution_endorsements e WHERE e.resolution_id = $2
          AND e.commission_id IN (SELECT commission_id FROM network_commissions WHERE network_id = n.id)) AS endorsement_count,
       (SELECT p.status FROM network_proposals p WHERE p.network_id = n.id AND p.resolution_id = $2) AS proposal_status
     FROM networks n JOIN network_commissions nc ON nc.network_id = n.id WHERE nc.commission_id = $1 AND n.status = 'active' ORDER BY n.name`,
    [r.commission_id, r.id],
  );
  res.json({
    sharedAt: r.shared_at,
    shareNote: r.share_note,
    canShare: ca.can('resolution.manage') || isChamberAdmin(u, r.chamber_id),
    networks,
  });
});

networksRouter.post('/resolutions/:id/share', async (req, res) => {
  const u = currentUser(req);
  const id = param(req, 'id');
  const b = body(req, z.object({ note: z.string().max(1000).nullish() }));
  const result = await tx(async (c) => {
    const r = await one('SELECT * FROM resolutions WHERE id = $1 FOR UPDATE', [id], c);
    if (!r) throw notFound('مصوبه یافت نشد');
    const ca = await commissionAccess(u, r.commission_id, c);
    if (!ca.can('resolution.manage') && !isChamberAdmin(u, r.chamber_id)) throw forbidden();
    if (r.status === 'cancelled') throw conflict('مصوبه لغوشده قابل انتشار نیست');
    const networks = await query<{ network_id: string }>(
      `SELECT nc.network_id FROM network_commissions nc JOIN networks n ON n.id = nc.network_id WHERE nc.commission_id = $1 AND n.status = 'active'`,
      [r.commission_id],
      c,
    );
    if (!networks.length) throw conflict('این کمیسیون عضو هیچ شبکه‌ای نیست', 'not_in_network');
    const first = !r.shared_at;
    const after = await one(
      `UPDATE resolutions SET shared_at = COALESCE(shared_at, now()), shared_by = COALESCE(shared_by, $2), share_note = $3, updated_at = now()
        WHERE id = $1 RETURNING id, shared_at, share_note`,
      [id, u.id, b.note ?? null],
      c,
    );
    await audit(c, req, { chamberId: r.chamber_id, action: 'resolution.shared', entity: 'resolution', entityId: id, after: { note: b.note ?? null } });
    return { r, after, first, networks: networks.map((n) => n.network_id), commissionName: ca.commission.name };
  });
  if (result.first) await announceShared(id, result);
  res.json(result.after);
});

/**
 * Officers of the other commissions in the same networks hear about a newly shared resolution; those whose
 * own resolutions are similar get a targeted «مشابه مسئله شما» notification instead of the generic one.
 */
async function announceShared(id: string, result: { r: any; networks: string[]; commissionName: string }) {
  const others = await query<{ commission_id: string }>(
    `SELECT DISTINCT commission_id FROM network_commissions WHERE network_id = ANY($1) AND commission_id <> $2`,
    [result.networks, result.r.commission_id],
  );
  const otherIds = others.map((o) => o.commission_id);
  const own = otherIds.length
    ? await query<{ id: string; commission_id: string; number: string }>(
        `SELECT id, commission_id, number FROM (
           SELECT id, commission_id, number, row_number() OVER (PARTITION BY commission_id ORDER BY created_at DESC) AS n
             FROM resolutions WHERE commission_id = ANY($1) AND status <> 'cancelled') x WHERE n <= 100`,
        [otherIds],
      )
    : [];
  const { pairs } = await similarPairs(own.map((o) => o.id), [id]).catch(() => ({ pairs: [] as { source: string }[] }));
  const similar = new Map<string, string>(); // commission → its most similar resolution number
  for (const p of pairs) {
    const o = own.find((x) => x.id === p.source)!;
    if (!similar.has(o.commission_id)) similar.set(o.commission_id, o.number);
  }
  for (const [commissionId, number] of similar) {
    await notify({
      chamberId: result.r.chamber_id,
      userIds: await officersOf([commissionId]),
      event: 'network.similar_found',
      title: `مصوبه‌ای مشابه مسئله کمیسیون شما در شبکه منتشر شد`,
      body: `${result.commissionName}، مصوبه ${result.r.number} — مشابه مصوبه ${number} شما: ${String(result.r.text).slice(0, 120)}`,
      data: { networkId: result.networks[0], resolutionId: id },
    });
  }
  await notify({
    chamberId: result.r.chamber_id,
    userIds: await officersOf(otherIds.filter((c) => !similar.has(c))),
    event: 'network.resolution_shared',
    title: `مصوبه جدید در شبکه: ${result.commissionName}`,
    body: `${result.r.number}: ${String(result.r.text).slice(0, 140)}`,
    data: { networkId: result.networks[0], resolutionId: id },
  });
}

networksRouter.delete('/resolutions/:id/share', async (req, res) => {
  const u = currentUser(req);
  const id = param(req, 'id');
  await tx(async (c) => {
    const r = await one('SELECT * FROM resolutions WHERE id = $1 FOR UPDATE', [id], c);
    if (!r) throw notFound('مصوبه یافت نشد');
    const ca = await commissionAccess(u, r.commission_id, c);
    if (!ca.can('resolution.manage') && !isChamberAdmin(u, r.chamber_id)) throw forbidden();
    if (await one('SELECT 1 FROM network_proposals WHERE resolution_id = $1', [id], c)) {
      throw conflict('این مصوبه به پیشنهاد ملی تبدیل شده و انتشار آن قابل لغو نیست', 'is_proposal');
    }
    await c.query('UPDATE resolutions SET shared_at = NULL, shared_by = NULL, share_note = NULL, updated_at = now() WHERE id = $1', [id]);
    await c.query('DELETE FROM resolution_endorsements WHERE resolution_id = $1', [id]);
    await audit(c, req, { chamberId: r.chamber_id, action: 'resolution.unshared', entity: 'resolution', entityId: id });
  });
  res.status(204).end();
});

/** Chambers supporting a resolution within a network (the originating chamber included). */
async function chamberSupport(networkId: string, r: { id: string; chamber_id: string }, db: Db): Promise<number> {
  const row = await one<{ n: number }>(
    `SELECT count(DISTINCT x.chamber_id)::int AS n FROM (
       SELECT $3::uuid AS chamber_id UNION ALL
       SELECT e.chamber_id FROM resolution_endorsements e
        WHERE e.resolution_id = $2 AND e.commission_id IN (SELECT commission_id FROM network_commissions WHERE network_id = $1)) x`,
    [networkId, r.id, r.chamber_id],
    db,
  );
  return row!.n;
}

networksRouter.post('/networks/:id/resolutions/:rid/endorsements', async (req, res) => {
  const u = currentUser(req);
  const networkId = param(req, 'id');
  const rid = param(req, 'rid');
  const b = body(req, z.object({ commissionId: uuid, comment: z.string().max(2000).nullish() }));
  const a = await networkAccess(u, networkId);
  if (a.network.status !== 'active') throw conflict('این شبکه بایگانی شده است');
  if (!a.actFor.includes(b.commissionId)) throw forbidden('فقط رئیس، دبیر یا مدیر اتاقِ یک کمیسیون عضو شبکه می‌تواند حمایت ثبت کند');
  const out = await tx(async (c) => {
    const r = await one(
      `SELECT r.* FROM resolutions r JOIN network_commissions nc ON nc.commission_id = r.commission_id AND nc.network_id = $2
        WHERE r.id = $1 AND r.shared_at IS NOT NULL FOR UPDATE OF r`,
      [rid, networkId],
      c,
    );
    if (!r) throw notFound('مصوبه در این شبکه منتشر نشده است');
    if (r.commission_id === b.commissionId) throw badRequest('کمیسیون نمی‌تواند از مصوبه خودش حمایت کند');
    const k = await one('SELECT chamber_id, name FROM commissions WHERE id = $1', [b.commissionId], c);
    await c.query(
      `INSERT INTO resolution_endorsements (resolution_id, commission_id, chamber_id, user_id, comment) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (resolution_id, commission_id) DO UPDATE SET comment = EXCLUDED.comment, user_id = EXCLUDED.user_id, created_at = now()`,
      [rid, b.commissionId, k!.chamber_id, u.id, b.comment ?? null],
    );
    await audit(c, req, { chamberId: k.chamber_id, action: 'resolution.endorsed', entity: 'resolution', entityId: rid, after: { networkId, commissionId: b.commissionId, comment: b.comment ?? null } });
    // Every network of the originating commission in which the support now reaches the threshold.
    const reached: string[] = [];
    const nets = await query<{ id: string; endorse_threshold: number }>(
      `SELECT n.id, n.endorse_threshold FROM networks n JOIN network_commissions nc ON nc.network_id = n.id
        WHERE nc.commission_id = $1 AND n.status = 'active'
          AND NOT EXISTS (SELECT 1 FROM network_proposals p WHERE p.network_id = n.id AND p.resolution_id = $2)`,
      [r.commission_id, rid],
      c,
    );
    for (const n of nets) {
      if ((await chamberSupport(n.id, r, c)) >= n.endorse_threshold) {
        await c.query('INSERT INTO network_proposals (network_id, resolution_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [n.id, rid]);
        await audit(c, req, { chamberId: null, action: 'network.proposal_reached', entity: 'resolution', entityId: rid, after: { networkId: n.id } });
        reached.push(n.id);
      }
    }
    return { r, endorser: k.name, reached };
  });
  await notify({
    chamberId: out.r.chamber_id,
    userIds: await officersOf([out.r.commission_id]),
    event: 'network.endorsed',
    title: `حمایت از مصوبه ${out.r.number}`,
    body: `${out.endorser} از مصوبه ${out.r.number} حمایت کرد${b.comment ? `: ${b.comment.slice(0, 120)}` : ''}`,
    data: { networkId, resolutionId: rid },
  });
  for (const n of out.reached) {
    await notify({
      chamberId: out.r.chamber_id,
      userIds: [...(await nationalUsers(n)), ...(await officersOf([out.r.commission_id]))],
      event: 'network.proposal_national',
      title: `پیشنهاد ملی جدید: مصوبه ${out.r.number}`,
      body: `مصوبه ${out.r.number} با حمایت اتاق‌های چند استان به پیشنهاد ملی تبدیل شد: ${String(out.r.text).slice(0, 120)}`,
      data: { networkId: n, resolutionId: rid },
    });
  }
  res.status(201).json({ ok: true, nationalProposal: out.reached.includes(networkId) });
});

networksRouter.delete('/networks/:id/resolutions/:rid/endorsements/:commissionId', async (req, res) => {
  const u = currentUser(req);
  const networkId = param(req, 'id');
  const rid = param(req, 'rid');
  const commissionId = param(req, 'commissionId');
  const a = await networkAccess(u, networkId);
  if (!a.actFor.includes(commissionId)) throw forbidden();
  await tx(async (c) => {
    const del = await c.query('DELETE FROM resolution_endorsements WHERE resolution_id = $1 AND commission_id = $2 RETURNING chamber_id', [rid, commissionId]);
    if (!del.rowCount) throw notFound();
    // A national proposal already reached stays (its follow-up has started).
    await audit(c, req, { chamberId: del.rows[0].chamber_id, action: 'resolution.endorsement_withdrawn', entity: 'resolution', entityId: rid, before: { networkId, commissionId } });
  });
  res.status(204).end();
});

networksRouter.patch('/networks/:id/proposals/:rid', async (req, res) => {
  const u = currentUser(req);
  const networkId = param(req, 'id');
  const rid = param(req, 'rid');
  const a = await networkAccess(u, networkId);
  if (!a.isNational) throw forbidden();
  const b = body(req, z.object({ status: z.enum(NETWORK_PROPOSAL_STATUSES).optional(), response: z.string().max(4000).nullish() }));
  const out = await tx(async (c) => {
    const before = await one('SELECT * FROM network_proposals WHERE network_id = $1 AND resolution_id = $2 FOR UPDATE', [networkId, rid], c);
    if (!before) throw notFound('پیشنهاد ملی یافت نشد');
    const after = await one(
      `UPDATE network_proposals SET status = COALESCE($3, status), response = COALESCE($4, response), updated_by = $5, updated_at = now()
        WHERE network_id = $1 AND resolution_id = $2 RETURNING *`,
      [networkId, rid, b.status ?? null, b.response ?? null, u.id],
      c,
    );
    await audit(c, req, { chamberId: null, action: 'network.proposal_updated', entity: 'resolution', entityId: rid, before, after });
    const r = await one('SELECT number, commission_id, chamber_id FROM resolutions WHERE id = $1', [rid], c);
    const endorsers = await query<{ commission_id: string }>('SELECT commission_id FROM resolution_endorsements WHERE resolution_id = $1', [rid], c);
    return { after, r, commissions: [r.commission_id, ...endorsers.map((e) => e.commission_id)] };
  });
  await notify({
    chamberId: out.r.chamber_id,
    userIds: await officersOf(out.commissions),
    event: 'network.proposal_updated',
    title: `پیگیری پیشنهاد ملی ${out.r.number}`,
    body: b.response ? b.response.slice(0, 200) : 'وضعیت پیشنهاد ملی تغییر کرد',
    data: { networkId, resolutionId: rid },
  });
  res.json(out.after);
});

// ─────────────────────────────── Comparative dashboard ───────────────────────────────

/** Activity of the network's commissions side by side (default: last 12 months). */
networksRouter.get('/networks/:id/dashboard', async (req, res) => {
  const u = currentUser(req);
  const a = await networkAccess(u, param(req, 'id'));
  if (!a.canDashboard) throw forbidden();
  const to = req.query.to ? dateStr.parse(req.query.to) : new Date().toISOString().slice(0, 10);
  const from = req.query.from ? dateStr.parse(req.query.from) : new Date(Date.now() - 365 * 86400_000).toISOString().slice(0, 10);
  const rows = await query(
    `SELECT c.id, c.name, ch.name AS chamber_name, ch.province,
       (SELECT count(*) FROM meetings m WHERE m.commission_id = c.id AND m.status IN ${HELD}
          AND m.scheduled_at::date BETWEEN $2 AND $3)::int AS meetings_held,
       (SELECT round(100.0 * count(*) FILTER (WHERE at.status IN ('present','online','proxy','manual_present')) / NULLIF(count(*), 0))
          FROM attendance at JOIN meetings m ON m.id = at.meeting_id
         WHERE m.commission_id = c.id AND m.status IN ${HELD} AND m.scheduled_at::date BETWEEN $2 AND $3)::int AS attendance_rate,
       (SELECT count(*) FROM resolutions r WHERE r.commission_id = c.id AND r.created_at::date BETWEEN $2 AND $3)::int AS resolutions_total,
       (SELECT count(*) FROM resolutions r WHERE r.commission_id = c.id AND r.created_at::date BETWEEN $2 AND $3 AND r.status = 'done')::int AS resolutions_done,
       (SELECT count(*) FROM resolutions r WHERE r.commission_id = c.id AND r.due_date < current_date AND r.status NOT IN ('done','cancelled'))::int AS resolutions_overdue,
       (SELECT count(*) FROM resolutions r WHERE r.commission_id = c.id AND r.shared_at::date BETWEEN $2 AND $3)::int AS shared,
       (SELECT count(*) FROM resolution_endorsements e WHERE e.commission_id = c.id AND e.created_at::date BETWEEN $2 AND $3)::int AS endorsements_given,
       (SELECT count(*) FROM resolution_endorsements e JOIN resolutions r ON r.id = e.resolution_id
         WHERE r.commission_id = c.id AND e.created_at::date BETWEEN $2 AND $3)::int AS endorsements_received
     FROM network_commissions nc JOIN commissions c ON c.id = nc.commission_id JOIN chambers ch ON ch.id = c.chamber_id
     WHERE nc.network_id = $1 ORDER BY ch.province, c.name`,
    [a.network.id, from, to],
  );
  const proposals = await one(
    `SELECT count(*)::int AS total, count(*) FILTER (WHERE status = 'new')::int AS new,
            count(*) FILTER (WHERE status = 'reviewing')::int AS reviewing, count(*) FILTER (WHERE status = 'forwarded')::int AS forwarded,
            count(*) FILTER (WHERE status = 'closed')::int AS closed
       FROM network_proposals WHERE network_id = $1`,
    [a.network.id],
  );
  res.json({ from, to, commissions: rows, proposals });
});

// ─────────────────────────────── Similar resolutions (موتور هوشمند) ───────────────────────────────

/** Details of shared resolutions for similarity results. */
async function resolutionCards(ids: string[], forCommission: string | null) {
  if (!ids.length) return [];
  return query(
    `SELECT r.id, r.number, r.text, r.status, r.progress, r.shared_at, c.id AS commission_id, c.name AS commission_name,
            ch.name AS chamber_name, ch.province,
            ($2::uuid IS NOT NULL AND EXISTS (SELECT 1 FROM resolution_endorsements e WHERE e.resolution_id = r.id AND e.commission_id = $2)) AS endorsed,
            EXISTS (SELECT 1 FROM network_proposals p WHERE p.resolution_id = r.id) AS is_proposal
       FROM resolutions r JOIN commissions c ON c.id = r.commission_id JOIN chambers ch ON ch.id = r.chamber_id
      WHERE r.id = ANY($1)`,
    [ids, forCommission],
  );
}

/** Shared resolutions of other commissions in the networks of `commissionId`, with one network each. */
async function networkCandidates(commissionId: string, networkId?: string) {
  return query<{ id: string; network_id: string }>(
    `SELECT DISTINCT ON (x.id) x.id, nc2.network_id
       FROM resolutions x
       JOIN network_commissions nc2 ON nc2.commission_id = x.commission_id
       JOIN network_commissions nc1 ON nc1.network_id = nc2.network_id AND nc1.commission_id = $1
       JOIN networks n ON n.id = nc2.network_id AND n.status = 'active'
      WHERE x.shared_at IS NOT NULL AND x.commission_id <> $1 AND x.status <> 'cancelled'
        AND ($2::uuid IS NULL OR nc2.network_id = $2)
      ORDER BY x.id, nc2.network_id`,
    [commissionId, networkId ?? null],
  );
}

/** Resolutions shared in other provinces that resemble this one (shown on the resolution page). */
networksRouter.get('/resolutions/:id/similar', async (req, res) => {
  const u = currentUser(req);
  const r = await one('SELECT id, commission_id FROM resolutions WHERE id = $1', [param(req, 'id')]);
  if (!r) throw notFound('مصوبه یافت نشد');
  if (!(await commissionAccess(u, r.commission_id).catch(() => null))) throw notFound('مصوبه یافت نشد');
  const cands = await networkCandidates(r.commission_id);
  const { engine, pairs } = await similarPairs([r.id], cands.map((c) => c.id));
  const top = pairs.slice(0, 5);
  const cards = await resolutionCards(top.map((p) => p.candidate), r.commission_id);
  res.json({
    ...engineInfo(),
    engine,
    items: top.map((p) => ({
      ...cards.find((c: any) => c.id === p.candidate),
      score: Math.round(p.score * 100) / 100,
      network_id: cands.find((c) => c.id === p.candidate)!.network_id,
    })),
  });
});

/** «پیشنهاد هوشمند»: shared resolutions of the network resembling the own resolutions of the commissions the user acts for. */
networksRouter.get('/networks/:id/suggestions', async (req, res) => {
  const u = currentUser(req);
  const a = await networkAccess(u, param(req, 'id'));
  let engine = engineInfo().engine;
  const items: any[] = [];
  for (const commissionId of a.actFor) {
    const cands = await query<{ id: string }>(
      `SELECT x.id FROM resolutions x JOIN network_commissions nc ON nc.commission_id = x.commission_id AND nc.network_id = $1
        WHERE x.shared_at IS NOT NULL AND x.commission_id <> $2 AND x.status <> 'cancelled'
          AND NOT EXISTS (SELECT 1 FROM resolution_endorsements e WHERE e.resolution_id = x.id AND e.commission_id = $2)
          AND NOT EXISTS (SELECT 1 FROM network_suggestion_dismissals d WHERE d.resolution_id = x.id AND d.commission_id = $2)`,
      [a.network.id, commissionId],
    );
    if (!cands.length) continue;
    const own = await query<{ id: string; number: string; text: string }>(
      `SELECT id, number, text FROM resolutions WHERE commission_id = $1 AND status <> 'cancelled' ORDER BY created_at DESC LIMIT 100`,
      [commissionId],
    );
    const result = await similarPairs(own.map((o) => o.id), cands.map((c) => c.id));
    engine = result.engine;
    const best = new Map<string, { source: string; score: number }>();
    for (const p of result.pairs) if (!best.has(p.candidate)) best.set(p.candidate, p);
    const cards = await resolutionCards([...best.keys()], commissionId);
    const k = await one('SELECT name FROM commissions WHERE id = $1', [commissionId]);
    for (const [candidate, p] of best) {
      const mine = own.find((o) => o.id === p.source)!;
      items.push({
        resolution: cards.find((c: any) => c.id === candidate),
        commission_id: commissionId,
        commission_name: k.name,
        matched: { id: mine.id, number: mine.number, text: mine.text },
        score: Math.round(p.score * 100) / 100,
      });
    }
  }
  items.sort((x, y) => y.score - x.score);
  res.json({ ...engineInfo(), engine, items: items.slice(0, 10) });
});

networksRouter.post('/networks/:id/suggestions/dismiss', async (req, res) => {
  const u = currentUser(req);
  const a = await networkAccess(u, param(req, 'id'));
  const b = body(req, z.object({ resolutionId: uuid, commissionId: uuid }));
  if (!a.actFor.includes(b.commissionId)) throw forbidden();
  await query(
    `INSERT INTO network_suggestion_dismissals (resolution_id, commission_id, user_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
    [b.resolutionId, b.commissionId, u.id],
  );
  res.status(204).end();
});

// ─────────────────────────────── National proposal letter ───────────────────────────────

const letterSchema = z.object({ addressee: z.string().max(300).default(''), subject: z.string().min(3).max(500), body: z.string().min(10).max(20000) });

/** The saved letter (or, until saved, the draft built from the network's data) plus a fresh draft. */
networksRouter.get('/networks/:id/proposals/:rid/letter', async (req, res) => {
  const u = currentUser(req);
  const a = await networkAccess(u, param(req, 'id'));
  if (!a.isNational) throw forbidden();
  const rid = param(req, 'rid');
  const d = await loadLetterData(a.network.id, rid);
  const draft = draftLetter(d);
  const saved = await one(
    `SELECT p.letter_addressee, p.letter_subject, p.letter_body, p.letter_updated_at, u.full_name AS updated_by
       FROM network_proposals p LEFT JOIN users u ON u.id = p.letter_updated_by WHERE p.network_id = $1 AND p.resolution_id = $2`,
    [a.network.id, rid],
  );
  res.json({
    engine: 'template',
    saved: !!saved?.letter_body,
    updatedAt: saved?.letter_updated_at ?? null,
    updatedBy: saved?.updated_by ?? null,
    letter: saved?.letter_body ? { addressee: saved.letter_addressee ?? '', subject: saved.letter_subject, body: saved.letter_body } : draft,
    draft,
  });
});

networksRouter.put('/networks/:id/proposals/:rid/letter', async (req, res) => {
  const u = currentUser(req);
  const a = await networkAccess(u, param(req, 'id'));
  if (!a.isNational) throw forbidden();
  const rid = param(req, 'rid');
  const b = body(req, letterSchema);
  const row = await tx(async (c) => {
    const r = await one(
      `UPDATE network_proposals SET letter_addressee = $3, letter_subject = $4, letter_body = $5, letter_updated_by = $6, letter_updated_at = now()
        WHERE network_id = $1 AND resolution_id = $2 RETURNING letter_updated_at`,
      [a.network.id, rid, b.addressee, b.subject, b.body, u.id],
      c,
    );
    if (!r) throw notFound('پیشنهاد ملی یافت نشد');
    await audit(c, req, { chamberId: null, action: 'network.letter_saved', entity: 'resolution', entityId: rid, after: { networkId: a.network.id, subject: b.subject } });
    return r;
  });
  res.json({ ok: true, updatedAt: row.letter_updated_at });
});

networksRouter.get('/networks/:id/proposals/:rid/letter.docx', async (req, res) => {
  const u = currentUser(req);
  const a = await networkAccess(u, param(req, 'id'));
  if (!a.isNational) throw forbidden();
  const rid = param(req, 'rid');
  const d = await loadLetterData(a.network.id, rid);
  const saved = await one('SELECT letter_addressee, letter_subject, letter_body FROM network_proposals WHERE network_id = $1 AND resolution_id = $2', [a.network.id, rid]);
  const letter = saved?.letter_body ? { addressee: saved.letter_addressee ?? '', subject: saved.letter_subject, body: saved.letter_body } : draftLetter(d);
  const me = await one('SELECT full_name FROM users WHERE id = $1', [u.id]);
  const buf = await buildLetterDocx(letter, d, a.isCoordinator ? me?.full_name : (d.coordinators[0] ?? me?.full_name));
  await audit(pool, req, { chamberId: null, action: 'network.letter_exported', entity: 'resolution', entityId: rid, after: { networkId: a.network.id } });
  const fileName = `نامه پیشنهاد ملی ${d.resolution.number}.docx`;
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  res.setHeader('Content-Disposition', `attachment; filename="proposal-${d.resolution.number}.docx"; filename*=UTF-8''${encodeURIComponent(fileName)}`);
  res.send(buf);
});
