import { formatJalaliDate } from '@kx/shared';
import { config } from '../config.js';
import { query } from '../db/pool.js';
import { logger } from '../lib/logger.js';
import { notify } from './notifications.js';

/**
 * Periodic jobs:
 *  - resolution due-soon reminders (owner + secretary)
 *  - overdue resolutions (owner + chair/secretary)
 *  - check-in reminder for invitees still pending 10 minutes after the meeting started
 * Each notification is sent once (tracked on the row or by checking previous notifications).
 * In multi-instance deployments run the scheduler in a single worker (SCHEDULER_ENABLED=true).
 */
export async function runScheduledJobs(): Promise<void> {
  const dueSoon = await query(
    `UPDATE resolutions r SET due_soon_notified_at = now()
       FROM commissions c
      WHERE c.id = r.commission_id AND r.status NOT IN ('done','cancelled','submitted') AND r.due_soon_notified_at IS NULL
        AND r.due_date >= current_date
        AND r.due_date <= current_date + COALESCE((c.settings->>'dueSoonDays')::int, 3)
      RETURNING r.id, r.chamber_id, r.commission_id, r.number, r.owner_id, r.due_date`,
  );
  for (const r of dueSoon) {
    const sec = await query(`SELECT user_id FROM commission_memberships WHERE commission_id = $1 AND status = 'active' AND position = 'secretary'`, [r.commission_id]);
    await notify({
      chamberId: r.chamber_id,
      userIds: [r.owner_id, ...sec.map((s: any) => s.user_id)],
      event: 'resolution.due_soon',
      title: `نزدیک شدن مهلت مصوبه ${r.number}`,
      body: `مهلت اجرا: ${formatJalaliDate(r.due_date + 'T12:00:00')}`,
      data: { resolutionId: r.id },
    });
  }

  const overdue = await query(
    `UPDATE resolutions SET overdue_notified_at = now()
      WHERE status NOT IN ('done','cancelled') AND due_date < current_date AND overdue_notified_at IS NULL
      RETURNING id, chamber_id, commission_id, number, owner_id, due_date`,
  );
  for (const r of overdue) {
    const officers = await query(
      `SELECT user_id FROM commission_memberships WHERE commission_id = $1 AND status = 'active' AND position IN ('chair','secretary')`,
      [r.commission_id],
    );
    await notify({
      chamberId: r.chamber_id,
      userIds: [r.owner_id, ...officers.map((s: any) => s.user_id)],
      event: 'resolution.overdue',
      title: `تأخیر در اجرای مصوبه ${r.number}`,
      body: `مهلت اجرا (${formatJalaliDate(r.due_date + 'T12:00:00')}) گذشته است.`,
      data: { resolutionId: r.id },
    });
  }

  const pending = await query(
    `SELECT m.id AS meeting_id, m.chamber_id, m.title, array_agg(a.user_id) AS user_ids
       FROM meetings m JOIN attendance a ON a.meeting_id = m.id AND a.status = 'pending'
      WHERE m.status IN ('in_progress','agenda_processing') AND m.checkin_closed_at IS NULL
        AND m.started_at < now() - interval '10 minutes'
        AND NOT EXISTS (SELECT 1 FROM notifications n WHERE n.event = 'meeting.checkin_reminder' AND n.data->>'meetingId' = m.id::text)
      GROUP BY m.id`,
  );
  for (const m of pending) {
    await notify({
      chamberId: m.chamber_id,
      userIds: m.user_ids,
      event: 'meeting.checkin_reminder',
      title: `یادآوری اعلام حضور: ${m.title}`,
      body: 'جلسه آغاز شده و حضور شما هنوز ثبت نشده است.',
      data: { meetingId: m.meeting_id },
    });
  }
  if (dueSoon.length || overdue.length || pending.length) {
    logger.info({ dueSoon: dueSoon.length, overdue: overdue.length, checkinReminders: pending.length }, 'scheduled jobs ran');
  }
}

export function startScheduler(): () => void {
  const timer = setInterval(() => {
    runScheduledJobs().catch((e) => logger.error({ err: e }, 'scheduler failed'));
  }, config.schedulerIntervalSeconds * 1000);
  timer.unref();
  return () => clearInterval(timer);
}
