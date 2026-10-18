import http from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { config } from '../src/config.js';
import { migrate } from '../src/db/migrate.js';
import { pool } from '../src/db/pool.js';
import { seed, SEED_PASSWORD } from '../src/db/seed.js';
import { normalizeText } from '../src/services/similarity.js';

/**
 * Similar resolutions across a network. The seed shares Yazd's EXP-001 (رفع تعهد ارزی) in the trade network;
 * Isfahan's trade commission gets one resolution on the same issue and one unrelated.
 * The AI path runs against a stand-in OpenAI-compatible /embeddings server (bag-of-words vectors).
 */
const app = createApp();
const tokens: Record<string, string> = {};
const as = (who: string) => ({
  get: (url: string) => request(app).get(url).set('authorization', `Bearer ${tokens[who]}`),
  post: (url: string, body: object = {}) => request(app).post(url).set('authorization', `Bearer ${tokens[who]}`).send(body),
});

let fake: http.Server;
let fakeUrl: string;
let embedCalls = 0;
const DIM = 256;
function vectorOf(text: string): number[] {
  const v = new Array(DIM).fill(0);
  for (const w of text.split(' ')) {
    if (w.length < 3) continue;
    let h = 0;
    for (const ch of w) h = (h * 31 + ch.charCodeAt(0)) % DIM;
    v[h] += 1;
  }
  return v;
}

let net: string;
let exp1: string;
let trdSame: string;
let trdOther: string;
let trd: string;

beforeAll(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate(false);
  await seed();
  for (const [who, email] of [['isfChair', 'chair.isf@kx.local'], ['secretary', 'secretary@kx.local'], ['m1', 'member1@kx.local']]) {
    const r = await request(app).post('/api/auth/login').send({ identifier: email, password: SEED_PASSWORD });
    tokens[who] = r.body.accessToken;
  }
  const k = (await pool.query(`SELECT id, chamber_id FROM commissions WHERE code = 'TRD'`)).rows[0];
  trd = k.id;
  exp1 = (await pool.query(`SELECT id FROM resolutions WHERE number = 'EXP-001'`)).rows[0].id;
  net = (await pool.query(`SELECT id FROM networks`)).rows[0].id;
  const ins = async (number: string, text: string) =>
    (await pool.query(`INSERT INTO resolutions (chamber_id, commission_id, number, text) VALUES ($1,$2,$3,$4) RETURNING id`, [k.chamber_id, trd, number, text])).rows[0].id;
  trdSame = await ins('TRD-001', 'پیگیری تمدید مهلت رفع تعهد ارزی صادرکنندگان خرد استان از طریق بانک مرکزی');
  trdOther = await ins('TRD-002', 'برگزاری نمایشگاه صنایع دستی در فرودگاه');

  fake = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      embedCalls++;
      const { input } = JSON.parse(body) as { input: string[] };
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ data: input.map((t, index) => ({ index, embedding: vectorOf(t) })) }));
    });
  });
  await new Promise<void>((r) => fake.listen(0, r));
  fakeUrl = `http://127.0.0.1:${(fake.address() as AddressInfo).port}/v1`;
});

afterAll(async () => {
  config.ai.baseUrl = '';
  await new Promise((r) => fake.close(r));
});

describe('similar resolutions (text similarity, no AI engine)', () => {
  it('normalizes Arabic letters and ZWNJ', () => {
    expect(normalizeText('مصوبه‌اي «كمیسیون»')).toBe('مصوبه ای کمیسیون');
  });

  it('suggests a shared resolution resembling the commission’s own', async () => {
    const r = (await as('isfChair').get(`/api/networks/${net}/suggestions`)).body;
    expect(r.engine).toBe('text');
    expect(r.items).toHaveLength(1);
    expect(r.items[0].resolution.number).toBe('EXP-001');
    expect(r.items[0].matched.number).toBe('TRD-001');
    expect(r.items[0].commission_id).toBe(trd);
  });

  it('lists similar resolutions of other provinces on the resolution page', async () => {
    const same = (await as('isfChair').get(`/api/resolutions/${trdSame}/similar`)).body;
    expect(same.items.map((i: any) => i.number)).toEqual(['EXP-001']);
    expect(same.items[0].network_id).toBe(net);
    expect((await as('isfChair').get(`/api/resolutions/${trdOther}/similar`)).body.items).toEqual([]);
    // Only people who may see the resolution.
    expect((await as('m1').get(`/api/resolutions/${trdSame}/similar`)).status).toBe(404);
  });

  it('members get no suggestions; a dismissed suggestion disappears', async () => {
    expect((await as('m1').get(`/api/networks/${net}/suggestions`)).body.items).toEqual([]);
    expect((await as('m1').post(`/api/networks/${net}/suggestions/dismiss`, { resolutionId: exp1, commissionId: trd })).status).toBe(403);
    expect((await as('isfChair').post(`/api/networks/${net}/suggestions/dismiss`, { resolutionId: exp1, commissionId: trd })).status).toBe(204);
    expect((await as('isfChair').get(`/api/networks/${net}/suggestions`)).body.items).toEqual([]);
    await pool.query('DELETE FROM network_suggestion_dismissals');
  });
});

describe('similar resolutions with the AI engine', () => {
  it('compares embeddings and stores them for reuse', async () => {
    config.ai.baseUrl = fakeUrl;
    config.ai.minScore = 0.5;
    const r = (await as('isfChair').get(`/api/networks/${net}/suggestions`)).body;
    expect(r.engine).toBe('ai');
    expect(r.model).toBe('bge-m3');
    expect(r.items.map((i: any) => i.resolution.number)).toEqual(['EXP-001']);
    expect(r.items[0].score).toBeGreaterThan(0.5);
    const stored = (await pool.query('SELECT count(*)::int AS n FROM resolution_embeddings')).rows[0].n;
    expect(stored).toBeGreaterThanOrEqual(3);
    const calls = embedCalls;
    await as('isfChair').get(`/api/networks/${net}/suggestions`);
    expect(embedCalls).toBe(calls);
    // Changing a text recomputes only its embedding.
    await pool.query(`UPDATE resolutions SET text = text || ' فوری' WHERE id = $1`, [trdOther]);
    await as('isfChair').get(`/api/resolutions/${trdOther}/similar`);
    expect(embedCalls).toBe(calls + 1);
  });

  it('notifies a commission when something similar to its issue is shared', async () => {
    await pool.query(`INSERT INTO resolutions (chamber_id, commission_id, number, text) SELECT chamber_id, id, 'TRD-003', 'تهیه گزارش کارشناسی ظرفیت‌های صادراتی استان به عراق و اقلیم کردستان' FROM commissions WHERE id = $1`, [trd]);
    const exp2 = (await pool.query(`SELECT id FROM resolutions WHERE number = 'EXP-002'`)).rows[0].id;
    expect((await as('secretary').post(`/api/resolutions/${exp2}/share`, {})).status).toBe(200);
    const events = (await as('isfChair').get('/api/notifications?pageSize=50')).body.items;
    const n = events.find((e: any) => e.event === 'network.similar_found');
    expect(n.body).toContain('TRD-003');
    expect(events.some((e: any) => e.event === 'network.resolution_shared')).toBe(false);
  });

  it('falls back to text similarity when the engine is unreachable', async () => {
    config.ai.baseUrl = 'http://127.0.0.1:9/v1';
    // Stored embeddings keep working without the engine; new texts need it.
    expect((await as('isfChair').get(`/api/resolutions/${trdSame}/similar`)).body.engine).toBe('ai');
    await pool.query('DELETE FROM resolution_embeddings');
    const r = (await as('isfChair').get(`/api/resolutions/${trdSame}/similar`)).body;
    expect(r.engine).toBe('text');
    expect(r.items.map((i: any) => i.number)).toEqual(['EXP-001']);
  });
});
