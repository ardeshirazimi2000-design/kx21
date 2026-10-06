import type { NotificationChannel, NotificationEvent } from '@kx/shared';
import { SOCKET_EVENTS } from '@kx/shared';
import { config } from '../config.js';
import { pool, query } from '../db/pool.js';
import { logger } from '../lib/logger.js';
import { emitToUser } from '../realtime.js';

/** Notification matrix (section 10 of the spec): event → channels. In-app is always stored. */
export const NOTIFICATION_MATRIX: Record<NotificationEvent, NotificationChannel[]> = {
  'meeting.invited': ['in_app', 'push', 'sms', 'email'],
  'meeting.changed': ['in_app', 'push', 'sms'],
  'meeting.cancelled': ['in_app', 'push', 'sms'],
  'meeting.checkin_opened': ['in_app', 'push'],
  'meeting.checkin_reminder': ['in_app', 'push'],
  'meeting.quorum_not_reached': ['in_app', 'push'],
  'vote.opened': ['in_app', 'push'],
  'vote.result': ['in_app'],
  'minutes.pending_approval': ['in_app', 'push'],
  'minutes.returned': ['in_app', 'push'],
  'minutes.approved': ['in_app', 'push'],
  'resolution.created': ['in_app', 'push', 'email'],
  'resolution.due_soon': ['in_app', 'push'],
  'resolution.overdue': ['in_app', 'push', 'email'],
  'resolution.reviewed': ['in_app', 'push'],
  'referral.created': ['in_app', 'push', 'email'],
  'referral.answered': ['in_app', 'push'],
};

export interface NotifyInput {
  chamberId: string | null;
  userIds: string[];
  event: NotificationEvent;
  title: string;
  body: string;
  data?: Record<string, unknown>;
}

interface Recipient {
  id: string;
  mobile: string | null;
  email: string | null;
  push_tokens: string[];
}

interface Provider {
  send(r: Recipient, n: NotifyInput): Promise<'sent' | 'skipped'>;
}

const logProvider = (channel: string): Provider => ({
  async send(r, n) {
    logger.info({ channel, to: r.id, event: n.event, title: n.title }, 'notification (log provider)');
    return 'sent';
  },
});

const expoPush: Provider = {
  async send(r, n) {
    if (!r.push_tokens.length) return 'skipped';
    const messages = r.push_tokens.map((to) => ({ to, title: n.title, body: n.body, data: { event: n.event, ...n.data }, sound: 'default' }));
    const res = await fetch('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(messages),
    });
    if (!res.ok) throw new Error(`expo push failed: ${res.status}`);
    return 'sent';
  },
};

const kavenegarSms: Provider = {
  async send(r, n) {
    if (!r.mobile || !config.kavenegarApiKey) return 'skipped';
    const url = `https://api.kavenegar.com/v1/${config.kavenegarApiKey}/sms/send.json`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ receptor: r.mobile, sender: config.kavenegarSender ?? '', message: `${n.title}\n${n.body}` }),
    });
    if (!res.ok) throw new Error(`sms failed: ${res.status}`);
    return 'sent';
  },
};

function provider(channel: NotificationChannel): Provider | null {
  switch (channel) {
    case 'in_app':
      return null;
    case 'push':
      return config.pushProvider === 'expo' && !config.isTest ? expoPush : logProvider('push');
    case 'sms':
      return config.smsProvider === 'kavenegar' && !config.isTest ? kavenegarSms : logProvider('sms');
    case 'email':
      // SMTP integration point; logged until the organisation's mail relay is configured.
      return logProvider('email');
  }
}

/**
 * Stores in-app notifications, pushes them over the socket and dispatches external
 * channels asynchronously. Call after the business transaction has committed.
 */
export async function notify(n: NotifyInput): Promise<void> {
  const userIds = [...new Set(n.userIds.filter(Boolean))];
  if (!userIds.length) return;
  const channels = NOTIFICATION_MATRIX[n.event];
  const recipients = await query<Recipient>(
    `SELECT u.id, u.mobile, u.email, COALESCE(array_agg(d.push_token) FILTER (WHERE d.push_token IS NOT NULL), '{}') AS push_tokens
       FROM users u LEFT JOIN devices d ON d.user_id = u.id
      WHERE u.id = ANY($1) AND u.is_active GROUP BY u.id`,
    [userIds],
  );
  for (const r of recipients) {
    const [row] = await query<{ id: string; created_at: Date }>(
      `INSERT INTO notifications (chamber_id, user_id, event, title, body, data, channels)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, created_at`,
      [n.chamberId, r.id, n.event, n.title, n.body, JSON.stringify(n.data ?? {}), channels],
    );
    emitToUser(r.id, SOCKET_EVENTS.notification, {
      id: row.id,
      event: n.event,
      title: n.title,
      body: n.body,
      data: n.data ?? {},
      createdAt: row.created_at,
    });
    void dispatch(row.id, r, n, channels);
  }
}

async function dispatch(notificationId: string, r: Recipient, n: NotifyInput, channels: NotificationChannel[]) {
  const delivery: Record<string, string> = { in_app: 'sent' };
  for (const ch of channels) {
    const p = provider(ch);
    if (!p) continue;
    try {
      delivery[ch] = await p.send(r, n);
    } catch (e) {
      delivery[ch] = 'failed';
      logger.warn({ err: (e as Error).message, ch, notificationId }, 'notification delivery failed');
    }
  }
  await pool.query('UPDATE notifications SET delivery = $2 WHERE id = $1', [notificationId, JSON.stringify(delivery)]).catch(() => {});
}
