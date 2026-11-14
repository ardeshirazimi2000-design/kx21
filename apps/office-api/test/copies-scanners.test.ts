import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { pool } from '../src/db/pool.js';
import { seed, SEED_PASSWORD } from '../src/db/seed.js';
import { parseCapabilities, scanSettingsXml } from '../src/lib/escl.js';

const app = createApp();
const tokens: Record<string, string> = {};
const me: Record<string, any> = {};
const as = (who: string) => ({
  get: (url: string) => request(app).get(url).set('authorization', `Bearer ${tokens[who]}`),
  post: (url: string, body: object = {}) => request(app).post(url).set('authorization', `Bearer ${tokens[who]}`).send(body),
  patch: (url: string, body: object = {}) => request(app).patch(url).set('authorization', `Bearer ${tokens[who]}`).send(body),
  delete: (url: string) => request(app).delete(url).set('authorization', `Bearer ${tokens[who]}`),
  upload: (url: string, fields: Record<string, string>, file: Buffer, name: string) => {
    const r = request(app).post(url).set('authorization', `Bearer ${tokens[who]}`);
    for (const [k, v] of Object.entries(fields)) r.field(k, v);
    return r.attach('file', file, name);
  },
});

// A real 40×56 greyscale JPEG, as a scanner page.
const JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDABALDA4MChAODQ4SERATGCgaGBYWGDEjJR0oOjM9PDkzODdASFxOQERXRTc4UG1RV19iZ2hnPk1xeXBkeFxlZ2P/wAALCAA4ACgBAREA/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/9oACAEBAAA/AOkoooooooooooooooooooooooooooooooooor//2Q==',
  'base64',
);

const CAPS = `<?xml version="1.0" encoding="UTF-8"?>
<scan:ScannerCapabilities xmlns:scan="http://schemas.hp.com/imaging/escl/2011/05/03" xmlns:pwg="http://www.pwg.org/schemas/2010/12/sm">
  <pwg:Version>2.63</pwg:Version><pwg:MakeAndModel>Test MFP 4100</pwg:MakeAndModel>
  <scan:Platen><scan:PlatenInputCaps><scan:MaxWidth>2550</scan:MaxWidth><scan:MaxHeight>3508</scan:MaxHeight>
    <scan:SettingProfiles><scan:SettingProfile><scan:ColorModes><scan:ColorMode>BlackAndWhite1</scan:ColorMode><scan:ColorMode>Grayscale8</scan:ColorMode><scan:ColorMode>RGB24</scan:ColorMode></scan:ColorModes>
    <scan:DocumentFormats><pwg:DocumentFormat>image/jpeg</pwg:DocumentFormat><pwg:DocumentFormat>application/pdf</pwg:DocumentFormat></scan:DocumentFormats>
    <scan:SupportedResolutions><scan:DiscreteResolutions>
      <scan:DiscreteResolution><scan:XResolution>150</scan:XResolution><scan:YResolution>150</scan:YResolution></scan:DiscreteResolution>
      <scan:DiscreteResolution><scan:XResolution>300</scan:XResolution><scan:YResolution>300</scan:YResolution></scan:DiscreteResolution>
    </scan:DiscreteResolutions></scan:SupportedResolutions></scan:SettingProfile></scan:SettingProfiles></scan:PlatenInputCaps></scan:Platen>
  <scan:Adf><scan:AdfSimplexInputCaps><scan:MaxWidth>2550</scan:MaxWidth><scan:MaxHeight>4200</scan:MaxHeight>
    <scan:SettingProfiles><scan:SettingProfile><scan:ColorModes><scan:ColorMode>Grayscale8</scan:ColorMode></scan:ColorModes>
    <scan:SupportedResolutions><scan:DiscreteResolutions><scan:DiscreteResolution><scan:XResolution>200</scan:XResolution></scan:DiscreteResolution></scan:DiscreteResolutions></scan:SupportedResolutions>
    </scan:SettingProfile></scan:SettingProfiles></scan:AdfSimplexInputCaps>
    <scan:AdfDuplexInputCaps><scan:MaxWidth>2550</scan:MaxWidth></scan:AdfDuplexInputCaps></scan:Adf>
</scan:ScannerCapabilities>`;

/** A network scanner speaking eSCL: a feeder job returns two pages, then 404. */
let scanner: Server;
let scannerUrl = '';
const jobs: { settings: string; served: number }[] = [];
const startScanner = () =>
  new Promise<void>((resolve) => {
    scanner = createServer((req, res) => {
      const url = req.url ?? '';
      if (req.method === 'GET' && url === '/eSCL/ScannerCapabilities') return res.writeHead(200, { 'content-type': 'text/xml' }).end(CAPS);
      if (req.method === 'GET' && url === '/eSCL/ScannerStatus')
        return res.writeHead(200).end('<scan:ScannerStatus><pwg:State>Idle</pwg:State><scan:AdfState>ScannerAdfLoaded</scan:AdfState></scan:ScannerStatus>');
      if (req.method === 'POST' && url === '/eSCL/ScanJobs') {
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
          jobs.push({ settings: body, served: 0 });
          res.writeHead(201, { location: `/eSCL/ScanJobs/job-${jobs.length}` }).end();
        });
        return;
      }
      const m = url.match(/^\/eSCL\/ScanJobs\/job-(\d+)(\/NextDocument)?$/);
      if (m && req.method === 'DELETE') return res.writeHead(200).end();
      if (m && m[2]) {
        const job = jobs[Number(m[1]) - 1];
        const pages = job.settings.includes('<pwg:InputSource>Feeder</pwg:InputSource>') ? 2 : 1;
        if (job.served >= pages) return res.writeHead(404).end();
        job.served++;
        return res.writeHead(200, { 'content-type': 'image/jpeg' }).end(JPEG);
      }
      res.writeHead(404).end();
    }).listen(0, '127.0.0.1', () => {
      scannerUrl = `http://127.0.0.1:${(scanner.address() as AddressInfo).port}`;
      resolve();
    });
  });

beforeAll(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await seed();
  for (const u of ['admin', 'clerk', 'sechead', 'cmshead', 'cmsexpert', 'reshead', 'expert', 'it']) {
    const r = await request(app).post('/api/auth/login').send({ identifier: u, password: SEED_PASSWORD });
    tokens[u] = r.body.accessToken;
    me[u] = (await as(u).get('/api/auth/me')).body;
  }
  await startScanner();
});

afterAll(async () => {
  scanner?.close();
  await pool.end();
});

const units = async () => (await as('admin').get('/api/org/units')).body.units as any[];
const cartable = async (who: string, letterId: string) => ((await as(who).get('/api/cartable')).body as any[]).filter((x) => x.letter_id === letterId);

describe('internal letters and copies (رونوشت)', () => {
  it('an internal letter reaches its recipients in the cartable when numbered: «گیرنده» for action, «رونوشت» for information', async () => {
    const cms = (await units()).find((u) => u.code === 'CMS');
    const l = (
      await as('expert').post('/api/letters', {
        kind: 'internal',
        subject: 'گزارش بررسی تعرفه واردات',
        body: '<p>متن</p>',
        bodyFormat: 'html',
        recipients: [
          { userId: me.reshead.id, kind: 'to' },
          { unitId: cms.id, kind: 'cc', note: 'جهت اطلاع' },
        ],
      })
    ).body;
    // A draft is nobody's but the writer's.
    expect((await as('cmshead').get(`/api/letters/${l.id}`)).status).toBe(404);
    expect(await cartable('reshead', l.id)).toHaveLength(0);

    expect((await as('expert').post(`/api/letters/${l.id}/register`)).status).toBe(200);
    const [toItem] = await cartable('reshead', l.id);
    expect(toItem).toMatchObject({ action: 'refer' });
    const [ccItem] = await cartable('cmshead', l.id);
    expect(ccItem).toMatchObject({ action: 'info', instruction: 'جهت اطلاع' });
    const seen = await as('cmshead').get(`/api/letters/${l.id}`);
    expect(seen.status).toBe(200);
    expect(seen.body.recipients.map((r: any) => [r.kind, r.note, !!r.delivered_at])).toEqual([
      ['to', null, true],
      ['cc', 'جهت اطلاع', true],
    ]);
    const n = await pool.query(`SELECT count(*)::int AS n FROM notifications WHERE event = 'letter.received' AND data->>'letterId' = $1`, [l.id]);
    expect(n.rows[0].n).toBe(2);
  });

  it('only internal letters have «گیرنده»; external copies belong to outgoing letters; a unit needs a manager', async () => {
    const base = { subject: 'آزمون قواعد گیرنده', externalOrg: 'وزارت صمت' };
    expect((await as('clerk').post('/api/letters', { ...base, kind: 'outgoing', recipients: [{ userId: me.reshead.id, kind: 'to' }] })).status).toBe(400);
    expect((await as('expert').post('/api/letters', { kind: 'internal', subject: 'آزمون رونوشت', externalCopies: [{ label: 'سازمان الف' }] })).status).toBe(
      400,
    );
    expect(
      (
        await as('expert').post('/api/letters', {
          kind: 'internal',
          subject: 'آزمون تکرار',
          recipients: [{ userId: me.reshead.id }, { userId: me.reshead.id }],
        })
      ).status,
    ).toBe(400);
  });

  it('an outgoing letter carries internal and external copies; internal copies are handed over when it is sent', async () => {
    const contacts = (await as('clerk').get('/api/contacts')).body as any[];
    const mefa = contacts.find((c) => c.kind === 'organization');
    const res = (await units()).find((u) => u.code === 'RES');
    const created = await as('clerk').post('/api/letters', {
      kind: 'outgoing',
      subject: 'اعلام نظر درباره لایحه بودجه',
      body: '<p>متن</p>',
      bodyFormat: 'html',
      contactId: mefa.id,
      recipients: [{ unitId: res.id, kind: 'cc', note: 'جهت استحضار' }],
      externalCopies: [{ contactId: mefa.id, note: 'جهت اطلاع' }, { label: 'اتاق بازرگانی استان تهران' }],
      register: true,
    });
    expect(created.status).toBe(201);
    const l = (await as('clerk').get(`/api/letters/${created.body.id}`)).body;
    expect(l.externalCopies.map((x: any) => [x.label, x.note])).toEqual([
      [mefa.name, 'جهت اطلاع'],
      ['اتاق بازرگانی استان تهران', null],
    ]);
    // Numbered but not yet sent: the copy waits.
    expect(await cartable('reshead', l.id)).toHaveLength(0);
    expect((await as('reshead').get(`/api/letters/${l.id}`)).status).toBe(404);
    expect((await as('sechead').post(`/api/letters/${l.id}/send`, { requireSignature: false })).status).toBe(200);
    const [item] = await cartable('reshead', l.id);
    expect(item).toMatchObject({ action: 'info', instruction: 'جهت استحضار' });
  });

  it('a registered incoming letter delivers its copies at once, and editing it delivers only the copies added', async () => {
    const l = (
      await as('clerk').post('/api/letters', {
        kind: 'incoming',
        subject: 'دعوت به همایش صادرات',
        externalOrg: 'سازمان توسعه تجارت',
        recipients: [{ userId: me.cmshead.id, kind: 'cc' }],
        register: true,
      })
    ).body;
    expect(await cartable('cmshead', l.id)).toHaveLength(1);
    const p = await as('clerk').patch(`/api/letters/${l.id}`, {
      recipients: [
        { userId: me.cmshead.id, kind: 'cc' },
        { userId: me.expert.id, kind: 'cc', note: 'جهت بررسی' },
      ],
    });
    expect(p.status).toBe(200);
    expect(await cartable('cmshead', l.id)).toHaveLength(1);
    expect(await cartable('expert', l.id)).toHaveLength(1);
    const rows = await pool.query('SELECT count(*)::int AS n FROM letter_routing WHERE letter_id = $1', [l.id]);
    expect(rows.rows[0].n).toBe(2);
  });

  it('«ارسال رونوشت» of an existing letter is a referral for information', async () => {
    const l = (await as('expert').post('/api/letters', { kind: 'internal', subject: 'یادداشت داخلی', body: 'x', register: true })).body;
    const r = await as('expert').post(`/api/letters/${l.id}/routes`, {
      targets: [{ userId: me.cmsexpert.id, action: 'info', instruction: 'رونوشت جهت اطلاع' }],
    });
    expect(r.status).toBe(201);
    expect(await cartable('cmsexpert', l.id)).toMatchObject([{ action: 'info' }]);
  });
});

describe('network scanners (eSCL)', () => {
  it('reads the capabilities of a scanner and writes A4 scan settings within its area', () => {
    const caps = parseCapabilities(CAPS);
    expect(caps).toMatchObject({
      makeAndModel: 'Test MFP 4100',
      sources: ['Platen', 'Feeder', 'FeederDuplex'],
      colorModes: ['Grayscale8', 'RGB24'],
      resolutions: [150, 200, 300],
    });
    const xml = scanSettingsXml({ source: 'FeederDuplex', colorMode: 'Grayscale8', resolution: 200 }, { width: 2400, height: 4200 });
    expect(xml).toContain('<pwg:Width>2400</pwg:Width>');
    expect(xml).toContain('<pwg:Height>3508</pwg:Height>');
    expect(xml).toContain('<pwg:InputSource>Feeder</pwg:InputSource>');
    expect(xml).toContain('<scan:Duplex>true</scan:Duplex>');
  });

  let id = '';
  it('IT registers a scanner; staff see it without its address', async () => {
    expect((await as('expert').post('/api/scanners', { name: 'اسکنر دبیرخانه', url: scannerUrl })).status).toBe(403);
    expect((await as('it').post('/api/scanners', { name: 'اسکنر', url: 'ftp://10.0.0.1' })).status).toBe(400);
    const r = await as('it').post('/api/scanners', { name: 'اسکنر دبیرخانه', url: scannerUrl, location: 'طبقه دوم' });
    expect(r.status).toBe(201);
    expect(r.body.url).toBe(`${scannerUrl}/eSCL`);
    id = r.body.id;
    const list = (await as('expert').get('/api/scanners')).body;
    expect(list).toEqual([{ id, name: 'اسکنر دبیرخانه', location: 'طبقه دوم', is_active: true }]);
    const caps = await as('expert').get(`/api/scanners/${id}/capabilities`);
    expect(caps.status).toBe(200);
    expect(caps.body).toMatchObject({ state: 'Idle', sources: ['Platen', 'Feeder', 'FeederDuplex'] });
  });

  it('scans the feeder into one PDF that is attached as a scan', async () => {
    const r = await as('clerk')
      .post(`/api/scanners/${id}/scan`, { source: 'Feeder', colorMode: 'Grayscale8', resolution: 300 })
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toBe('application/pdf');
    expect(r.headers['x-scan-pages']).toBe('2');
    // The feeder offers 200 dpi only: the nearest resolution is asked for.
    expect(jobs.at(-1)!.settings).toContain('<scan:XResolution>200</scan:XResolution>');
    const pdf = r.body as Buffer;
    const dir = mkdtempSync(path.join(os.tmpdir(), 'scan-'));
    writeFileSync(path.join(dir, 'scan.pdf'), pdf);
    try {
      expect(execFileSync('pdfinfo', [path.join(dir, 'scan.pdf')]).toString()).toMatch(/Pages:\s+2/);
    } catch (e: any) {
      if (e.code !== 'ENOENT') throw e; // pdfinfo is optional on CI
      expect(pdf.toString('latin1')).toContain('/Count 2');
    }
    const l = (await as('clerk').post('/api/letters', { kind: 'incoming', subject: 'نامه اسکن‌شده', externalOrg: 'گمرک', source: 'scan' })).body;
    const a = await as('clerk').upload(`/api/letters/${l.id}/attachments`, { source: 'scan' }, pdf, 'اسکن.pdf');
    expect(a.status).toBe(201);
    expect(a.body.mime_type).toBe('application/pdf');
  });

  it('a scanner that cannot be reached gives a clear error and IT sees it', async () => {
    const dead = (await as('it').post('/api/scanners', { name: 'اسکنر خاموش', url: 'http://127.0.0.1:9/eSCL' })).body;
    const r = await as('clerk').post(`/api/scanners/${dead.id}/scan`, { source: 'Platen' });
    expect(r.status).toBe(502);
    expect(r.body.error.message).toContain('اسکنر');
    const list = (await as('it').get('/api/scanners')).body;
    expect(list.find((s: any) => s.id === dead.id).last_error).toBeTruthy();
    expect((await as('it').delete(`/api/scanners/${dead.id}`)).status).toBe(204);
  });
});
