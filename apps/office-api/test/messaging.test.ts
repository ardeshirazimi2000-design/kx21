import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { pool } from '../src/db/pool.js';
import { seed, SEED_PASSWORD } from '../src/db/seed.js';
import { enqueue, drainJobs } from '../src/services/jobs.js';
import { normalizeMobile, parseWsdl, soapEnvelope, soapResult, wsdlAddress } from '../src/services/messaging.js';
import { outbox } from '../src/services/notifications.js';

const app = createApp();
const tokens: Record<string, string> = {};
const as = (who: string) => ({
  get: (url: string) => request(app).get(url).set('authorization', `Bearer ${tokens[who]}`),
  post: (url: string, body: object = {}) => request(app).post(url).set('authorization', `Bearer ${tokens[who]}`).send(body),
  put: (url: string, body: object = {}) => request(app).put(url).set('authorization', `Bearer ${tokens[who]}`).send(body),
});

/** An SMS panel with the SOAP web service of «راهنمای وب سرویس ارسال پیامک» v3 (PHP / NuSOAP, rpc/encoded). */
let panel: Server;
let base = '';
const calls: { op: string; body: string; action: string }[] = [];
const wsdl = () => `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns:SOAP-ENV="http://schemas.xmlsoap.org/soap/envelope/" xmlns:soap="http://schemas.xmlsoap.org/wsdl/soap/" xmlns:tns="urn:SMSWebService"
  xmlns="http://schemas.xmlsoap.org/wsdl/" targetNamespace="urn:SMSWebService">
<binding name="SMSWebServiceBinding" type="tns:SMSWebServicePortType"><soap:binding style="rpc" transport="http://schemas.xmlsoap.org/soap/http"/>
<operation name="sendSMS"><soap:operation soapAction="urn:SMSWebService#sendSMS" style="rpc"/></operation>
<operation name="getCredit"><soap:operation soapAction="urn:SMSWebService#getCredit" style="rpc"/></operation></binding>
<service name="SMSWebService"><port name="SMSWebServicePort" binding="tns:SMSWebServiceBinding"><soap:address location="${base}/APPs/SMS/WebService.php"/></port></service>
</definitions>`;
const reply = (op: string, type: string, v: string) =>
  `<?xml version="1.0" encoding="UTF-8"?><SOAP-ENV:Envelope xmlns:SOAP-ENV="http://schemas.xmlsoap.org/soap/envelope/" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><SOAP-ENV:Body><ns1:${op}Response xmlns:ns1="urn:SMSWebService"><return xsi:type="xsd:${type}">${v}</return></ns1:${op}Response></SOAP-ENV:Body></SOAP-ENV:Envelope>`;

beforeAll(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await seed();
  for (const u of ['admin', 'it', 'clerk']) {
    const r = await request(app).post('/api/auth/login').send({ identifier: u, password: SEED_PASSWORD });
    tokens[u] = r.body.accessToken;
  }
  await new Promise<void>((resolve) => {
    panel = createServer((req, res) => {
      if (req.method === 'GET' && req.url === '/APPs/SMS/WebService.php?wsdl') return res.writeHead(200, { 'content-type': 'text/xml' }).end(wsdl());
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const op = /<tns:(\w+)>/.exec(body)?.[1] ?? '';
        calls.push({ op, body, action: String(req.headers.soapaction) });
        const pass = /<password[^>]*>([^<]*)</.exec(body)?.[1];
        if (op === 'getCredit') return res.writeHead(200).end(reply(op, 'string', pass === 'secret-pass' ? '125000' : '-2'));
        if (op === 'sendSMS') return res.writeHead(200).end(reply(op, 'int', pass === 'secret-pass' ? '98765' : '-2'));
        res.writeHead(500).end('<SOAP-ENV:Envelope><SOAP-ENV:Body><SOAP-ENV:Fault><faultstring>unknown</faultstring></SOAP-ENV:Fault></SOAP-ENV:Body></SOAP-ENV:Envelope>');
      });
    }).listen(0, '127.0.0.1', () => {
      base = `http://127.0.0.1:${(panel.address() as AddressInfo).port}`;
      resolve();
    });
  });
});

afterAll(async () => {
  panel?.close();
  await pool.end();
});

describe('SOAP SMS panel helpers', () => {
  it('builds the WSDL address from the panel address', () => {
    expect(wsdlAddress('https://sms.example.ir')).toBe('https://sms.example.ir/APPs/SMS/WebService.php?wsdl');
    expect(wsdlAddress('https://sms.example.ir/APPs/SMS/WebService.php?wsdl')).toBe('https://sms.example.ir/APPs/SMS/WebService.php?wsdl');
    expect(wsdlAddress('http://p.example.ir/ws/send.php')).toBe('http://p.example.ir/ws/send.php?wsdl');
  });

  it('normalises Iranian mobile numbers', () => {
    expect(normalizeMobile('۰۹۱۲ ۳۴۵ ۶۷۸۹')).toBe('09123456789');
    expect(normalizeMobile('+989123456789')).toBe('09123456789');
    expect(normalizeMobile('00989123456789')).toBe('09123456789');
    expect(normalizeMobile('9123456789')).toBe('09123456789');
  });

  it('reads namespace, endpoint and actions from the WSDL and builds an rpc/encoded call', () => {
    base = base || 'http://x';
    const w = parseWsdl(wsdl(), `${base}/APPs/SMS/WebService.php?wsdl`);
    expect(w).toMatchObject({ ns: 'urn:SMSWebService', location: `${base}/APPs/SMS/WebService.php`, rpc: true });
    expect(w.actions.sendSMS).toBe('urn:SMSWebService#sendSMS');
    const env = soapEnvelope(w, 'sendSMS', [
      ['username', 'a&b'],
      ['to', ['09120000000']],
      ['isflash', 1],
    ]);
    expect(env).toContain('<username xsi:type="xsd:string">a&amp;b</username>');
    expect(env).toContain('SOAP-ENC:arrayType="xsd:string[1]"><item xsi:type="xsd:string">09120000000</item>');
    expect(env).toContain('<isflash xsi:type="xsd:int">1</isflash>');
    expect(soapResult(reply('sendSMS', 'int', '42'))).toBe('42');
    expect(() => soapResult('<Envelope><Body><Fault><faultstring>bad login</faultstring></Fault></Body></Envelope>')).toThrow(/bad login/);
  });
});

describe('SMS and e-mail settings in «یکپارچه‌سازی»', () => {
  it('only integration managers can read or change them', async () => {
    expect((await as('clerk').get('/api/integrations/sms')).status).toBe(403);
    expect((await as('clerk').put('/api/integrations/email', { host: 'x', from: 'a@b.ir' })).status).toBe(403);
    const r = await as('it').get('/api/integrations/sms');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ configured: false, provider: 'soap' });
    expect(r.body.providers.soap).toBeTruthy();
  });

  it('validates the SOAP panel fields', async () => {
    const r = await as('it').put('/api/integrations/sms', { provider: 'soap', sender: '3000123', username: 'u' });
    expect(r.status).toBe(400);
    const r2 = await as('it').put('/api/integrations/sms', { provider: 'soap', sender: '3000123', wsdlUrl: 'ftp://x', username: 'u' });
    expect(r2.status).toBe(400);
  });

  it('stores the panel password encrypted and never returns it', async () => {
    const r = await as('it').put('/api/integrations/sms', { provider: 'soap', wsdlUrl: base, domain: 'chamber.ir', username: 'rasa', secret: 'secret-pass', sender: '3000123' });
    expect(r.status).toBe(204);
    const g = await as('it').get('/api/integrations/sms');
    expect(g.body).toMatchObject({ configured: true, isActive: true, hasSecret: true, wsdlUrl: `${base}/APPs/SMS/WebService.php?wsdl`, domain: 'chamber.ir', username: 'rasa' });
    expect(JSON.stringify(g.body)).not.toContain('secret-pass');
    const row = (await pool.query(`SELECT client_secret_enc FROM integrations WHERE kind = 'sms'`)).rows[0];
    expect(row.client_secret_enc).toMatch(/^v1:/);
    expect(row.client_secret_enc).not.toContain('secret-pass');
  });

  it('test button reads the credit and sends one SMS through the panel', async () => {
    calls.length = 0;
    const r = await as('it').post('/api/integrations/sms/test', { to: '۰۹۱۲۱۱۱۲۲۳۳' });
    expect(r.body).toMatchObject({ credit: { ok: true, value: '125000' }, send: { ok: true, id: '98765' } });
    const send = calls.find((c) => c.op === 'sendSMS')!;
    expect(send.action).toBe('"urn:SMSWebService#sendSMS"');
    expect(send.body).toContain('<domain xsi:type="xsd:string">chamber.ir</domain>');
    expect(send.body).toContain('<from xsi:type="xsd:string">3000123</from>');
    expect(send.body).toContain('<item xsi:type="xsd:string">09121112233</item>');
    expect(send.body).toContain('<isflash xsi:type="xsd:int">1</isflash>');
  });

  it('keeps the stored password when it is not sent again, and reports panel errors in Persian', async () => {
    await as('it').put('/api/integrations/sms', { provider: 'soap', wsdlUrl: base, domain: 'chamber.ir', username: 'rasa', sender: '3000123', flash: true });
    const ok = await as('it').post('/api/integrations/sms/test', { to: '09121112233' });
    expect(ok.body.send.ok).toBe(true);
    expect(calls.at(-1)!.body).toContain('<isflash xsi:type="xsd:int">2</isflash>');
    await as('it').put('/api/integrations/sms', { provider: 'soap', wsdlUrl: base, domain: 'chamber.ir', username: 'rasa', sender: '3000123', secret: 'wrong' });
    const bad = await as('it').post('/api/integrations/sms/test', { to: '09121112233' });
    expect(bad.body.send).toMatchObject({ ok: false });
    expect(bad.body.send.error).toContain('نام کاربری یا کلمه عبور اشتباه است');
    await as('it').put('/api/integrations/sms', { provider: 'soap', wsdlUrl: base, domain: 'chamber.ir', username: 'rasa', sender: '3000123', secret: 'secret-pass' });
  });

  it('notification SMS jobs go through the configured panel; turning it off falls back to the log', async () => {
    calls.length = 0;
    await enqueue('sms.send', { to: '09125556677', text: 'ارجاع نامه ۱۲۳' });
    await drainJobs();
    expect(calls.some((c) => c.op === 'sendSMS' && c.body.includes('09125556677') && c.body.includes('ارجاع نامه ۱۲۳'))).toBe(true);

    await as('it').put('/api/integrations/sms', { provider: 'soap', wsdlUrl: base, domain: 'chamber.ir', username: 'rasa', sender: '3000123', isActive: false });
    calls.length = 0;
    await enqueue('sms.send', { to: '09125556678', text: 'غیرفعال' });
    await drainJobs();
    expect(calls).toHaveLength(0);
    expect(outbox.some((m) => m.channel === 'sms' && m.to === '09125556678')).toBe(true);
  });

  it('stores the mail server and reports a failed test send instead of throwing', async () => {
    const bad = await as('it').put('/api/integrations/email', { host: '127.0.0.1', port: 1, from: 'not-an-email' });
    expect(bad.status).toBe(400);
    const r = await as('it').put('/api/integrations/email', { host: '127.0.0.1', port: 1, user: 'rasa', password: 'mail-pass', from: 'no-reply@chamber.ir', fromName: 'رسا' });
    expect(r.status).toBe(204);
    const g = await as('it').get('/api/integrations/email');
    expect(g.body).toMatchObject({ configured: true, host: '127.0.0.1', port: 1, hasPassword: true, from: 'no-reply@chamber.ir' });
    expect(JSON.stringify(g.body)).not.toContain('mail-pass');
    const t = await as('it').post('/api/integrations/email/test', { to: 'me@chamber.ir' });
    expect(t.status).toBe(200);
    expect(t.body.ok).toBe(false);
    expect(t.body.error).toBeTruthy();
  });
});
