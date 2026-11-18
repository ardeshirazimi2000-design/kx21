import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { jpegsToPdf } from '@kx/shared';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { pool } from '../src/db/pool.js';
import { seed, SEED_PASSWORD } from '../src/db/seed.js';
import { cleanOcrText, extractText, ocrStatus } from '../src/lib/ocr.js';
import { drainJobs } from '../src/services/jobs.js';
import { refreshIndex } from '../src/services/search.js';

/**
 * OCR and AI summary of incoming letters. The fixtures are a Persian letter rendered as a PNG image, a JPEG «scan»,
 * and a PDF that carries its text. Tests that need Tesseract skip themselves when it is not installed.
 */
const fixture = (f: string) => readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', f));
const PNG = fixture('incoming-letter.png');
const JPEG = fixture('incoming-letter.jpg');
const TEXT_PDF = fixture('incoming-letter-text.pdf');
const SCAN_PDF = Buffer.from(jpegsToPdf([JPEG]));

const app = createApp();
const tokens: Record<string, string> = {};
const as = (who: string) => ({
  get: (url: string) => request(app).get(url).set('authorization', `Bearer ${tokens[who]}`),
  post: (url: string, body: object = {}) => request(app).post(url).set('authorization', `Bearer ${tokens[who]}`).send(body),
  patch: (url: string, body: object = {}) => request(app).patch(url).set('authorization', `Bearer ${tokens[who]}`).send(body),
  put: (url: string, body: object = {}) => request(app).put(url).set('authorization', `Bearer ${tokens[who]}`).send(body),
  upload: (url: string, fields: Record<string, string>, file: Buffer, name: string) => {
    const r = request(app).post(url).set('authorization', `Bearer ${tokens[who]}`);
    for (const [k, v] of Object.entries(fields)) r.field(k, v);
    return r.attach('file', file, name);
  },
});

/** A stand-in for an OpenAI-compatible model server; records every prompt it receives. */
let ai: Server;
let aiUrl = '';
const prompts: string[] = [];

const haveOcr = (await ocrStatus()).available;

beforeAll(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await seed();
  for (const u of ['clerk', 'sechead', 'expert', 'it']) {
    const r = await request(app).post('/api/auth/login').send({ identifier: u, password: SEED_PASSWORD });
    tokens[u] = r.body.accessToken;
  }
  ai = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const b = JSON.parse(raw || '{}');
      if (req.url?.endsWith('/chat/completions')) {
        prompts.push(b.messages.map((m: any) => m.content).join('\n'));
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(
          JSON.stringify({ choices: [{ message: { content: 'خلاصه: شرکت فولاد سپاهان برای نمایشگاه صنایع معدنی دو نماینده از اتاق خواسته است.' } }] }),
        );
      }
      res.writeHead(404).end();
    });
  });
  await new Promise<void>((ok) => ai.listen(0, '127.0.0.1', ok));
  aiUrl = `http://127.0.0.1:${(ai.address() as AddressInfo).port}/v1`;
});

afterAll(async () => {
  ai?.close();
  await pool.end();
});

const newIncoming = async (extra: object = {}) =>
  (await as('clerk').post('/api/letters', { kind: 'incoming', subject: 'نامه شرکت فولاد', externalOrg: 'شرکت فولاد سپاهان', source: 'scan', ...extra })).body;

describe('reading scans (lib/ocr)', () => {
  it('tidies OCR output: Persian letters, no bidi marks, no runs of blank lines', () => {
    expect(cleanOcrText('‫كتاب علي‬  \n\n\n\nسلام ‎')).toBe('کتاب علی\n\nسلام');
  });

  it.skipIf(!haveOcr)('reads a PDF made from a word processor from its rendered pages, not its scrambled Persian text layer', async () => {
    const r = await extractText(TEXT_PDF, 'application/pdf');
    expect(r.method).toBe('ocr');
    // pdftotext gives «فوالد» and «سالم» here (the لا ligature reversed).
    expect(r.text).toContain('فولاد سپاهان');
    expect(r.text).toContain('سلام');
  });

  it.skipIf(!haveOcr)('reads a Persian image and a scanned PDF with Tesseract', async () => {
    const img = await extractText(PNG, 'image/png');
    expect(img).toMatchObject({ method: 'ocr', pages: 1 });
    expect(img.text).toContain('نمایشگاه');
    const pdf = await extractText(SCAN_PDF, 'application/pdf');
    expect(pdf).toMatchObject({ method: 'ocr', pages: 1 });
    expect(pdf.text).toContain('فولاد');
  });
});

describe.skipIf(!haveOcr)('OCR and summary of incoming letters', () => {
  it('reads an attached scan in the background, and the smart search finds the letter by words only in the scan', async () => {
    expect((await as('it').get('/api/ocr/status')).body).toMatchObject({ available: true });
    const l = await newIncoming();
    const up = await as('clerk').upload(`/api/letters/${l.id}/attachments`, { source: 'scan' }, PNG, 'نامه.png');
    expect(up.status).toBe(201);
    expect(up.body.ocr_status).toBe('pending');
    await drainJobs();
    const d = (await as('clerk').get(`/api/letters/${l.id}`)).body;
    expect(d.attachments[0]).toMatchObject({ ocr_status: 'done', ocr_method: 'ocr', ocr_pages: 1 });
    expect(d.attachments[0].ocr_chars).toBeGreaterThan(100);
    expect(d.ocr).toEqual({ available: true, reason: null });
    // Without an AI provider there is no summary, and «شرح نامه» stays as it was.
    expect(d.aiSummary).toMatchObject({ available: false });
    expect(d.summary).toBeNull();
    const t = await as('clerk').get(`/api/letters/${d.id}/attachments/${d.attachments[0].id}/text`);
    expect(t.body.ocr_text).toContain('نماینده');

    await as('clerk').post(`/api/letters/${l.id}/register`);
    await refreshIndex();
    const s = (await as('clerk').get('/api/search?q=' + encodeURIComponent('نمایشگاه صنایع معدنی'))).body;
    const hit = s.items.find((x: any) => x.id === l.id);
    expect(hit).toBeTruthy();
    expect(JSON.stringify(hit.snippet)).toContain('نمایشگاه');
  });

  it('does not OCR attachments of outgoing or internal letters', async () => {
    const l = (await as('expert').post('/api/letters', { kind: 'internal', subject: 'داخلی', body: '<p>x</p>', bodyFormat: 'html' })).body;
    const up = await as('expert').upload(`/api/letters/${l.id}/attachments`, {}, PNG, 'a.png');
    expect(up.body.ocr_status).toBeUndefined();
    const row = await pool.query('SELECT ocr_status FROM letter_attachments WHERE id = $1', [up.body.id]);
    expect(row.rows[0].ocr_status).toBeNull();
  });

  it('with an AI provider, fills an empty «شرح نامه» from the scan, never replacing what a person wrote', async () => {
    expect((await as('it').put('/api/integrations/ai', { baseUrl: aiUrl, chatModel: 'qwen' })).status).toBe(204);
    prompts.length = 0;

    const l = await newIncoming();
    await as('clerk').upload(`/api/letters/${l.id}/attachments`, { source: 'scan' }, SCAN_PDF, 'scan.pdf');
    await drainJobs();
    const d = (await as('clerk').get(`/api/letters/${l.id}`)).body;
    expect(d.summary).toBe('شرکت فولاد سپاهان برای نمایشگاه صنایع معدنی دو نماینده از اتاق خواسته است.');
    expect(d.ai_summary).toBe(d.summary);
    expect(d.aiSummary).toEqual({ available: true, reason: null });
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('فولاد');
    const audited = await pool.query(`SELECT count(*)::int AS n FROM audit_logs WHERE action = 'letter.ai_summary' AND entity_id = $1`, [l.id]);
    expect(audited.rows[0].n).toBe(1);

    // A summary the clerk wrote stays; a fresh suggestion is only offered.
    await as('clerk').patch(`/api/letters/${l.id}`, { summary: 'درخواست معرفی نماینده' });
    const again = await as('clerk').post(`/api/letters/${l.id}/ai-summary`);
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ summary: 'درخواست معرفی نماینده', filled: false });
    expect(again.body.aiSummary).toContain('فولاد');
    // Adding a second scan does not call the model again for a letter whose summary a person wrote.
    const before = prompts.length;
    await as('clerk').upload(`/api/letters/${l.id}/attachments`, { source: 'scan' }, JPEG, 'page2.jpg');
    await drainJobs();
    expect(prompts.length).toBe(before);
  });

  it('never sends a classified letter to the AI provider: OCR only', async () => {
    prompts.length = 0;
    const l = await newIncoming();
    // sechead has clearance 1 and classifies the letter before attaching the scan.
    expect((await as('sechead').patch(`/api/letters/${l.id}`, { confidentiality: 1 })).status).toBe(200);
    await as('sechead').upload(`/api/letters/${l.id}/attachments`, { source: 'scan' }, PNG, 'secret.png');
    await drainJobs();
    const d = (await as('sechead').get(`/api/letters/${l.id}`)).body;
    expect(d.attachments[0].ocr_status).toBe('done');
    expect(d.summary).toBeNull();
    expect(d.ai_summary).toBeNull();
    expect(d.aiSummary.available).toBe(false);
    expect((await as('sechead').post(`/api/letters/${l.id}/ai-summary`)).status).toBe(400);
    // The form preview refuses too.
    const p = await as('sechead').upload('/api/letters/ocr', { confidentiality: '1' }, PNG, 'secret.png');
    expect(p.status).toBe(200);
    expect(p.body.text).toContain('نماینده');
    expect(p.body.summary).toBeNull();
    expect(p.body.summaryNote).toContain('طبقه‌بندی‌شده');
    expect(prompts).toHaveLength(0);
  });

  it('reads a scan in the «ثبت نامه وارده» form before saving, and suggests a summary', async () => {
    const p = await as('clerk').upload('/api/letters/ocr', { confidentiality: '0', subject: 'نمایشگاه' }, JPEG, 'scan.jpg');
    expect(p.status).toBe(200);
    expect(p.body).toMatchObject({ method: 'ocr', pages: 1 });
    expect(p.body.text).toContain('فولاد');
    expect(p.body.summary).toContain('فولاد سپاهان');
    // Only the secretariat registers incoming letters.
    expect((await as('expert').upload('/api/letters/ocr', {}, JPEG, 'scan.jpg')).status).toBe(403);
    expect((await as('clerk').upload('/api/letters/ocr', {}, Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]), 'a.zip')).status).toBe(400);
  });
});
