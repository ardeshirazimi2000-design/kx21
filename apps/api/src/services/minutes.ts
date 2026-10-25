import {
  AGENDA_STATUS_LABELS,
  ATTENDANCE_STATUS_LABELS,
  formatJalaliDateTime,
  formatJalaliLong,
  formatTime,
  isAttending,
  MEETING_TYPE_LABELS,
  mergeCommissionSettings,
  roleLabel,

  type MeetingType,
  toPersianDigits,
} from '@kx/shared';
import type { Request } from 'express';
import { one, query, type Db } from '../db/pool.js';
import { audit } from '../lib/audit.js';
import { loadAttendance, quorumOf } from './meetings.js';

const ATTENDANCE_HEADING = '## حاضرین و غایبین';
const AGENDA_HEADING = '## دستور جلسه و تصمیمات';

/** The «حاضرین و غایبین» section, from its heading to the quorum line. */
function attendanceLines(attendance: Awaited<ReturnType<typeof loadAttendance>>, q: ReturnType<typeof quorumOf>): string[] {
  const lines = [ATTENDANCE_HEADING];
  const attending = attendance.filter((a) => isAttending(a.status));
  const notAttending = attendance.filter((a) => !isAttending(a.status));
  lines.push('');
  lines.push('**حاضرین:**');
  for (const a of attending) {
    if (a.status === 'proxy' && a.proxy_name) {
      lines.push(`- ${a.proxy_name} به نمایندگی از ${a.full_name} (${roleLabel(a.role, a.role_title)})`);
      continue;
    }
    lines.push(`- ${a.full_name} (${roleLabel(a.role, a.role_title)})${a.status !== 'present' ? ` — ${ATTENDANCE_STATUS_LABELS[a.status]}` : ''}`);
  }
  if (notAttending.length) {
    lines.push('');
    lines.push('**غایبین:**');
    for (const a of notAttending) lines.push(`- ${a.full_name} (${roleLabel(a.role, a.role_title)}) — ${ATTENDANCE_STATUS_LABELS[a.status]}`);
  }
  lines.push('');
  lines.push(`**وضعیت حد نصاب:** ${q.reached ? 'حاصل شد' : 'حاصل نشد'} — ${q.explanation}`);
  return lines;
}

/** The attendance section as it should read now, from the recorded attendance. */
export async function currentAttendanceSection(db: Db, meetingId: string): Promise<string> {
  const m = (await one('SELECT c.settings FROM meetings m JOIN commissions c ON c.id = m.commission_id WHERE m.id = $1', [meetingId], db))!;
  const attendance = await loadAttendance(meetingId, db);
  return toPersianDigits(attendanceLines(attendance, quorumOf(attendance, mergeCommissionSettings(m.settings))).join('\n'));
}

/** Where the attendance section sits in a minutes text: [start, end), or null when its headings were edited away. */
function attendanceRange(body: string): [number, number] | null {
  const start = body.indexOf(ATTENDANCE_HEADING);
  if (start < 0) return null;
  const end = body.indexOf(AGENDA_HEADING, start);
  return end < 0 ? null : [start, end];
}

/**
 * Whether the minutes text still shows the recorded attendance: true, false, or null when the section can't
 * be found (the secretary rewrote it), in which case it must be checked by hand.
 */
export async function attendanceInSync(db: Db, meetingId: string, body: string): Promise<boolean | null> {
  const r = attendanceRange(body);
  if (!r) return null;
  return body.slice(r[0], r[1]).trim() === (await currentAttendanceSection(db, meetingId)).trim();
}

/**
 * After attendance is corrected, rewrites only the attendance section of a draft minutes (as a new version),
 * leaving the secretary's edits elsewhere as they are. Returns whether anything changed.
 */
export async function syncMinutesAttendance(db: Db, req: Request, meetingId: string): Promise<'synced' | 'unchanged' | 'manual' | 'none'> {
  const m = await one(`SELECT * FROM minutes WHERE meeting_id = $1 FOR UPDATE`, [meetingId], db);
  if (!m || !['draft', 'returned'].includes(m.status)) return 'none';
  const r = attendanceRange(m.body);
  if (!r) return 'manual';
  const section = await currentAttendanceSection(db, meetingId);
  if (m.body.slice(r[0], r[1]).trim() === section.trim()) return 'unchanged';
  const next = `${m.body.slice(0, r[0])}${section}\n\n${m.body.slice(r[1])}`;
  const row = await one(`UPDATE minutes SET body = $2, version = version + 1, updated_at = now() WHERE id = $1 RETURNING *`, [m.id, next], db);
  await db.query(`INSERT INTO minutes_versions (minutes_id, version, body, edited_by) VALUES ($1,$2,$3,$4)`, [row.id, row.version, row.body, req.user?.id ?? null]);
  await audit(db, req, { chamberId: m.chamber_id, action: 'minutes.attendance_synced', entity: 'minutes', entityId: m.id, after: { version: row.version } });
  return 'synced';
}

/**
 * Builds the minutes draft (Markdown) from the meeting's data: attendance, quorum,
 * agenda items, discussion summaries, decisions and vote results.
 */
export async function buildMinutesBody(db: Db, meetingId: string): Promise<string> {
  const m = (await one(
    `SELECT m.*, c.name AS commission_name, c.settings, ch.name AS chamber_name, t.title AS term_title
       FROM meetings m JOIN commissions c ON c.id = m.commission_id JOIN chambers ch ON ch.id = m.chamber_id
       JOIN terms t ON t.id = c.term_id WHERE m.id = $1`,
    [meetingId],
    db,
  ))!;
  const settings = mergeCommissionSettings(m.settings);
  const attendance = await loadAttendance(meetingId, db);
  const q = quorumOf(attendance, settings);
  const agenda = await query(
    `SELECT * FROM agenda_items WHERE meeting_id = $1 AND status <> 'removed' ORDER BY order_no`,
    [meetingId],
    db,
  );
  const votes = await query(`SELECT * FROM vote_sessions WHERE meeting_id = $1 AND status = 'closed' ORDER BY opened_at`, [meetingId], db);

  const lines: string[] = [];
  lines.push(`# صورتجلسه ${m.commission_name}`);
  lines.push('');
  lines.push(`**${m.chamber_name}** — ${m.term_title}`);
  lines.push('');
  lines.push(`- شماره جلسه: ${m.number}`);
  lines.push(`- عنوان: ${m.title}`);
  lines.push(`- تاریخ: ${formatJalaliLong(m.scheduled_at)}`);
  lines.push(`- ساعت شروع: ${m.started_at ? formatTime(m.started_at) : '—'} — ساعت پایان: ${m.ended_at ? formatTime(m.ended_at) : '—'}`);
  lines.push(`- نوع جلسه: ${MEETING_TYPE_LABELS[m.type as MeetingType]}${m.location ? ` — محل: ${m.location}` : ''}`);
  lines.push('');
  lines.push(...attendanceLines(attendance, q));
  lines.push('');
  lines.push('## دستور جلسه و تصمیمات');
  agenda.forEach((item, i) => {
    lines.push('');
    lines.push(`### ${i + 1}. ${item.title}`);
    lines.push(`وضعیت: ${AGENDA_STATUS_LABELS[item.status as keyof typeof AGENDA_STATUS_LABELS]}`);
    if (item.description) lines.push('', item.description);
    if (item.discussion_summary) lines.push('', `**خلاصه مذاکرات:** ${item.discussion_summary}`);
    for (const v of votes.filter((v) => v.agenda_item_id === item.id)) {
      lines.push('', `**${v.title}:** ${v.result?.summary ?? ''}${v.secret ? ' (رأی مخفی)' : ''}`);
    }
    if (item.decision) lines.push('', `**تصمیم جلسه:** ${item.decision}`);
    if (item.proposed_resolution) lines.push('', `**مصوبه پیشنهادی:** ${item.proposed_resolution}`);
  });
  lines.push('');
  lines.push('---');
  lines.push(
    m.archival
      ? `ثبت از سوابق در ${formatJalaliDateTime(new Date())}؛ نسخهٔ امضاشدهٔ کاغذی صورتجلسه در مستندات جلسه پیوست است.`
      : `پیش‌نویس به‌صورت خودکار در ${formatJalaliDateTime(new Date())} تولید شد.`,
  );
  return toPersianDigits(lines.join('\n'));
}

export async function generateMinutesDraft(db: Db, req: Request, meetingId: string) {
  const bodyText = await buildMinutesBody(db, meetingId);
  const existing = await one('SELECT id, version, status FROM minutes WHERE meeting_id = $1 FOR UPDATE', [meetingId], db);
  const m = (await one('SELECT chamber_id FROM meetings WHERE id = $1', [meetingId], db))!;
  let row;
  if (existing) {
    if (existing.status === 'approved') return existing;
    row = await one(
      `UPDATE minutes SET body = $2, version = version + 1, status = 'draft', updated_at = now() WHERE id = $1 RETURNING *`,
      [existing.id, bodyText],
      db,
    );
  } else {
    row = await one(`INSERT INTO minutes (chamber_id, meeting_id, body) VALUES ($1,$2,$3) RETURNING *`, [m.chamber_id, meetingId, bodyText], db);
  }
  await db.query(`INSERT INTO minutes_versions (minutes_id, version, body, edited_by) VALUES ($1,$2,$3,$4)`, [
    row.id,
    row.version,
    row.body,
    req.user?.id ?? null,
  ]);
  await audit(db, req, { chamberId: m.chamber_id, action: 'minutes.generated', entity: 'minutes', entityId: row.id, after: { version: row.version } });
  return row;
}
