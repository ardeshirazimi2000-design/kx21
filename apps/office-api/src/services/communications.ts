import { one, pool, query, tx, type Db } from '../db/pool.js';
import { audit } from '../lib/audit.js';
import { logger } from '../lib/logger.js';
import { registerHandler } from './jobs.js';
import { notify } from './notifications.js';
import { pbx } from './pbx.js';
import { emitToUsers, isOnline } from './realtime.js';

/** Current (not removed) members of a conversation. */
export async function memberIds(conversationId: string, db: Db = pool): Promise<string[]> {
  const rows = await query<{ user_id: string }>(
    'SELECT user_id FROM communication_conversation_members WHERE conversation_id = $1 AND left_at IS NULL',
    [conversationId],
    db,
  );
  return rows.map((r) => r.user_id);
}

/** The conversation if the user is a current member; null otherwise (callers answer 404 so existence is not revealed). */
export async function memberConversation(userId: string, conversationId: string, db: Db = pool) {
  return one(
    `SELECT c.*, m.member_role, m.last_read_at, m.joined_at, m.muted
       FROM communication_conversations c
       JOIN communication_conversation_members m ON m.conversation_id = c.id AND m.user_id = $1 AND m.left_at IS NULL
      WHERE c.id = $2`,
    [userId, conversationId],
    db,
  );
}

export const directKey = (a: string, b: string) => (a < b ? `${a}:${b}` : `${b}:${a}`);

export const MESSAGE_COLS = `m.id, m.conversation_id, m.sender_user_id, su.full_name AS sender_name, m.message_type,
  CASE WHEN m.deleted_at IS NULL THEN m.body ELSE '' END AS body, m.client_id, m.reply_to_id, m.created_at, m.edited_at, m.deleted_at,
  COALESCE((SELECT json_agg(json_build_object('id', a.id, 'file_name', a.file_name, 'mime_type', a.mime_type, 'size_bytes', a.size_bytes) ORDER BY a.created_at)
              FROM communication_attachments a WHERE a.message_id = m.id AND m.deleted_at IS NULL), '[]'::json) AS attachments`;

export async function messageById(id: string, db: Db = pool) {
  return one(`SELECT ${MESSAGE_COLS} FROM communication_messages m LEFT JOIN users su ON su.id = m.sender_user_id WHERE m.id = $1`, [id], db);
}

/** A system line in the conversation (member added / removed, renamed); returns the message. */
export async function systemMessage(db: Db, conversationId: string, body: string) {
  const r = await one(
    `INSERT INTO communication_messages (conversation_id, message_type, body) VALUES ($1, 'system', $2) RETURNING id`,
    [conversationId, body],
    db,
  );
  await db.query('UPDATE communication_conversations SET last_message_at = now() WHERE id = $1', [conversationId]);
  return r!.id as string;
}

/**
 * After a new message is committed: push it to the members' sockets, and leave an in-app notification for members
 * who are not connected (one unread notification per conversation, no message text in it).
 */
export async function deliverMessage(conversationId: string, messageId: string, senderId: string | null) {
  const msg = await messageById(messageId);
  if (!msg) return;
  const members = await query<{ user_id: string; muted: boolean }>(
    'SELECT user_id, muted FROM communication_conversation_members WHERE conversation_id = $1 AND left_at IS NULL',
    [conversationId],
  );
  emitToUsers(
    members.map((m) => m.user_id),
    'NewMessage',
    { conversationId, message: msg },
  );
  if (msg.message_type === 'system' || !senderId) return;
  const offline = members.filter((m) => m.user_id !== senderId && !m.muted && !isOnline(m.user_id)).map((m) => m.user_id);
  if (!offline.length) return;
  const conv = await one('SELECT conversation_type, title FROM communication_conversations WHERE id = $1', [conversationId]);
  const pending = await query<{ user_id: string }>(
    `SELECT user_id FROM notifications WHERE user_id = ANY($1::uuid[]) AND event = 'message.received' AND read_at IS NULL AND data->>'conversationId' = $2`,
    [offline, conversationId],
  );
  const skip = new Set(pending.map((p) => p.user_id));
  const to = offline.filter((u) => !skip.has(u));
  if (!to.length) return;
  await notify({
    userIds: to,
    event: 'message.received',
    vars: { sender: msg.sender_name, conversation: conv?.conversation_type === 'group' ? `در گروه «${conv.title}»` : '' },
    data: { conversationId, path: `/communications/messages?c=${conversationId}` },
  }).catch((e) => logger.warn({ err: e }, 'message notification failed'));
}

/** Provisioning job: runs the PBX adapter for one extension; the job queue retries a failure with backoff. */
registerHandler('communications.provision', async (p: { extensionId: string }) => {
  const ext = await one('SELECT * FROM communication_extensions WHERE id = $1', [p.extensionId]);
  if (!ext || !['provisioning', 'failed'].includes(ext.status)) return; // disabled or confirmed meanwhile
  try {
    await pbx().provisionExtension({ id: ext.id, number: ext.extension_number, label: ext.label });
  } catch (e) {
    await query(
      `UPDATE communication_extensions SET status = 'failed', last_error = $2, updated_at = now() WHERE id = $1 AND status IN ('provisioning', 'failed')`,
      [ext.id, 'ایجاد داخلی در مرکز تلفن ناموفق بود؛ دوباره تلاش می‌شود'],
    );
    throw e;
  }
  await tx(async (c) => {
    const r = await one(
      `UPDATE communication_extensions SET status = 'active', provision_source = 'adapter', last_error = NULL, updated_at = now()
        WHERE id = $1 AND status IN ('provisioning', 'failed') RETURNING *`,
      [ext.id],
      c,
    );
    if (r)
      await audit(c, null, {
        action: 'communications.extension_provisioned',
        entity: 'communication_extension',
        entityId: ext.id,
        before: ext,
        after: r,
        userId: ext.created_by,
      });
  });
});
