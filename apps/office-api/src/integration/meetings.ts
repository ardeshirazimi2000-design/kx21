/**
 * Integration with the commission meetings system (سامانه جلسات کمیسیون‌ها), see docs/office/04-integration.md.
 *  - Sync (REST): commissions, meetings, resolutions, referral of a letter, attachments.
 *  - Async (events): signed webhooks from the meetings outbox, or polling /events when inbound calls are not possible.
 * Inbound events land in integration_inbox (deduplicated) and are processed by the job queue.
 */
import crypto from 'node:crypto';
import { formatJalaliDate, formatJalaliLong, formatTime } from '@kx/shared';
import { one, pool, query, tx, type Db } from '../db/pool.js';
import { audit } from '../lib/audit.js';
import { decryptText } from '../lib/crypto.js';
import { badRequest, HttpError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { getFile } from '../lib/storage.js';
import { enqueue, registerHandler } from '../services/jobs.js';
import { newTrackingCode, nextLetterNumber, primaryUnitOf } from '../services/letters.js';
import { notify } from '../services/notifications.js';
import { cancelWorkflow, onWorkflowFinished, startWorkflow } from '../services/workflow.js';

export const SYSTEM = 'meetings';

export interface MeetingsSettings {
  /** Workflow started for every new resolution (default: resolution-followup). */
  resolutionWorkflowKey?: string;
  /** Unit owning resolution letters when the responsible person is not mapped. */
  defaultUnitId?: string;
  /** Send progress 100% to the meetings system when the resolution workflow completes. */
  autoFeedback?: boolean;
  /** 'apikey' (X-Api-Key) or 'oauth2' (client credentials). */
  auth?: 'apikey' | 'oauth2';
  /** Pull /events periodically (for installs that cannot receive webhooks). */
  poll?: boolean;
}

export async function loadIntegration(db: Db = pool) {
  const row = await one(`SELECT * FROM integrations WHERE kind = 'meetings'`, [], db);
  if (!row || !row.is_active || !row.base_url || !row.client_secret_enc) return null;
  return {
    ...row,
    apiKey: decryptText(row.client_secret_enc),
    webhookSecret: row.webhook_secret_enc ? decryptText(row.webhook_secret_enc) : null,
    settings: (row.settings ?? {}) as MeetingsSettings,
  };
}

type Integration = NonNullable<Awaited<ReturnType<typeof loadIntegration>>>;

let tokenCache: { token: string; exp: number; key: string } | null = null;

async function authHeaders(i: Integration): Promise<Record<string, string>> {
  if (i.settings.auth !== 'oauth2') return { 'x-api-key': i.apiKey };
  if (tokenCache && tokenCache.key === i.apiKey && tokenCache.exp > Date.now() + 30_000) return { authorization: `Bearer ${tokenCache.token}` };
  const r = await fetch(`${i.base_url}/api/integration/v1/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: i.client_id ?? '', client_secret: i.apiKey }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!r.ok) throw new HttpError(502, 'integration_auth', 'احراز هویت در سامانه جلسات ناموفق بود');
  const t = (await r.json()) as { access_token: string; expires_in: number };
  tokenCache = { token: t.access_token, exp: Date.now() + t.expires_in * 1000, key: i.apiKey };
  return { authorization: `Bearer ${t.access_token}` };
}

export async function meetingsRequest<T = any>(method: string, path: string, body?: unknown | FormData, opts: { raw?: boolean; integration?: Integration } = {}): Promise<T> {
  const i = opts.integration ?? (await loadIntegration());
  if (!i) throw new HttpError(503, 'integration_disabled', 'اتصال به سامانه جلسات تنظیم یا فعال نشده است');
  const headers: Record<string, string> = { ...(await authHeaders(i)) };
  let payload: FormData | string | undefined;
  if (body instanceof FormData) payload = body;
  else if (body !== undefined) {
    headers['content-type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  let r: Response;
  try {
    r = await fetch(`${i.base_url}/api/integration/v1${path}`, { method, headers, body: payload, signal: AbortSignal.timeout(15_000) });
  } catch (e) {
    throw new HttpError(502, 'integration_unreachable', `سامانه جلسات در دسترس نیست (${(e as Error).message})`);
  }
  if (opts.raw && r.ok) return r as T;
  const ct = r.headers.get('content-type') ?? '';
  const data = ct.includes('json') ? await r.json() : await r.text();
  if (!r.ok) {
    const msg = (data as any)?.error?.message ?? `HTTP ${r.status}`;
    throw new HttpError(r.status === 404 ? 404 : r.status === 409 ? 409 : 502, 'integration_error', `سامانه جلسات: ${msg}`, { status: r.status });
  }
  return data as T;
}

// ─────────────────────────────── Inbound events ───────────────────────────────

/** Verifies `x-kx-signature: t=<unix>,v1=<hex>` over `${t}.${rawBody}` (5-minute tolerance). */
export function verifyWebhookSignature(secret: string, header: string | undefined, rawBody: string, now = Date.now()) {
  const m = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(header ?? '');
  if (!m) return false;
  if (Math.abs(now / 1000 - Number(m[1])) > 300) return false;
  const expected = crypto.createHmac('sha256', secret).update(`${m[1]}.${rawBody}`).digest();
  const got = Buffer.from(m[2], 'hex');
  return got.length === expected.length && crypto.timingSafeEqual(got, expected);
}

export interface EventEnvelope {
  id: string;
  type: string;
  occurredAt: string;
  data: any;
}

/** Stores an event once (idempotent by event id) and queues its processing. Returns false for duplicates. */
export async function receiveEvent(e: EventEnvelope, db: Db = pool): Promise<boolean> {
  const r = await one(
    `INSERT INTO integration_inbox (system, event_id, event_type, payload) VALUES ($1,$2,$3,$4) ON CONFLICT (system, event_id) DO NOTHING RETURNING id`,
    [SYSTEM, String(e.id), e.type, JSON.stringify(e)],
    db,
  );
  if (r) await enqueue('meetings.event', { inboxId: r.id }, db);
  return !!r;
}

/** Pull mode: reads /events after the stored cursor. */
export async function pollEvents(): Promise<number> {
  const i = await loadIntegration();
  if (!i) return 0;
  let after = Number(i.state?.cursor ?? 0);
  let n = 0;
  for (let page = 0; page < 20; page++) {
    const r = await meetingsRequest<{ items: EventEnvelope[]; next: string }>('GET', `/events?after=${after}&limit=200`, undefined, { integration: i });
    for (const e of r.items) if (await receiveEvent(e)) n++;
    after = Number(r.next);
    await query(`UPDATE integrations SET state = state || jsonb_build_object('cursor', $1::text), last_sync_at = now(), last_error = NULL WHERE kind = 'meetings'`, [String(after)]);
    if (r.items.length < 200) break;
  }
  return n;
}

registerHandler('meetings.event', async ({ inboxId }: { inboxId: number }) => {
  const ev = await one('SELECT * FROM integration_inbox WHERE id = $1', [inboxId]);
  if (!ev || ev.status === 'processed' || ev.status === 'ignored') return;
  const data = ev.payload.data ?? {};
  try {
    let status: 'processed' | 'ignored' = 'processed';
    switch (ev.event_type) {
      case 'resolution.created':
        await syncResolution(data.id, { createLetter: true });
        break;
      case 'resolution.updated':
        await syncResolution(data.id, { createLetter: false });
        break;
      case 'meeting.updated':
        await syncMeeting(data.id);
        break;
      case 'referral.updated':
        await syncReferral(data.id);
        break;
      case 'meeting.invitation_letters_requested':
        await createInvitationLetters({ meetingId: data.meetingId, inviteeIds: data.inviteeIds ?? [], note: data.note, requestedBy: data.requestedBy });
        break;
      default:
        status = 'ignored';
    }
    await query(`UPDATE integration_inbox SET status = $2, processed_at = now(), error = NULL WHERE id = $1`, [inboxId, status]);
  } catch (e) {
    await query(`UPDATE integration_inbox SET status = 'failed', error = $2 WHERE id = $1`, [inboxId, String((e as Error).message).slice(0, 1000)]);
    throw e; // retried by the queue
  }
});

// ─────────────────────────────── Read model (cache) ───────────────────────────────

/** Maps a person of the meetings system to a local user (national id → e-mail → mobile). */
export async function mapExternalUser(db: Db, p: { id: string; national_id?: string | null; email?: string | null; mobile?: string | null }) {
  if (!p?.id) return null;
  const link = await one('SELECT user_id FROM user_external_links WHERE system = $1 AND external_id = $2', [SYSTEM, p.id], db);
  if (link) return link.user_id as string;
  const tries: [string, string | null | undefined, string][] = [
    ['national_id', p.national_id, 'national_id = $1'],
    ['email', p.email, 'lower(email) = lower($1)'],
    ['mobile', p.mobile, 'mobile = $1'],
  ];
  for (const [by, v, cond] of tries) {
    if (!v) continue;
    const u = await one(`SELECT id FROM users WHERE ${cond} AND is_active`, [v], db);
    if (u) {
      await query(`INSERT INTO user_external_links (user_id, system, external_id, matched_by) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`, [u.id, SYSTEM, p.id, by], db);
      return u.id as string;
    }
  }
  return null;
}

export async function syncMeeting(externalId: string) {
  const m = await meetingsRequest('GET', `/meetings/${externalId}`);
  await tx(async (db) => {
    const participants = [];
    for (const p of m.participants ?? []) participants.push({ ...p, local_user_id: await mapExternalUser(db, p) });
    const { participants: _p, ...rest } = m;
    await query(
      `INSERT INTO meetings_cache (external_id, commission_id, commission_name, number, title, scheduled_at, location, status, data, synced_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, now())
       ON CONFLICT (external_id) DO UPDATE SET commission_id = EXCLUDED.commission_id, commission_name = EXCLUDED.commission_name,
         number = EXCLUDED.number, title = EXCLUDED.title, scheduled_at = EXCLUDED.scheduled_at, location = EXCLUDED.location,
         status = EXCLUDED.status, data = EXCLUDED.data, synced_at = now()`,
      [m.id, m.commission_id, m.commission_name, m.number, m.title, m.scheduled_at, m.location, m.status, JSON.stringify({ ...rest, participants })],
      db,
    );
  });
  return m;
}

/** Recent meetings (manual "sync now"). */
export async function syncRecentMeetings(days = 60) {
  const from = new Date(Date.now() - days * 86400_000).toISOString();
  const r = await meetingsRequest<{ items: any[] }>('GET', `/meetings?from=${encodeURIComponent(from)}&pageSize=100`);
  for (const m of r.items) await syncMeeting(m.id);
  await query(`UPDATE integrations SET last_sync_at = now(), last_error = NULL WHERE kind = 'meetings'`);
  return r.items.length;
}

async function systemUser(db: Db): Promise<string> {
  const u =
    (await one(`SELECT id FROM users WHERE username = 'system'`, [], db)) ??
    (await one(`INSERT INTO users (username, full_name, is_active) VALUES ('system', 'سامانه (خودکار)', true) RETURNING id`, [], db));
  return u!.id;
}

/**
 * Upserts a resolution in the local cache. For a new resolution (scenario «ثبت مصوبه») it creates an
 * internal letter to the responsible person and starts the follow-up workflow.
 */
export async function syncResolution(externalId: string, opts: { createLetter: boolean }) {
  const i = await loadIntegration();
  if (!i) throw new Error('integration disabled');
  const r = await meetingsRequest('GET', `/resolutions/${externalId}`, undefined, { integration: i });
  if (r.meeting_id && !(await one('SELECT 1 FROM meetings_cache WHERE external_id = $1', [r.meeting_id]))) await syncMeeting(r.meeting_id);
  return tx(async (db) => {
    const ownerUserId = r.owner_id
      ? await mapExternalUser(db, { id: r.owner_id, national_id: r.owner_national_id, email: r.owner_email, mobile: r.owner_mobile })
      : null;
    const before = await one('SELECT * FROM resolutions_cache WHERE external_id = $1 FOR UPDATE', [r.id], db);
    const row = await one(
      `INSERT INTO resolutions_cache (external_id, meeting_external_id, commission_name, number, text, status, progress, due_date, owner_name, owner_user_id, data, synced_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, now())
       ON CONFLICT (external_id) DO UPDATE SET meeting_external_id = EXCLUDED.meeting_external_id, commission_name = EXCLUDED.commission_name,
         number = EXCLUDED.number, text = EXCLUDED.text, status = EXCLUDED.status, progress = EXCLUDED.progress, due_date = EXCLUDED.due_date,
         owner_name = EXCLUDED.owner_name, owner_user_id = COALESCE(EXCLUDED.owner_user_id, resolutions_cache.owner_user_id),
         data = EXCLUDED.data, synced_at = now()
       RETURNING *`,
      [r.id, r.meeting_id, r.commission_name, r.number, r.text, r.status, r.progress, r.due_date, r.owner_name, ownerUserId, JSON.stringify(r)],
      db,
    );
    if (opts.createLetter && !row.letter_id && !['done', 'cancelled'].includes(r.status)) {
      const letterId = await createResolutionLetter(db, i, r, ownerUserId);
      await query('UPDATE resolutions_cache SET letter_id = $2 WHERE external_id = $1', [r.id, letterId], db);
    }
    if (r.status === 'cancelled' && before?.status !== 'cancelled' && row.letter_id) {
      const inst = await one(`SELECT id FROM workflow_instances WHERE letter_id = $1 AND status = 'running'`, [row.letter_id], db);
      if (inst) await cancelWorkflow(db, null, inst.id, 'مصوبه در سامانه جلسات لغو شد');
    }
    return row;
  });
}

async function createResolutionLetter(db: Db, i: Integration, r: any, ownerUserId: string | null) {
  const creator = await systemUser(db);
  const unitId = (ownerUserId ? await primaryUnitOf(ownerUserId, db) : null) ?? i.settings.defaultUnitId ?? null;
  const num = await nextLetterNumber(db, 'internal');
  const due = r.due_date ? formatJalaliDate(`${r.due_date}T12:00:00`) : 'تعیین نشده';
  const body = [
    `مصوبه شماره ${r.number} کمیسیون ${r.commission_name}${r.meeting_number ? ` (جلسه ${r.meeting_number})` : ''}:`,
    '',
    r.text,
    '',
    `مسئول اجرا: ${r.owner_name ?? '—'}${r.addressee ? ` — مخاطب: ${r.addressee}` : ''}`,
    `مهلت اجرا: ${due}`,
  ].join('\n');
  const letter = await one(
    `INSERT INTO letters (kind, number, year, seq, tracking_code, subject, body, source, priority, status, owner_unit_id, due_date,
        registered_at, registered_by, created_by)
     VALUES ('internal',$1,$2,$3,$4,$5,$6,'meeting',$7,'registered',$8,$9, now(), $10, $10) RETURNING *`,
    [num.number, num.year, num.seq, await newTrackingCode(db), `ابلاغ مصوبه ${r.number} کمیسیون ${r.commission_name}`, body, r.priority ?? 'normal', unitId, r.due_date, creator],
    db,
  );
  if (ownerUserId) await query(`INSERT INTO letter_recipients (letter_id, user_id, kind) VALUES ($1,$2,'to')`, [letter.id, ownerUserId], db);
  await audit(db, null, { action: 'letter.created_from_resolution', entity: 'letter', entityId: letter.id, after: { resolution: r.id, number: letter.number }, userId: creator });
  const key = i.settings.resolutionWorkflowKey ?? 'resolution-followup';
  const def = await one('SELECT 1 FROM workflow_definitions WHERE key = $1 AND is_active', [key], db);
  if (def && (ownerUserId || unitId)) {
    await startWorkflow(db, null, { letterId: letter.id, definition: key, startedBy: creator, context: { resolutionId: r.id, ownerUserId } });
  }
  await notify(
    {
      userIds: [ownerUserId],
      event: 'resolution.assigned',
      vars: { resolution: r.number, commission: r.commission_name, due, text: r.text.slice(0, 300), number: letter.number, subject: letter.subject },
      data: { letterId: letter.id, resolutionId: r.id },
    },
    db,
  );
  return letter.id as string;
}

const MEETING_TYPE: Record<string, string> = { in_person: 'حضوری', online: 'برخط (آنلاین)', hybrid: 'ترکیبی (حضوری و برخط)' };

function invitationBody(m: any, p: any, note?: string | null) {
  const when = m.scheduled_at ? `روز ${formatJalaliLong(m.scheduled_at)} ساعت ${formatTime(m.scheduled_at)}` : 'در زمانی که متعاقباً اعلام می‌شود';
  const where = [m.location ? `در ${m.location}` : null, m.type && m.type !== 'in_person' ? `به‌صورت ${MEETING_TYPE[m.type] ?? m.type}` : null]
    .filter(Boolean)
    .join(' و ');
  const agenda = (m.agenda ?? []).map((a: any, idx: number) => `${idx + 1}. ${a.title}`);
  return [
    `${p.full_name} محترم`,
    p.organization ? p.organization : null,
    '',
    'با سلام و احترام،',
    `به استحضار می‌رساند جلسه${m.number ? ` شماره ${m.number}` : ''} کمیسیون ${m.commission_name} با موضوع «${m.title}» ${when}${where ? ` ${where}` : ''} برگزار می‌شود.`,
    agenda.length ? '\nدستور جلسه:' : null,
    ...agenda,
    m.online_link && m.type !== 'in_person' ? `\nنشانی حضور برخط: ${m.online_link}` : null,
    note ? `\n${note}` : null,
    '',
    'از جنابعالی دعوت می‌شود در این جلسه حضور یابید. خواهشمند است در صورت عدم امکان حضور، مراتب یا نماینده خود را به دبیرخانه کمیسیون اعلام فرمایید.',
  ]
    .filter((x) => x !== null)
    .join('\n');
}

/**
 * «نامه دعوت»: one outgoing draft per invitee of a meeting, for the secretariat to number, have
 * signed and send. An invitee who already has a live invitation letter for the meeting is skipped.
 */
export async function createInvitationLetters(input: { meetingId: string; inviteeIds: string[]; note?: string | null; requestedBy?: string | null }) {
  const i = await loadIntegration();
  if (!i) throw new Error('integration disabled');
  const m = await syncMeeting(input.meetingId);
  const result = await tx(async (db) => {
    const creator = await systemUser(db);
    const created: { id: string; invitee: string }[] = [];
    for (const inviteeId of new Set(input.inviteeIds)) {
      const p = (m.participants ?? []).find((x: any) => x.id === inviteeId);
      if (!p) continue;
      const live = await one(
        `SELECT 1 FROM meeting_invitation_letters mil JOIN letters l ON l.id = mil.letter_id
          WHERE mil.meeting_external_id = $1 AND mil.invitee_external_id = $2 AND l.status <> 'cancelled'`,
        [m.id, p.id],
        db,
      );
      if (live) continue;
      const letter = await one(
        `INSERT INTO letters (kind, tracking_code, subject, body, external_party, external_org, source, priority, status, owner_unit_id, created_by)
         VALUES ('outgoing',$1,$2,$3,$4,$5,'meeting','normal','draft',$6,$7) RETURNING id`,
        [
          await newTrackingCode(db),
          `دعوت به جلسه کمیسیون ${m.commission_name}${m.number ? ` (جلسه ${m.number})` : ''}`,
          invitationBody(m, p, input.note),
          p.full_name,
          p.organization ?? null,
          i.settings.defaultUnitId ?? null,
          creator,
        ],
        db,
      );
      await query(
        `INSERT INTO meeting_invitation_letters (meeting_external_id, invitee_external_id, invitee_name, letter_id, requested_by) VALUES ($1,$2,$3,$4,$5)`,
        [m.id, p.id, p.full_name, letter.id, input.requestedBy ?? null],
        db,
      );
      created.push({ id: letter.id, invitee: p.full_name });
    }
    if (created.length) {
      await audit(db, null, { action: 'letter.invitations_created', entity: 'meeting', entityId: m.id, after: { letters: created, requestedBy: input.requestedBy }, userId: creator });
      const secretariat = await query<{ user_id: string }>(`SELECT ur.user_id FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE r.key = 'secretariat'`, [], db);
      await notify(
        {
          userIds: secretariat.map((r) => r.user_id),
          event: 'meeting.invitation_letters',
          vars: { count: created.length, meeting: m.title, commission: m.commission_name, date: m.scheduled_at ? formatJalaliDate(m.scheduled_at) : '' },
          data: { letterId: created[0].id, meetingId: m.id },
        },
        db,
      );
    }
    return created;
  });
  return { created: result.length, letters: result };
}

async function syncReferral(issueId: string) {
  const ref = await one('SELECT * FROM letter_meeting_refs WHERE external_issue_id = $1', [issueId]);
  if (!ref) return;
  const v = await meetingsRequest('GET', `/referrals/${issueId}`);
  await query(`UPDATE letter_meeting_refs SET status = $2, data = $3, updated_at = now() WHERE id = $1`, [ref.id, v.status, JSON.stringify(v)]);
  if (v.status !== ref.status) {
    const letter = await one('SELECT id, number, subject, created_by FROM letters WHERE id = $1', [ref.letter_id]);
    const STATUS: Record<string, string> = { open: 'ثبت‌شده', under_review: 'در حال بررسی کارشناسی', on_agenda: 'در دستور جلسه', resolved: 'منجر به مصوبه', closed: 'مختومه' };
    await notify({
      userIds: [ref.created_by, letter.created_by],
      event: 'meeting.referral_updated',
      vars: { subject: letter.subject, number: letter.number, commission: ref.commission_name, status: STATUS[v.status] ?? v.status },
      data: { letterId: letter.id },
    });
  }
}

// ─────────────────────────────── Outbound ───────────────────────────────

/** «ارجاع مکاتبه به جلسه»: synchronous referral + attachment upload. */
export async function referLetterToMeeting(
  u: { id: string },
  letter: any,
  input: { commissionId: string; requestedMeetingId?: string | null; note?: string | null; includeAttachments: boolean },
) {
  if (!letter.number) throw badRequest('نامه باید پیش از ارجاع، ثبت و شماره شود');
  const v = await meetingsRequest('POST', '/referrals', {
    commissionId: input.commissionId,
    title: letter.subject,
    description: [input.note, letter.body].filter(Boolean).join('\n\n').slice(0, 20000) || null,
    externalRef: `letter:${letter.id}`,
    externalNumber: letter.number,
    externalDate: letter.registered_at ? new Date(letter.registered_at).toISOString().slice(0, 10) : null,
    requestedMeetingId: input.requestedMeetingId ?? null,
  });
  const uploaded: string[] = [];
  if (input.includeAttachments) {
    const atts = await query(
      `SELECT DISTINCT ON (group_id) * FROM letter_attachments WHERE letter_id = $1 ORDER BY group_id, version DESC`,
      [letter.id],
    );
    for (const a of atts) {
      if (a.external_ref) continue;
      const fd = new FormData();
      fd.append('issueId', v.id);
      fd.append('title', a.title ?? a.file_name);
      fd.append('file', new Blob([new Uint8Array(await getFile(a.storage_key))], { type: a.mime_type }), a.file_name);
      try {
        await meetingsRequest('POST', '/documents', fd);
        uploaded.push(a.file_name);
      } catch (e) {
        logger.warn({ err: (e as Error).message, file: a.file_name }, 'attachment upload to meetings failed');
      }
    }
  }
  const row = await one(
    `INSERT INTO letter_meeting_refs (letter_id, commission_id, commission_name, requested_meeting_id, external_issue_id, status, data, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (external_issue_id) DO UPDATE SET status = EXCLUDED.status, data = EXCLUDED.data, updated_at = now() RETURNING *`,
    [letter.id, v.commission_id, v.commission_name, input.requestedMeetingId ?? null, v.id, v.status, JSON.stringify({ ...v, uploaded }), u.id],
  );
  return row;
}

/** Queues execution feedback for a resolution (sent asynchronously with retries). */
export async function queueFeedback(
  db: Db,
  f: { resolutionId: string; letterId?: string | null; progress: number; note?: string | null; submit?: boolean; userId?: string | null },
) {
  const row = await one(
    `INSERT INTO resolution_feedback (resolution_external_id, letter_id, progress, note, submit, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [f.resolutionId, f.letterId ?? null, f.progress, f.note ?? null, !!f.submit, f.userId ?? null],
    db,
  );
  await enqueue('meetings.feedback', { feedbackId: row.id }, db);
  return row;
}

registerHandler('meetings.feedback', async ({ feedbackId }: { feedbackId: string }) => {
  const f = await one('SELECT f.*, l.number AS letter_number FROM resolution_feedback f LEFT JOIN letters l ON l.id = f.letter_id WHERE f.id = $1', [feedbackId]);
  if (!f || f.status === 'sent') return;
  try {
    const r = await meetingsRequest('POST', `/resolutions/${f.resolution_external_id}/feedback`, {
      progress: f.progress,
      note: f.note,
      submit: f.submit,
      externalRef: f.letter_number ?? f.id,
    });
    await query(`UPDATE resolution_feedback SET status = 'sent', sent_at = now(), error = NULL WHERE id = $1`, [f.id]);
    await query(`UPDATE resolutions_cache SET status = $2, progress = $3, synced_at = now() WHERE external_id = $1`, [f.resolution_external_id, r.status, r.progress]);
  } catch (e) {
    const permanent = e instanceof HttpError && (e.status === 404 || e.status === 409);
    await query(`UPDATE resolution_feedback SET status = $2, error = $3 WHERE id = $1`, [f.id, permanent ? 'failed' : 'pending', (e as Error).message.slice(0, 500)]);
    if (!permanent) throw e;
  }
});

// Scenario «پیگیری اجرای مصوبه»: completing the follow-up workflow reports the result back.
onWorkflowFinished(async (db, inst, letter, outcome) => {
  if (outcome !== 'completed') return;
  const res = await one('SELECT external_id FROM resolutions_cache WHERE letter_id = $1', [letter.id], db);
  if (!res) return;
  const i = await one(`SELECT settings FROM integrations WHERE kind = 'meetings'`, [], db);
  if (i?.settings?.autoFeedback === false) return;
  await queueFeedback(db, {
    resolutionId: res.external_id,
    letterId: letter.id,
    progress: 100,
    submit: true,
    note: `اقدامات اجرایی در اتوماسیون اداری انجام و تأیید شد (نامه ${letter.number}).`,
    userId: inst.started_by,
  });
});
