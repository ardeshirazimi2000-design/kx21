import http from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { config } from '../src/config.js';
import { migrate } from '../src/db/migrate.js';
import { pool } from '../src/db/pool.js';
import { seed, SEED_PASSWORD } from '../src/db/seed.js';
import { withDiscussionSection } from '../src/services/minutes.js';
import { runNextTranscript, splitText, transcriptText } from '../src/services/transcripts.js';

/** Draft minutes from a meeting's recording: a fake Whisper + Ollama server stands in for the engines. */
const app = createApp();
const tokens: Record<string, string> = {};
let meetingId: string;
let itemId: string;
let recordingId: string;

const as = (who: string) => ({
  get: (url: string) => request(app).get(url).set('authorization', `Bearer ${tokens[who]}`),
  post: (url: string, b: object = {}) => request(app).post(url).set('authorization', `Bearer ${tokens[who]}`).send(b),
});

const engine = { stt: [] as string[], chat: [] as any[], fail: false };
let server: http.Server;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      if (engine.fail) {
        res.writeHead(500).end('engine down');
        return;
      }
      if (req.url === '/v1/audio/transcriptions') {
        engine.stt.push(raw.toString('latin1'));
        res.writeHead(200, { 'content-type': 'application/json' }).end(
          JSON.stringify({
            text: 'ignored',
            segments: [
              { start: 0, text: ' بسم الله. دستور جلسه رفع موانع صادرات است.' },
              { start: 75.4, text: ' مصوب شد گمرک ظرف یک ماه گزارش بدهد.' },
            ],
          }),
        );
        return;
      }
      if (req.url === '/api/chat') {
        const j = JSON.parse(raw.toString('utf8'));
        engine.chat.push(j);
        const part = j.format?.required?.includes('decisions');
        const notesOnly = j.format?.required?.length === 1 && j.format.required[0] === 'notes';
        const content = notesOnly
          ? { notes: 'یادداشت فشرده' }
          : part
            ? { notes: 'بحث دربارهٔ صادرات', decisions: [{ text: 'گمرک ظرف یک ماه گزارش موانع را ارائه کند', agendaItem: 1, responsible: 'گمرک', deadline: 'یک ماه' }] }
            : {
                discussion: '### ۱. رفع موانع صادرات\nاعضا دربارهٔ موانع صادرات به عراق گفتگو کردند.',
                resolutions: [
                  { text: 'گمرک ظرف یک ماه گزارش موانع را ارائه کند', agendaItem: 1, responsible: 'گمرک', deadline: 'یک ماه' },
                  { text: 'گمرک ظرف یک ماه گزارش موانع را ارائه کند', agendaItem: 1 },
                  { text: 'کم', agendaItem: 9 },
                  { text: 'دبیرخانه پیگیری کند', agendaItem: 7, responsible: 'null' },
                ],
              };
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ message: { role: 'assistant', content: JSON.stringify(content) } }));
        return;
      }
      res.writeHead(404).end();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));

  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate(false);
  await seed();
  for (const [who, email] of [['secretary', 'secretary@kx.local'], ['m1', 'member1@kx.local']]) {
    tokens[who] = (await request(app).post('/api/auth/login').send({ identifier: email, password: SEED_PASSWORD })).body.accessToken;
  }
  const exp = (await as('secretary').get('/api/commissions?pageSize=50')).body.items.find((x: any) => x.code === 'EXP').id;
  meetingId = (await as('secretary').post('/api/meetings/archival', { commissionId: exp, number: 7, title: 'جلسهٔ صادرات', date: '2025-05-10', startTime: '10:00', endTime: '12:00' })).body.id;
  await as('secretary').post(`/api/meetings/${meetingId}/attendance/bulk`, { status: 'manual_present' });
  itemId = (await as('secretary').post(`/api/meetings/${meetingId}/agenda`, { title: 'رفع موانع صادرات به عراق' })).body.id;
  await as('secretary').post(`/api/meetings/${meetingId}/minutes`, { regenerate: true });
});

afterAll(() => {
  server.close();
  config.stt.baseUrl = '';
  config.ai.baseUrl = '';
  config.ai.chatModel = '';
});

const job = async (id: string) => (await as('secretary').get(`/api/transcripts/${id}`)).body;

describe('draft minutes from the meeting recording', () => {
  it('accepts audio recordings of the meeting', async () => {
    const mp3 = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(2000, 1)]);
    const up = await request(app).post('/api/documents').set('authorization', `Bearer ${tokens.secretary}`).field('meetingId', meetingId).attach('file', mp3, { filename: 'جلسه.mp3' });
    expect(up.status).toBe(201);
    expect(up.body).toMatchObject({ kind: 'recording', mime_type: 'audio/mpeg' });
    recordingId = up.body.id;
    const bad = await request(app).post('/api/documents').set('authorization', `Bearer ${tokens.secretary}`).field('meetingId', meetingId).attach('file', Buffer.alloc(100, 7), { filename: 'x.mp3' });
    expect(bad.status).toBe(400);
  });

  it('says the engines are not set up yet, and keeps transcripts to the officers', async () => {
    expect((await as('secretary').get('/api/ai/capabilities')).body).toEqual({ transcription: false, drafting: false });
    const r = await as('secretary').post(`/api/meetings/${meetingId}/transcripts`, { documentId: recordingId });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('stt_not_configured');
    expect((await as('secretary').post(`/api/meetings/${meetingId}/transcripts`, { text: 'متن '.repeat(30) })).body.error.code).toBe('llm_not_configured');
    expect((await as('m1').get(`/api/meetings/${meetingId}/transcripts`)).status).toBe(403);
    expect((await as('m1').post(`/api/meetings/${meetingId}/transcripts`, { documentId: recordingId })).status).toBe(403);
  });

  it('turns the recording into timed text, then drafts the minutes text and resolutions', async () => {
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
    config.stt.baseUrl = base;
    config.ai.baseUrl = base;
    config.ai.chatModel = 'gemma3:12b';
    // Meetings recorded from the archive notify nobody; this one is treated as a regular meeting here.
    await pool.query('UPDATE meetings SET archival = false WHERE id = $1', [meetingId]);
    const r = await as('secretary').post(`/api/meetings/${meetingId}/transcripts`, { documentId: recordingId });
    expect(r.status).toBe(201);
    expect((await as('secretary').post(`/api/meetings/${meetingId}/transcripts`, { documentId: recordingId })).body.error.code).toBe('transcript_running');
    expect(await runNextTranscript()).toBe(true);

    const t = await job(r.body.id);
    expect(t.status).toBe('done');
    expect(t.transcript).toBe('[00:00:00] بسم الله. دستور جلسه رفع موانع صادرات است.\n[00:01:15] مصوب شد گمرک ظرف یک ماه گزارش بدهد.');
    expect(t.discussion).toContain('رفع موانع صادرات');
    // Duplicates and too-short ones are dropped; agenda numbers become agenda items; "null" is no responsible.
    expect(t.resolutions).toEqual([
      { text: 'گمرک ظرف یک ماه گزارش موانع را ارائه کند', agendaItemId: itemId, responsible: 'گمرک', deadline: 'یک ماه' },
      { text: 'دبیرخانه پیگیری کند', agendaItemId: null, responsible: null, deadline: null },
    ]);
    expect(t).toMatchObject({ stt_model: config.stt.model, llm_model: 'gemma3:12b', file_name: 'جلسه.mp3' });

    // The recogniser was asked for Persian, with names and agenda titles as spelling hints; the file was streamed whole.
    expect(engine.stt[0]).toContain('name="language"\r\n\r\nfa');
    expect(Buffer.from(engine.stt[0], 'latin1').toString('utf8')).toContain('رفع موانع صادرات به عراق');
    expect(engine.stt[0]).toContain('filename="recording.mp3"');
    // The model got the meeting's context and a large enough window.
    expect(engine.chat[0].options.num_ctx).toBe(config.ai.chatContext);
    expect(engine.chat[0].messages[1].content).toContain('1. رفع موانع صادرات به عراق');

    const n = await pool.query(`SELECT title FROM notifications WHERE event = 'minutes.transcript_ready'`);
    expect(n.rows.map((x) => x.title)).toEqual(['پیش‌نویس صورتجلسه از فایل صوتی آماده شد']);
    await pool.query('UPDATE meetings SET archival = true WHERE id = $1', [meetingId]);
    const log = await pool.query(`SELECT action FROM audit_logs WHERE action LIKE 'transcript.%'`);
    expect(log.rows.map((x) => x.action)).toEqual(['transcript.requested']);
  });

  it('puts the reviewed text into the draft minutes once, without touching the attendance section', async () => {
    const id = (await as('secretary').get(`/api/meetings/${meetingId}/transcripts`)).body.items[0].id;
    const before = (await as('secretary').get(`/api/meetings/${meetingId}/minutes`)).body;
    expect((await as('secretary').post(`/api/transcripts/${id}/apply`, { discussion: 'متن بازبینی‌شدهٔ نخست' })).status).toBe(200);
    const r = await as('secretary').post(`/api/transcripts/${id}/apply`, { discussion: 'متن بازبینی‌شدهٔ دوم دبیر' });
    expect(r.status).toBe(200);
    expect(r.body.version).toBe(before.version + 2);
    expect(r.body.body.match(/## شرح مذاکرات جلسه/g)).toHaveLength(1);
    expect(r.body.body).toContain('متن بازبینی‌شدهٔ دوم دبیر');
    expect(r.body.body).not.toContain('نخست');
    expect(r.body.body.trimEnd().split('\n').at(-2)).toBe('---');
    expect((await as('secretary').get(`/api/meetings/${meetingId}/minutes`)).body.attendanceSynced).toBe(before.attendanceSynced);
    expect((await job(id)).applied_at).toBeTruthy();
  });

  it('drafts a long meeting part by part, then combines', async () => {
    const ctx = config.ai.chatContext;
    config.ai.chatContext = 4000; // 3000 characters per part
    engine.chat = [];
    try {
      const text = Array.from({ length: 120 }, (_, i) => `گوینده ${i}: نظر دربارهٔ موانع صادرات و راهکارهای آن مطرح شد.`).join('\n');
      const r = await as('secretary').post(`/api/meetings/${meetingId}/transcripts`, { text });
      expect(r.status).toBe(201);
      await runNextTranscript();
      const t = await job(r.body.id);
      expect(t).toMatchObject({ status: 'done', source: 'text', stt_model: null });
      const parts = engine.chat.filter((c) => c.format.required.includes('decisions'));
      expect(parts.length).toBe(splitText(text, 3000).length);
      expect(parts.length).toBeGreaterThan(1);
      expect(engine.chat.at(-1).messages[1].content).toContain('گمرک ظرف یک ماه گزارش موانع را ارائه کند');
      expect(t.resolutions.length).toBe(2);
    } finally {
      config.ai.chatContext = ctx;
    }
  });

  it('reports an engine failure, then a retry keeps the finished transcript', async () => {
    engine.fail = true;
    engine.stt = [];
    const r = await as('secretary').post(`/api/meetings/${meetingId}/transcripts`, { documentId: recordingId });
    await runNextTranscript();
    let t = await job(r.body.id);
    expect(t.status).toBe('failed');
    expect(t.error).toContain('500');
    engine.fail = false;
    expect((await as('secretary').post(`/api/transcripts/${r.body.id}/retry`)).status).toBe(204);
    await runNextTranscript();
    t = await job(r.body.id);
    expect(t.status).toBe('done');
    expect(engine.stt.length).toBe(1);
    // A redraft only runs the model again.
    await as('secretary').post(`/api/transcripts/${r.body.id}/retry`);
    await runNextTranscript();
    expect(engine.stt.length).toBe(1);
    expect((await job(r.body.id)).status).toBe('done');
  });

  it('cancels a queued job', async () => {
    const r = await as('secretary').post(`/api/meetings/${meetingId}/transcripts`, { documentId: recordingId });
    expect((await as('secretary').post(`/api/transcripts/${r.body.id}/cancel`)).status).toBe(204);
    expect(await runNextTranscript()).toBe(false);
    expect((await job(r.body.id)).status).toBe('cancelled');
  });
});

describe('transcript helpers', () => {
  it('reads plain and timed responses', () => {
    expect(transcriptText('{"text":" سلام "}')).toBe('سلام');
    expect(transcriptText('سلام دنیا')).toBe('سلام دنیا');
    expect(transcriptText('{"segments":[{"start":3725,"text":"الف"},{"start":1,"text":"  "}]}')).toBe('[01:02:05] الف');
  });

  it('splits at line breaks and cuts very long lines', () => {
    expect(splitText('a\nb\nc', 3)).toEqual(['a\nb', 'c']);
    expect(splitText('abcdefg', 3)).toEqual(['abc', 'def', 'g']);
  });

  it('adds the discussion before the closing line, or replaces it', () => {
    const body = '# صورتجلسه\n\n## دستور جلسه و تصمیمات\n\n### ۱. الف\n\n---\nپیش‌نویس خودکار';
    const once = withDiscussionSection(body, 'متن اول');
    expect(once).toBe('# صورتجلسه\n\n## دستور جلسه و تصمیمات\n\n### ۱. الف\n\n## شرح مذاکرات جلسه\n\nمتن اول\n\n---\nپیش‌نویس خودکار');
    expect(withDiscussionSection(once, 'متن دوم')).toBe(once.replace('متن اول', 'متن دوم'));
    expect(withDiscussionSection('بدون پانویس', 'x')).toBe('بدون پانویس\n\n## شرح مذاکرات جلسه\n\nx\n');
  });
});
