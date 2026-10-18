import http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as pptxNs from 'pptxgenjs';
import { io as ioClient, type Socket } from 'socket.io-client';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { migrate } from '../src/db/migrate.js';
import { pool } from '../src/db/pool.js';
import { seed, SEED_PASSWORD } from '../src/db/seed.js';
import { closeRealtime, initRealtime } from '../src/realtime.js';
import { officeConverterAvailable } from '../src/services/officeConvert.js';
import { popplerAvailable } from '../src/services/presentable.js';

/** Live presentation of meeting documents: the secretary turns pages, participants follow over the socket. */
const app = createApp();
const officeOk = await officeConverterAvailable();
const pagesOk = await popplerAvailable();
/** A valid three-page PDF (Poppler rebuilds the missing cross-reference table). */
const PDF3 = Buffer.from(
  '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R 4 0 R 5 0 R]/Count 3>>endobj\n' +
    [3, 4, 5].map((n) => `${n} 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 320 180]>>endobj\n`).join('') +
    'trailer<</Root 1 0 R>>\n%%EOF\n',
);
const tokens: Record<string, string> = {};
let server: http.Server;
let baseUrl: string;
let meetingId: string;
let otherMeetingId: string;

const as = (who: string) => ({
  get: (url: string) => request(app).get(url).set('authorization', `Bearer ${tokens[who]}`),
  post: (url: string, b: object = {}) => request(app).post(url).set('authorization', `Bearer ${tokens[who]}`).send(b),
  put: (url: string, b: object = {}) => request(app).put(url).set('authorization', `Bearer ${tokens[who]}`).send(b),
  del: (url: string) => request(app).delete(url).set('authorization', `Bearer ${tokens[who]}`),
});
const binary = (res: any, cb: (e: Error | null, b: Buffer) => void) => {
  const chunks: Buffer[] = [];
  res.on('data', (c: Buffer) => chunks.push(c));
  res.on('end', () => cb(null, Buffer.concat(chunks)));
};
const uploadTo = (meeting: string, buf: Buffer, filename: string) =>
  request(app).post('/api/documents').set('authorization', `Bearer ${tokens.secretary}`).field('meetingId', meeting).attach('file', buf, { filename });

beforeAll(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate(false);
  await seed();
  for (const [who, email] of [['secretary', 'secretary@kx.local'], ['m1', 'member1@kx.local'], ['outsider', 'admin.isf@kx.local']]) {
    tokens[who] = (await request(app).post('/api/auth/login').send({ identifier: email, password: SEED_PASSWORD })).body.accessToken;
  }
  const items = (await as('secretary').get('/api/meetings?pageSize=50')).body.items;
  meetingId = items.find((m: any) => m.status === 'invitation_sent' || m.status === 'scheduled').id;
  otherMeetingId = items.find((m: any) => m.id !== meetingId).id;
  server = http.createServer(app);
  initRealtime(server);
  await new Promise<void>((r) => server.listen(0, r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  closeRealtime();
  await new Promise((r) => server.close(r));
});

describe('live presentation of meeting documents', () => {
  let pdfId: string;

  it('only the chair/secretary present; others follow', async () => {
    const pdf = await uploadTo(meetingId, PDF3, 'اسلایدها.pdf');
    pdfId = pdf.body.id;
    const g = (await as('m1').get(`/api/meetings/${meetingId}/presentation`)).body;
    expect(g).toEqual({ presentation: null, canPresent: false });
    expect((await as('m1').put(`/api/meetings/${meetingId}/presentation`, { documentId: pdfId })).status).toBe(403);
    expect((await as('secretary').get(`/api/meetings/${meetingId}/presentation`)).body.canPresent).toBe(true);

    // A participant connected to the meeting receives every page change.
    const s: Socket = ioClient(baseUrl, { auth: { token: tokens.m1 }, transports: ['websocket'], forceNew: true });
    await new Promise<void>((r) => s.on('connect', () => r()));
    await new Promise((r) => s.emit('meeting:join', meetingId, r));
    const got: any[] = [];
    s.on('presentation.updated', (p) => got.push(p));

    const start = await as('secretary').put(`/api/meetings/${meetingId}/presentation`, { documentId: pdfId, page: 1 });
    expect(start.status).toBe(200);
    expect(start.body.presentation).toMatchObject({ documentId: pdfId, page: 1, presenterName: 'حسین کریمی', document: { file_name: 'اسلایدها.pdf' } });
    const next = await as('secretary').put(`/api/meetings/${meetingId}/presentation`, { documentId: pdfId, page: 3 });
    expect(next.body.presentation.startedAt).toBe(start.body.presentation.startedAt);
    await new Promise((r) => setTimeout(r, 200));
    expect(got.map((p) => p.presentation.page)).toEqual([1, 3]);
    // Late joiners get the current page.
    expect((await as('m1').get(`/api/meetings/${meetingId}/presentation`)).body.presentation.page).toBe(3);
    s.close();
  });

  it('presents only documents of this meeting, of a presentable type', async () => {
    const other = await uploadTo(otherMeetingId, Buffer.from('%PDF-1.4\n%%EOF'), 'دیگر.pdf');
    expect((await as('secretary').put(`/api/meetings/${meetingId}/presentation`, { documentId: other.body.id })).status).toBe(404);
    const txt = await uploadTo(meetingId, Buffer.from('یادداشت'), 'note.txt');
    expect((await as('secretary').put(`/api/meetings/${meetingId}/presentation`, { documentId: txt.body.id })).status).toBe(400);
  });

  it('refuses a page beyond the end of the document', async () => {
    if (!pagesOk) return;
    expect((await as('secretary').put(`/api/meetings/${meetingId}/presentation`, { documentId: pdfId, page: 4 })).status).toBe(400);
  });

  it('gives participants a long-lived link to the pages, rendered on the server', async () => {
    const l = await as('m1').post(`/api/documents/${pdfId}/present-link`);
    if (pagesOk) {
      expect(l.body).toMatchObject({ type: 'pages', pages: 3 });
      const img = await request(app).get(`${l.body.url}2`).buffer(true).parse(binary);
      expect(img.status).toBe(200);
      expect(img.headers['content-type']).toMatch(/^image\/png/);
      expect((img.body as Buffer).subarray(1, 4).toString()).toBe('PNG');
      expect((await request(app).get(`${l.body.url}9`)).status).toBe(404);
    } else {
      expect(l.body.type).toBe('pdf');
      const f = await request(app).get(l.body.url).buffer(true).parse(binary);
      expect(f.headers['content-type']).toBe('application/pdf');
    }
    expect((await as('outsider').post(`/api/documents/${pdfId}/present-link`)).status).toBe(404);
  });

  it.runIf(officeOk)('converts PowerPoint to PDF once and presents it', { timeout: 200_000 }, async () => {
    const Pptx = ((pptxNs as any).default ?? pptxNs) as any;
    const deck = new Pptx();
    deck.addSlide().addText('بررسی موانع صادرات', { x: 1, y: 1, w: 8, h: 1, fontSize: 32, rtlMode: true });
    deck.addSlide().addText('پیشنهادها', { x: 1, y: 1, w: 8, h: 1, fontSize: 32, rtlMode: true });
    const buf = Buffer.from(await deck.write({ outputType: 'nodebuffer' }));
    const up = await uploadTo(meetingId, buf, 'ارائه صادرات.pptx');
    expect(up.body.kind).toBe('presentation');
    const put = await as('secretary').put(`/api/meetings/${meetingId}/presentation`, { documentId: up.body.id, page: 2 });
    expect(put.status).toBe(200);
    const key = (await pool.query('SELECT pdf_key FROM documents WHERE id = $1', [up.body.id])).rows[0].pdf_key;
    expect(key).toMatch(/\.pdf$/);
    const l = await as('m1').post(`/api/documents/${up.body.id}/present-link`);
    if (pagesOk) {
      expect(l.body).toMatchObject({ type: 'pages', pages: 2 });
      const img = await request(app).get(`${l.body.url}2`).buffer(true).parse(binary);
      expect(img.headers['content-type']).toMatch(/^image\/png/);
    }
    // The converted PDF itself stays available (fallback viewer).
    const token = new URL(l.body.url, 'http://x').searchParams.get('token');
    const f = await request(app).get(`/api/files/${up.body.id}?token=${token}&pdf=1`).buffer(true).parse(binary);
    expect(f.headers['content-type']).toBe('application/pdf');
    expect((f.body as Buffer).subarray(0, 4).toString()).toBe('%PDF');
    expect(f.headers['content-disposition']).toContain(encodeURIComponent('ارائه صادرات.pdf'));
  });

  it('stops the presentation', async () => {
    expect((await as('m1').del(`/api/meetings/${meetingId}/presentation`)).status).toBe(403);
    expect((await as('secretary').del(`/api/meetings/${meetingId}/presentation`)).status).toBe(204);
    expect((await as('m1').get(`/api/meetings/${meetingId}/presentation`)).body.presentation).toBeNull();
  });
});
