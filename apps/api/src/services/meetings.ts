import {
  calculateQuorum,
  isAttending,
  nextStatus,
  SOCKET_EVENTS,
  type AttendanceStatus,
  type CommissionSettings,
  type MeetingAction,
  type MeetingStatus,
  type QuorumResult,
} from '@kx/shared';
import type { Request } from 'express';
import { pool, query, type Db } from '../db/pool.js';
import { audit } from '../lib/audit.js';
import { conflict } from '../lib/errors.js';
import { emitToMeeting, emitToOfficers } from '../realtime.js';
import type { MeetingRow } from './access.js';

export interface AttendanceRow {
  user_id: string;
  full_name: string;
  organization: string | null;
  role: string;
  has_vote: boolean;
  status: AttendanceStatus;
  method: string | null;
  checked_in_at: Date | null;
  proxy_name: string | null;
  note: string | null;
  updated_at: Date | null;
}

export async function loadAttendance(meetingId: string, db: Db = pool): Promise<AttendanceRow[]> {
  return query<AttendanceRow>(
    `SELECT i.user_id, u.full_name, u.organization, i.role, i.has_vote,
            COALESCE(a.status, 'pending') AS status, a.method, a.checked_in_at, a.proxy_name, a.note, a.updated_at
       FROM meeting_invitees i
       JOIN users u ON u.id = i.user_id
       LEFT JOIN attendance a ON a.meeting_id = i.meeting_id AND a.user_id = i.user_id
      WHERE i.meeting_id = $1
      ORDER BY array_position(ARRAY['chair','vice_chair','secretary','member','expert','observer','guest'], i.role), u.full_name`,
    [meetingId],
    db,
  );
}

export function quorumOf(rows: AttendanceRow[], settings: CommissionSettings): QuorumResult {
  return calculateQuorum(
    rows.map((r) => ({ userId: r.user_id, hasVote: r.has_vote, status: r.status })),
    settings.quorum,
  );
}

export async function computeQuorum(meetingId: string, settings: CommissionSettings, db: Db = pool) {
  return quorumOf(await loadAttendance(meetingId, db), settings);
}

export function quorumSummary(q: QuorumResult) {
  return { eligible: q.eligible, present: q.present, required: q.required, reached: q.reached, attendingTotal: q.attendingTotal };
}

/** Pushes the live attendance list to officers and the quorum summary to everyone in the meeting room. */
export async function broadcastAttendance(meetingId: string, settings: CommissionSettings) {
  const rows = await loadAttendance(meetingId);
  const q = quorumOf(rows, settings);
  emitToOfficers(meetingId, SOCKET_EVENTS.attendanceUpdated, { meetingId, attendance: rows, quorum: q });
  emitToMeeting(meetingId, SOCKET_EVENTS.quorumUpdated, { meetingId, quorum: quorumSummary(q) });
  return q;
}

/** Applies a state-machine transition, persisting and auditing it. Throws 409 when not allowed. */
export async function transition(
  db: Db,
  req: Request,
  meeting: MeetingRow,
  action: MeetingAction,
  extra: { set?: string; params?: unknown[]; reason?: string } = {},
): Promise<MeetingStatus> {
  let to: MeetingStatus;
  try {
    to = nextStatus(meeting.status, action);
  } catch {
    throw conflict(`این عملیات در وضعیت فعلی جلسه مجاز نیست (${meeting.status} → ${action})`, 'invalid_transition');
  }
  const params = [meeting.id, to, ...(extra.params ?? [])];
  await db.query(`UPDATE meetings SET status = $2, updated_at = now()${extra.set ? `, ${extra.set}` : ''} WHERE id = $1`, params);
  await audit(db, req, {
    chamberId: meeting.chamber_id,
    action: `meeting.${action}`,
    entity: 'meeting',
    entityId: meeting.id,
    before: { status: meeting.status },
    after: { status: to },
    reason: extra.reason,
  });
  meeting.status = to;
  return to;
}

export function broadcastMeeting(meetingId: string, patch: Record<string, unknown>) {
  emitToMeeting(meetingId, SOCKET_EVENTS.meetingUpdated, { meetingId, ...patch });
}

/** Ensures every invitee has an attendance row (status pending). */
export async function ensureAttendanceRows(meetingId: string, db: Db) {
  await db.query(
    `INSERT INTO attendance (meeting_id, user_id, status)
     SELECT meeting_id, user_id, 'pending' FROM meeting_invitees WHERE meeting_id = $1
     ON CONFLICT DO NOTHING`,
    [meetingId],
  );
}

export async function inviteeIds(meetingId: string, db: Db = pool, filter: 'all' | 'voters' | 'officers' = 'all'): Promise<string[]> {
  const cond = filter === 'voters' ? 'AND has_vote' : filter === 'officers' ? `AND role IN ('chair','vice_chair','secretary')` : '';
  const rows = await query<{ user_id: string }>(`SELECT user_id FROM meeting_invitees WHERE meeting_id = $1 ${cond}`, [meetingId], db);
  return rows.map((r) => r.user_id);
}

export { isAttending };
