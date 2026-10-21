import { readdir } from 'node:fs/promises';
import path from 'node:path';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { config } from '../src/config.js';
import { migrate } from '../src/db/migrate.js';
import { pool } from '../src/db/pool.js';
import { seed, SEED_PASSWORD } from '../src/db/seed.js';

/** Correcting or removing a document uploaded by mistake. */
const app = createApp();
const tokens: Record<string, string> = {};
let meetingId: string;
let approvedMeetingId: string;

const as = (who: string) => ({
  patch: (url: string, b: object) => request(app).patch(url).set('authorization', `Bearer ${tokens[who]}`).send(b),
  del: (url: string) => request(app).delete(url).set('authorization', `Bearer ${tokens[who]}`),
  get: (url: string) => request(app).get(url).set('authorization', `Bearer ${tokens[who]}`),
  upload: (meeting: string, buf: Buffer, filename: string) =>
    request(app).post('/api/documents').set('authorization', `Bearer ${tokens[who]}`).field('meetingId', meeting).attach('file', buf, { filename }),
});
const PDF = Buffer.from('%PDF-1.4\n%%EOF\n');

beforeAll(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate(false);
  await seed();
  for (const [who, email] of [['secretary', 'secretary@kx.local'], ['m1', 'member1@kx.local']]) {
    tokens[who] = (await request(app).post('/api/auth/login').send({ identifier: email, password: SEED_PASSWORD })).body.accessToken;
  }
  const items = (await as('secretary').get('/api/meetings?pageSize=50')).body.items;
  meetingId = items.find((m: any) => ['scheduled', 'invitation_sent'].includes(m.status)).id;
  approvedMeetingId = items.find((m: any) => ['approved', 'archived'].includes(m.status)).id;
});

describe('correcting meeting documents', () => {
  it('the secretary renames and retypes a document', async () => {
    const up = await as('secretary').upload(meetingId, PDF, 'گزارش.pdf');
    const r = await as('secretary').patch(`/api/documents/${up.body.id}`, { title: 'گزارش عملکرد صادرات', kind: 'report' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ title: 'گزارش عملکرد صادرات', kind: 'report', file_name: 'گزارش.pdf' });
    expect((await as('secretary').patch(`/api/documents/${up.body.id}`, { title: '' })).body.title).toBeNull();
    expect((await as('m1').patch(`/api/documents/${up.body.id}`, { title: 'x' })).status).toBe(403);
  });

  it('deletes the record and the stored file; members cannot', async () => {
    const up = await as('secretary').upload(meetingId, PDF, 'اشتباه.pdf');
    const key = (await pool.query('SELECT storage_key FROM documents WHERE id = $1', [up.body.id])).rows[0].storage_key;
    const dir = path.resolve(config.uploadDir, path.dirname(key));
    expect(await readdir(dir)).toContain(path.basename(key));
    expect((await as('m1').del(`/api/documents/${up.body.id}`)).status).toBe(403);
    // Being presented: deleting stops the presentation.
    await request(app).put(`/api/meetings/${meetingId}/presentation`).set('authorization', `Bearer ${tokens.secretary}`).send({ documentId: up.body.id });
    expect((await as('secretary').del(`/api/documents/${up.body.id}`)).status).toBe(204);
    expect(await readdir(dir)).not.toContain(path.basename(key));
    const docs = (await as('secretary').get(`/api/documents?meetingId=${meetingId}`)).body;
    expect(docs.find((d: any) => d.id === up.body.id)).toBeUndefined();
    expect((await as('secretary').get(`/api/meetings/${meetingId}/presentation`)).body.presentation).toBeNull();
    const log = await pool.query(`SELECT 1 FROM audit_logs WHERE action = 'document.deleted' AND entity_id = $1`, [up.body.id]);
    expect(log.rowCount).toBe(1);
  });

  it('documents of a meeting with approved minutes stay as recorded', async () => {
    const id = (await pool.query(
      `INSERT INTO documents (chamber_id, commission_id, meeting_id, kind, file_name, mime_type, size_bytes, storage_key, sha256)
       SELECT chamber_id, commission_id, id, 'attachment', 'old.pdf', 'application/pdf', 1, 'x/none', 'x' FROM meetings WHERE id = $1 RETURNING id`,
      [approvedMeetingId],
    )).rows[0].id;
    expect((await as('secretary').del(`/api/documents/${id}`)).status).toBe(409);
    expect((await as('secretary').patch(`/api/documents/${id}`, { title: 'x' })).status).toBe(409);
  });
});
