import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { config } from '../src/config.js';
import { pool } from '../src/db/pool.js';
import { seed, SEED_PASSWORD } from '../src/db/seed.js';
import '../src/integration/meetings.js';
import { drainJobs } from '../src/services/jobs.js';
import { outbox } from '../src/services/notifications.js';
import { runScheduledJobs } from '../src/services/scheduler.js';

const app = createApp();
const tokens: Record<string, string> = {};
const me: Record<string, any> = {};

export const as = (who: string) => ({
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

async function login(who: string) {
  const r = await request(app).post('/api/auth/login').send({ identifier: who, password: SEED_PASSWORD });
  expect(r.status, `login ${who}`).toBe(200);
  tokens[who] = r.body.accessToken;
  me[who] = (await as(who).get('/api/auth/me')).body;
}

const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF');
const png = (marker: string) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(marker)]);

beforeAll(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await seed();
  for (const u of ['admin', 'president', 'deputy', 'sechead', 'clerk', 'cmshead', 'cmsexpert', 'reshead', 'expert', 'it']) await login(u);
});

afterAll(async () => {
  await pool.end();
});

describe('authentication & users', () => {
  it('rejects bad credentials and anonymous calls; exposes roles and permissions', async () => {
    expect((await request(app).post('/api/auth/login').send({ identifier: 'clerk', password: 'nope' })).status).toBe(401);
    expect((await request(app).get('/api/letters')).status).toBe(401);
    expect(me.clerk.roles).toContain('secretariat');
    expect(me.clerk.permissions).toContain('letter.register_incoming');
    expect(me.cmsexpert.permissions).not.toContain('letter.register_incoming');
    expect(me.cmshead.positions[0].isManager).toBe(true);
  });

  it('refresh tokens rotate and reuse revokes the session family', async () => {
    const l = await request(app).post('/api/auth/login').send({ identifier: 'it', password: SEED_PASSWORD });
    const r1 = await request(app).post('/api/auth/refresh').send({ refreshToken: l.body.refreshToken });
    expect(r1.status).toBe(200);
    expect((await request(app).post('/api/auth/refresh').send({ refreshToken: l.body.refreshToken })).status).toBe(401);
    expect((await request(app).post('/api/auth/refresh').send({ refreshToken: r1.body.refreshToken })).status).toBe(401);
  });

  it('two-factor authentication (TOTP) is enforced at login once enabled', async () => {
    const { totp } = await import('../src/auth/totp.js');
    const setup = await as('it').post('/api/auth/mfa/setup');
    expect((await as('it').post('/api/auth/mfa/enable', { code: '000000' })).status).toBe(400);
    expect((await as('it').post('/api/auth/mfa/enable', { code: totp(setup.body.secret) })).status).toBe(204);
    const l = await request(app).post('/api/auth/login').send({ identifier: 'it', password: SEED_PASSWORD });
    expect(l.body.mfaRequired).toBe(true);
    expect(l.body.accessToken).toBeUndefined();
    const v = await request(app).post('/api/auth/mfa/verify').send({ mfaToken: l.body.mfaToken, code: totp(setup.body.secret) });
    expect(v.status).toBe(200);
    // The secret is stored encrypted.
    const row = await pool.query(`SELECT mfa_secret_enc FROM users WHERE username = 'it'`);
    expect(row.rows[0].mfa_secret_enc).not.toContain(setup.body.secret);
  });

  it('only user managers manage users; positions and scoped roles are assigned', async () => {
    const units = (await as('admin').get('/api/org/units')).body;
    const research = units.units.find((u: any) => u.code === 'RES');
    const pos = units.positions.find((p: any) => p.unit_id === research.id && !p.is_manager);
    const roles = (await as('admin').get('/api/roles')).body.roles;
    const expertRole = roles.find((r: any) => r.key === 'expert');
    const body = {
      username: 'new.expert', fullName: 'کارشناس جدید', password: 'Secret123', nationalId: '0012345678',
      positions: [{ positionId: pos.id, isPrimary: true }], roles: [{ roleId: expertRole.id }],
    };
    expect((await as('clerk').post('/api/users', body)).status).toBe(403);
    const r = await as('admin').post('/api/users', body);
    expect(r.status).toBe(201);
    expect((await as('admin').post('/api/users', body)).status).toBe(409);
    expect((await as('admin').post('/api/users', { ...body, username: 'weak', nationalId: null, password: 'abc' })).status).toBe(400);
  });
});

let incoming: any;

describe('correspondence (مکاتبات)', () => {
  it('secretariat registers an incoming letter with an indicator number, barcode and QR', async () => {
    const r = await as('clerk').post('/api/letters', {
      kind: 'incoming',
      subject: 'درخواست همكاري در برگزاري نمايشگاه صادراتي',
      body: 'با سلام، احتراماً درخواست همکاری در برگزاری نمایشگاه را داریم.',
      externalOrg: 'سازمان توسعه تجارت',
      externalNumber: '۱۲۳/الف',
      externalDate: '2026-10-10',
      register: true,
    });
    expect(r.status).toBe(201);
    incoming = r.body;
    expect(incoming.number).toMatch(/^و\/\d{4}\/00001$/);
    expect(incoming.tracking_code).toMatch(/^\d{12}$/);
    const r2 = await as('clerk').post('/api/letters', { kind: 'incoming', subject: 'نامه دوم', externalOrg: 'وزارت صمت', register: true });
    expect(r2.body.number).toMatch(/\/00002$/);
    const bc = await as('clerk').get(`/api/letters/${incoming.id}/barcode.svg`);
    expect(bc.headers['content-type']).toContain('image/svg+xml');
    expect(String(bc.body)).toContain(incoming.tracking_code);
    const qr = await as('clerk').get(`/api/letters/${incoming.id}/qr.svg`);
    expect(String(qr.body)).toContain('<svg');
    const lookup = await as('clerk').get(`/api/letters/lookup/${incoming.tracking_code}`);
    expect(lookup.body.id).toBe(incoming.id);
    // Public verification for the QR code.
    const v = await request(app).get(`/api/verify/${incoming.tracking_code}`);
    expect(v.status).toBe(200);
    expect(v.body.number).toBe(incoming.number);
  });

  it('only the secretariat records incoming letters', async () => {
    expect((await as('cmsexpert').post('/api/letters', { kind: 'incoming', subject: 'تست ثبت', externalOrg: 'x' })).status).toBe(403);
  });

  it('finds letters with Persian full-text search (Arabic/Persian letters and digits normalised)', async () => {
    const r = await as('clerk').get(`/api/letters?q=${encodeURIComponent('همکاری نمایشگاه')}`);
    expect(r.body.items.map((x: any) => x.id)).toContain(incoming.id);
    const n = await as('clerk').get(`/api/letters?number=${encodeURIComponent('۱۲۳')}`);
    expect(n.body.items.map((x: any) => x.id)).toContain(incoming.id);
    const none = await as('clerk').get(`/api/letters?q=${encodeURIComponent('قرارداد')}`);
    expect(none.body.items.map((x: any) => x.id)).not.toContain(incoming.id);
  });

  it('a letter is visible only to participants until it is referred', async () => {
    expect((await as('expert').get(`/api/letters/${incoming.id}`)).status).toBe(404);
    const list = await as('expert').get('/api/letters');
    expect(list.body.items.map((x: any) => x.id)).not.toContain(incoming.id);
    const r = await as('clerk').post(`/api/letters/${incoming.id}/routes`, {
      targets: [{ positionId: me.reshead.positions[0].positionId, action: 'refer', instruction: 'جهت بررسی و اقدام' }],
    });
    expect(r.status).toBe(201);
    const cart = await as('reshead').get('/api/cartable');
    const item = cart.body.find((x: any) => x.letter_id === incoming.id);
    expect(item.action).toBe('refer');
    expect((await as('reshead').get(`/api/letters/${incoming.id}`)).status).toBe(200);
    // Manager refers on to the expert and closes own referral.
    await as('reshead').post(`/api/letters/${incoming.id}/routes`, { targets: [{ userId: me.expert.id, action: 'review', instruction: 'بررسی کارشناسی' }], completeMine: true });
    expect((await as('reshead').get('/api/cartable')).body.some((x: any) => x.letter_id === incoming.id)).toBe(false);
    const exp = (await as('expert').get('/api/cartable')).body.find((x: any) => x.letter_id === incoming.id);
    expect(exp).toBeTruthy();
    const done = await as('expert').patch(`/api/routes/${exp.routing_id}`, { status: 'done', response: 'بررسی شد؛ همکاری بلامانع است' });
    expect(done.status).toBe(200);
    const detail = await as('expert').get(`/api/letters/${incoming.id}`);
    expect(detail.body.routing).toHaveLength(2);
    expect(detail.body.routing[1].response).toContain('بلامانع');
    // Notification to the referral target.
    const n = await as('reshead').get('/api/notifications');
    expect(n.body.items.some((x: any) => x.event === 'routing.assigned')).toBe(true);
  });

  it('confidential letters follow the clearance attribute (ABAC)', async () => {
    const r = await as('sechead').post('/api/letters', { kind: 'incoming', subject: 'نامه محرمانه', externalOrg: 'نهاد', confidentiality: 1, register: true });
    expect(r.status).toBe(201);
    // clerk (secretariat read_all) has clearance 0 → not visible; president (clearance 2, read_all) → visible.
    expect((await as('clerk').get(`/api/letters/${r.body.id}`)).status).toBe(404);
    expect((await as('president').get(`/api/letters/${r.body.id}`)).status).toBe(200);
    expect((await as('clerk').post('/api/letters', { kind: 'incoming', subject: 'سری', externalOrg: 'x', confidentiality: 2 })).status).toBe(403);
    // Public verification hides the subject.
    const v = await request(app).get(`/api/verify/${r.body.tracking_code}`);
    expect(v.body.subject).toBeNull();
  });

  it('stores attachments encrypted, with versions', async () => {
    const a = await as('clerk').upload(`/api/letters/${incoming.id}/attachments`, { title: 'اسکن نامه', source: 'scan' }, PDF, 'اسکن.pdf');
    expect(a.status).toBe(201);
    const v2 = await as('clerk').upload(`/api/letters/${incoming.id}/attachments`, { groupId: a.body.group_id }, Buffer.concat([PDF, Buffer.from('v2')]), 'اسکن.pdf');
    expect(v2.body.version).toBe(2);
    const dl = await as('clerk').get(`/api/letters/${incoming.id}/attachments/${a.body.id}/download`);
    expect(Buffer.from(dl.body).equals(PDF)).toBe(true);
    // On disk the file is ciphertext.
    const key = (await pool.query('SELECT storage_key FROM letter_attachments WHERE id = $1', [a.body.id])).rows[0].storage_key;
    const raw = await readFile(path.join(config.storageDir, key));
    expect(raw.subarray(0, 4).toString()).not.toBe('%PDF');
    expect((await as('clerk').upload(`/api/letters/${incoming.id}/attachments`, {}, Buffer.from('MZ'), 'virus.exe')).status).toBe(400);
    expect((await as('clerk').upload(`/api/letters/${incoming.id}/attachments`, {}, Buffer.from('not a pdf'), 'x.pdf')).status).toBe(400);
  });
});

describe('letter intake (ایمیل / اسکن / API)', () => {
  it('an intake gateway posts an incoming letter with attachments into the secretariat cartable', async () => {
    const payload = { subject: 'نامه دریافتی از ایمیل دبیرخانه', externalOrg: 'شرکت نمونه', source: 'email', attachments: [{ fileName: 'scan.pdf', contentBase64: PDF.toString('base64') }] };
    expect((await request(app).post('/api/intake/letters').set('x-api-key', 'oai_wrong').send(payload)).status).toBe(401);
    expect((await as('clerk').put('/api/integrations/intake', { rotateKey: true })).status).toBe(403);
    const k = await as('admin').put('/api/integrations/intake', { rotateKey: true });
    expect(k.body.apiKey).toMatch(/^oai_/);
    const r = await request(app).post('/api/intake/letters').set('x-api-key', k.body.apiKey).send(payload);
    expect(r.status).toBe(201);
    const l = (await as('clerk').get(`/api/letters/${r.body.id}`)).body;
    expect(l).toMatchObject({ kind: 'incoming', status: 'draft', source: 'email' });
    expect(l.attachments).toHaveLength(1);
    expect((await as('clerk').get('/api/cartable')).body.some((x: any) => x.letter_id === r.body.id)).toBe(true);
    // The secretariat checks it and registers it.
    expect((await as('clerk').post(`/api/letters/${r.body.id}/register`)).body.number).toMatch(/^و\//);
  });
});

describe('specimen signatures (نمونه امضا)', () => {
  it('the secretariat registers signatures; the image in use is captured with each digital signature', async () => {
    const first = png('president-v1');
    // Only the person themself or the secretariat (signatures.manage) registers a specimen.
    expect((await as('expert').upload(`/api/users/${me.president.id}/signature`, {}, first, 'sign.png')).status).toBe(403);
    expect((await as('clerk').upload(`/api/users/${me.president.id}/signature`, {}, Buffer.from('not an image'), 'sign.png')).status).toBe(400);
    expect((await as('clerk').upload(`/api/users/${me.president.id}/signature`, {}, PDF, 'sign.pdf')).status).toBe(400);
    expect((await as('clerk').upload(`/api/users/${me.president.id}/signature`, {}, first, 'sign.png')).status).toBe(204);
    expect((await as('expert').upload(`/api/users/${me.expert.id}/signature`, {}, png('expert'), 'mine.png')).status).toBe(204);
    expect((await as('expert').get('/api/auth/me')).body.has_signature).toBe(true);
    expect((await as('expert').get('/api/signatures')).status).toBe(403);
    expect((await as('cmsexpert').get(`/api/users/${me.expert.id}/signature`)).status).toBe(403);
    const list = await as('clerk').get('/api/signatures?q=' + encodeURIComponent(me.president.full_name));
    expect(list.body.items[0]).toMatchObject({ id: me.president.id, has_signature: true, can_sign: true, signature_updated_by: me.clerk.full_name });

    // President signs a numbered letter: the specimen is stored with the signature.
    const l = (await as('president').post('/api/letters', { kind: 'outgoing', subject: 'نامه آزمایشی امضا', body: 'متن', externalOrg: 'سازمان نمونه' })).body;
    await as('president').post(`/api/letters/${l.id}/routes`, { targets: [{ userId: me.clerk.id, action: 'refer', instruction: 'شماره شود' }] });
    expect((await as('clerk').post(`/api/letters/${l.id}/register`)).status).toBe(200);
    const sig = await as('president').post(`/api/letters/${l.id}/sign`);
    expect(sig.status).toBe(201);
    let d = (await as('clerk').get(`/api/letters/${l.id}`)).body;
    expect(d.signatures[0]).toMatchObject({ has_image: true, valid: true, intact: true });
    expect(d.signatures[0].image_key).toBeUndefined();
    const img = await as('clerk').get(`/api/letters/${l.id}/signatures/${sig.body.id}/image`);
    expect(img.status).toBe(200);
    expect(img.headers['content-type']).toBe('image/png');
    expect(Buffer.from(img.body).equals(first)).toBe(true);
    // Replacing the specimen later does not change the already-signed letter.
    expect((await as('clerk').upload(`/api/users/${me.president.id}/signature`, {}, png('president-v2'), 'new.png')).status).toBe(204);
    const again = await as('clerk').get(`/api/letters/${l.id}/signatures/${sig.body.id}/image`);
    expect(Buffer.from(again.body).equals(first)).toBe(true);
    // A person who cannot see the letter cannot fetch its signature image.
    expect((await as('reshead').get(`/api/letters/${l.id}/signatures/${sig.body.id}/image`)).status).toBe(404);
    expect((await as('expert').post(`/api/users/${me.expert.id}/signature`)).status).toBe(400);
    d = (await as('expert').get('/api/auth/me')).body;
    expect(d.has_signature).toBe(true);
    expect((await request(app).delete(`/api/users/${me.expert.id}/signature`).set('authorization', `Bearer ${tokens.expert}`)).status).toBe(204);
    expect((await as('expert').get('/api/auth/me')).body.has_signature).toBe(false);
  });
});

describe('letter templates and rich-text letters (قالب و سربرگ نامه)', () => {
  const del = (who: string, url: string) => request(app).delete(url).set('authorization', `Bearer ${tokens[who]}`);

  it('the secretariat maintains letterheads; everyone reads them', async () => {
    const list = await as('expert').get('/api/letter-templates');
    expect(list.status).toBe(200);
    const builtIn = list.body.find((t: any) => t.is_default);
    expect(builtIn).toMatchObject({ name: 'سربرگ رسمی اتاق', page_size: 'A4', kinds: ['outgoing', 'internal'] });
    expect((await as('expert').post('/api/letter-templates', { name: 'قالب من' })).status).toBe(403);

    const t = await as('clerk').post('/api/letter-templates', {
      name: 'سربرگ معاونت',
      kinds: ['outgoing'],
      orgSubtitle: 'معاونت امور اعضا',
      footerText: 'تهران، خیابان طالقانی',
      marginTop: 40,
      bodyHtml: '<p onclick="x()">با سلام<script>alert(1)</script></p>',
      isDefault: true,
    });
    expect(t.status).toBe(201);
    expect(t.body).toMatchObject({ is_default: true, margin_top: 40, body_html: '<p>با سلام</p>', has_logo: false });
    // Only one default at a time.
    expect((await as('expert').get(`/api/letter-templates/${builtIn.id}`)).body.is_default).toBe(false);
    expect((await as('clerk').upload(`/api/letter-templates/${t.body.id}/logo`, {}, PDF, 'logo.pdf')).status).toBe(400);
    expect((await as('clerk').upload(`/api/letter-templates/${t.body.id}/logo`, {}, png('logo'), 'logo.png')).status).toBe(204);
    const logo = await as('expert').get(`/api/letter-templates/${t.body.id}/logo`);
    expect(logo.status).toBe(200);
    expect(Buffer.from(logo.body).equals(png('logo'))).toBe(true);
    expect((await as('expert').get(`/api/letter-templates/${t.body.id}/background`)).status).toBe(404);
    expect((await as('clerk').patch(`/api/letter-templates/${t.body.id}`, { isDefault: false, orgSubtitle: null })).body).toMatchObject({ org_subtitle: null, has_logo: true });
    await as('clerk').patch(`/api/letter-templates/${builtIn.id}`, { isDefault: true });

    // An unused template is deleted; a used one is only deactivated.
    const spare = (await as('clerk').post('/api/letter-templates', { name: 'قالب یک‌بارمصرف' })).body;
    expect((await del('clerk', `/api/letter-templates/${spare.id}`)).body.outcome).toBe('deleted');
    await as('expert').post('/api/letters', { kind: 'outgoing', subject: 'نامه با سربرگ معاونت', externalOrg: 'سازمان', templateId: t.body.id });
    expect((await del('clerk', `/api/letter-templates/${t.body.id}`)).body.outcome).toBe('deactivated');
    expect((await as('expert').get('/api/letter-templates')).body.some((x: any) => x.id === t.body.id)).toBe(false);
    expect((await as('clerk').get('/api/letter-templates?all=1')).body.some((x: any) => x.id === t.body.id)).toBe(true);
    // A deactivated template cannot be chosen for new letters.
    expect((await as('expert').post('/api/letters', { kind: 'outgoing', subject: 'نامه دیگر', externalOrg: 'سازمان', templateId: t.body.id })).status).toBe(400);
  });

  it('a letter typed on the letterhead is signed by its signatory, then numbered, and is locked', async () => {
    const builtIn = (await as('expert').get('/api/letter-templates')).body.find((x: any) => x.is_default);
    // Signatory must be able to sign; incoming letters take no letterhead.
    expect((await as('expert').post('/api/letters', { kind: 'outgoing', subject: 'نامه', externalOrg: 'سازمان', signatoryId: me.clerk.id })).status).toBe(400);
    expect((await as('clerk').post('/api/letters', { kind: 'incoming', subject: 'نامه وارده', externalOrg: 'سازمان', templateId: builtIn.id })).status).toBe(400);

    const created = await as('expert').post('/api/letters', {
      kind: 'outgoing',
      subject: 'درخواست همکاری در همایش صادرات',
      externalOrg: 'وزارت صنعت، معدن و تجارت',
      externalParty: 'جناب آقای محمدی',
      bodyFormat: 'html',
      body: '<p style="text-align: justify; position: fixed">احتراماً <strong>همایش صادرات</strong> برگزار می‌شود.</p><img src=x onerror="alert(1)"><table><tr><td>یک</td></tr></table>',
      templateId: builtIn.id,
      signatoryId: me.president.id,
    });
    expect(created.status).toBe(201);
    const l = created.body;
    expect(l).toMatchObject({ body_format: 'html', template_id: builtIn.id, signatory_id: me.president.id });
    expect(l.body).toContain('<p style="text-align:justify">احتراماً <strong>همایش صادرات</strong>');
    expect(l.body).toContain('<table>');
    expect(l.body).not.toMatch(/img|onerror|position/);
    // Search reads the text, not the markup.
    expect((await as('expert').get('/api/letters?q=' + encodeURIComponent('همایش صادرات'))).body.items.some((x: any) => x.id === l.id)).toBe(true);
    expect((await as('expert').get('/api/letters?q=strong')).body.items.some((x: any) => x.id === l.id)).toBe(false);

    let d = (await as('expert').get(`/api/letters/${l.id}`)).body;
    expect(d).toMatchObject({ signatory_name: me.president.full_name, lockReason: null });
    expect(d.my.canEdit).toBe(true);
    await as('expert').post(`/api/letters/${l.id}/routes`, { targets: [{ userId: me.president.id, action: 'sign', instruction: 'امضا' }, { userId: me.deputy.id, action: 'info' }] });
    // Only the designated signatory signs, and before numbering.
    expect((await as('president').get(`/api/letters/${l.id}`)).body.my.canSign).toBe(true);
    expect((await as('deputy').get(`/api/letters/${l.id}`)).body.my.canSign).toBe(false);
    expect((await as('deputy').post(`/api/letters/${l.id}/sign`)).status).toBe(403);
    expect((await as('president').post(`/api/letters/${l.id}/sign`)).status).toBe(201);
    d = (await as('expert').get(`/api/letters/${l.id}`)).body;
    expect(d.status).toBe('signed');
    expect(d.lockReason).toBeTruthy();
    expect(d.my.canEdit).toBe(false);
    expect((await as('expert').patch(`/api/letters/${l.id}`, { subject: 'تغییر بعد از امضا' })).status).toBe(409);
    expect((await as('expert').upload(`/api/letters/${l.id}/attachments`, {}, PDF, 'late.pdf')).status).toBe(409);
    // Numbering after signing keeps the signature intact.
    const reg = await as('clerk').post(`/api/letters/${l.id}/register`);
    expect(reg.status).toBe(200);
    expect(reg.body.status).toBe('signed');
    d = (await as('clerk').get(`/api/letters/${l.id}`)).body;
    expect(d.signatures[0]).toMatchObject({ valid: true, intact: true, user_id: me.president.id });
    const v = await request(app).get(`/api/verify/${d.tracking_code}`);
    expect(v.body.signatures[0]).toMatchObject({ valid: true, intact: true });
    expect((await as('clerk').post(`/api/letters/${l.id}/send`, { deliveryMethod: 'پست' })).body.status).toBe('sent');
    expect((await as('clerk').patch(`/api/letters/${l.id}`, { subject: 'تغییر بعد از ارسال' })).status).toBe(409);

    // A numbered internal letter is final even before it is signed.
    const internal = (await as('expert').post('/api/letters', { kind: 'internal', subject: 'نامه داخلی شماره‌شده', body: 'متن', register: true })).body;
    expect(internal.number).toBeTruthy();
    const p = await as('expert').patch(`/api/letters/${internal.id}`, { body: 'متن تازه' });
    expect(p.status).toBe(409);
    expect(p.body.error.message).toBe('نامه شماره‌شده قابل ویرایش نیست');
  });
});

describe('workflow engine (گردش کار)', () => {
  let outgoing: any;

  it('runs a multi-step approval: manager → president signature → send', async () => {
    const r = await as('cmsexpert').post('/api/letters', {
      kind: 'outgoing',
      subject: 'دعوت از وزارت صمت برای جلسه کمیسیون',
      body: 'متن دعوت‌نامه',
      externalOrg: 'وزارت صنعت، معدن و تجارت',
    });
    expect(r.status).toBe(201);
    outgoing = r.body;
    // Expert cannot number outgoing letters; the secretariat does.
    expect((await as('cmsexpert').post(`/api/letters/${outgoing.id}/register`)).status).toBe(403);
    await as('cmsexpert').post(`/api/letters/${outgoing.id}/routes`, { targets: [{ userId: me.clerk.id, action: 'refer', instruction: 'لطفاً شماره شود' }] });
    const reg = await as('clerk').post(`/api/letters/${outgoing.id}/register`);
    expect(reg.body.number).toMatch(/^ص\//);
    const wf = await as('cmsexpert').post(`/api/letters/${outgoing.id}/workflow`, { definition: 'outgoing-approval' });
    expect(wf.status).toBe(201);
    // Step 1: the initiator's manager (cmshead).
    let d = (await as('cmshead').get(`/api/letters/${outgoing.id}`)).body;
    expect(d.my.steps).toHaveLength(1);
    expect((await as('reshead').post(`/api/workflow-steps/${d.my.steps[0]}/act`, { decision: 'approve' })).status).toBe(403);
    expect((await as('cmshead').post(`/api/workflow-steps/${d.my.steps[0]}/act`, { decision: 'approve', comment: 'تأیید' })).status).toBe(200);
    // Step 2: president signs (role assignee); sending before the end of the workflow is blocked.
    expect((await as('clerk').post(`/api/letters/${outgoing.id}/send`)).status).toBe(409);
    d = (await as('president').get(`/api/letters/${outgoing.id}`)).body;
    expect(d.my.steps).toHaveLength(1);
    expect((await as('president').post(`/api/workflow-steps/${d.my.steps[0]}/act`, { decision: 'approve' })).status).toBe(200);
    d = (await as('president').get(`/api/letters/${outgoing.id}`)).body;
    expect(d.status).toBe('signed');
    expect(d.workflows[0].status).toBe('completed');
    expect(d.signatures).toHaveLength(1);
    expect(d.signatures[0]).toMatchObject({ valid: true, intact: true });
    // Signed letters cannot be edited.
    expect((await as('cmsexpert').patch(`/api/letters/${outgoing.id}`, { subject: 'تغییر' })).status).toBe(409);
    const sent = await as('clerk').post(`/api/letters/${outgoing.id}/send`, { deliveryMethod: 'پست' });
    expect(sent.body.status).toBe('sent');
    const v = await request(app).get(`/api/verify/${outgoing.tracking_code}`);
    expect(v.body.signatures[0]).toMatchObject({ valid: true, intact: true, signer: me.president.full_name });
  });

  it('rejection returns to the configured step; tampering is detected by the signature', async () => {
    const r = await as('cmsexpert').post('/api/letters', { kind: 'outgoing', subject: 'نامه دوم صادره', externalOrg: 'اتاق ایران' });
    await as('cmsexpert').post(`/api/letters/${r.body.id}/routes`, { targets: [{ userId: me.clerk.id }] });
    await as('clerk').post(`/api/letters/${r.body.id}/register`);
    await as('cmsexpert').post(`/api/letters/${r.body.id}/workflow`, { definition: 'outgoing-approval' });
    let d = (await as('cmshead').get(`/api/letters/${r.body.id}`)).body;
    await as('cmshead').post(`/api/workflow-steps/${d.my.steps[0]}/act`, { decision: 'approve' });
    d = (await as('president').get(`/api/letters/${r.body.id}`)).body;
    expect((await as('president').post(`/api/workflow-steps/${d.my.steps[0]}/act`, { decision: 'reject' })).status).toBe(400);
    await as('president').post(`/api/workflow-steps/${d.my.steps[0]}/act`, { decision: 'reject', comment: 'متن اصلاح شود' });
    d = (await as('cmshead').get(`/api/letters/${r.body.id}`)).body;
    expect(d.workflows[0].status).toBe('running');
    expect(d.my.steps).toHaveLength(1); // back at the manager step
    expect(d.workflows[0].steps.map((s: any) => s.status)).toEqual(['approved', 'rejected', 'active']);

    // Tamper with a signed letter directly in the database → signature no longer intact.
    await pool.query(`UPDATE letters SET body = 'متن دستکاری‌شده' WHERE id = $1`, [outgoing_id()]);
    const t = (await as('president').get(`/api/letters/${outgoing_id()}`)).body;
    expect(t.signatures[0]).toMatchObject({ valid: true, intact: false });
  });

  function outgoing_id() {
    return outgoing.id;
  }

  it('versioned definitions, conditions, reminders and escalation on SLA breach', async () => {
    expect((await as('cmsexpert').post('/api/workflows', { key: 'x', name: 'x', definition: { steps: [] } })).status).toBe(403);
    const bad = await as('admin').post('/api/workflows', {
      key: 'sla-test', name: 'تست', definition: { steps: [{ key: 'a', name: 'گام', type: 'review', assignee: { kind: 'user' } }] },
    });
    expect(bad.status).toBe(400);
    const def = {
      key: 'sla-test',
      name: 'تست مهلت',
      appliesTo: ['internal'],
      definition: {
        steps: [
          { key: 'urgent_only', name: 'فقط فوری', type: 'review', assignee: { kind: 'user', value: me.president.id }, condition: { field: 'priority', op: 'eq', value: 'urgent' } },
          { key: 'review', name: 'بررسی کارشناس', type: 'review', assignee: { kind: 'user', value: me.cmsexpert.id }, slaHours: 10 },
        ],
      },
    };
    const v1 = await as('admin').post('/api/workflows', def);
    expect(v1.body.version).toBe(1);
    const v2 = await as('admin').post('/api/workflows', { ...def, name: 'تست مهلت (نسخه ۲)' });
    expect(v2.body.version).toBe(2);
    const hist = await as('admin').get('/api/workflows/sla-test');
    expect(hist.body.versions.map((v: any) => [v.version, v.is_active])).toEqual([[2, true], [1, false]]);

    const l = await as('cmsexpert').post('/api/letters', { kind: 'internal', subject: 'نامه داخلی تست مهلت', recipients: [{ userId: me.cmshead.id }], register: true, workflow: 'sla-test' });
    expect(l.status).toBe(201);
    let d = (await as('cmsexpert').get(`/api/letters/${l.body.id}`)).body;
    expect(d.workflows[0].definition_version).toBe(2);
    expect(d.workflows[0].steps.map((s: any) => s.status)).toEqual(['skipped', 'active']);
    // Reminder when 80% of the SLA has passed.
    await pool.query(`UPDATE workflow_steps SET created_at = now() - interval '9 hours', due_at = now() + interval '1 hour' WHERE status = 'active' AND name = 'بررسی کارشناس'`);
    let s = await runScheduledJobs();
    expect(s.reminded).toBeGreaterThanOrEqual(1);
    // SLA passed → escalated to the expert's manager (cmshead position).
    await pool.query(`UPDATE workflow_steps SET due_at = now() - interval '1 minute' WHERE status = 'active' AND name = 'بررسی کارشناس'`);
    s = await runScheduledJobs();
    expect(s.escalated).toBe(1);
    d = (await as('cmshead').get(`/api/letters/${l.body.id}`)).body;
    expect(d.my.steps).toHaveLength(1);
    const notes = (await as('cmshead').get('/api/notifications')).body.items;
    expect(notes.some((n: any) => n.event === 'workflow.escalated')).toBe(true);
    expect((await as('cmsexpert').get(`/api/letters/${l.body.id}`)).body.my.steps).toHaveLength(0);
    expect((await as('cmshead').post(`/api/workflow-steps/${d.my.steps[0]}/act`, { decision: 'approve' })).status).toBe(200);
    expect((await as('cmshead').get(`/api/letters/${l.body.id}`)).body.status).toBe('approved');
    // E-mail notifications went through the queue.
    await drainJobs();
    expect(outbox.some((m) => m.channel === 'email' && m.to === 'secretary@kx.local')).toBe(true);
  });
});

describe('archive (بایگانی و اسناد)', () => {
  it('archives a letter into the unit folder with its retention policy', async () => {
    const r = await as('clerk').post(`/api/letters/${incoming.id}/archive`);
    expect(r.status).toBe(201);
    expect(r.body.retention_until).toBeTruthy();
    const l = (await as('clerk').get(`/api/letters/${incoming.id}`)).body;
    expect(l.status).toBe('archived');
    expect(l.document.id).toBe(r.body.id);
    const folders = (await as('clerk').get('/api/archive/folders')).body;
    expect(folders.find((f: any) => f.id === r.body.folder_id)).toBeTruthy();
  });

  it('document versions, signatures, legal hold and disposal (امحا)', async () => {
    const folders = (await as('clerk').get('/api/archive/folders')).body;
    const contracts = folders.find((f: any) => f.name === 'قراردادهای ۱۴۰۵');
    const d = await as('clerk').upload('/api/archive/documents', { folderId: contracts.id, title: 'قرارداد پشتیبانی نرم‌افزار' }, PDF, 'قرارداد.pdf');
    expect(d.status).toBe(201);
    expect(d.body.retention_until).toMatch(/^\d{4}-/);
    const v2 = await as('clerk').upload(`/api/archive/documents/${d.body.id}/versions`, { note: 'الحاقیه' }, Buffer.concat([PDF, Buffer.from('2')]), 'قرارداد-v2.pdf');
    expect(v2.body.version).toBe(2);
    const sig = await as('president').post(`/api/archive/versions/${v2.body.id}/sign`);
    expect(sig.status).toBe(201);
    let doc = (await as('president').get(`/api/archive/documents/${d.body.id}`)).body;
    expect(doc.versions).toHaveLength(2);
    expect(doc.signatures[0]).toMatchObject({ valid: true, intact: true, version: 2 });
    const search = await as('clerk').get(`/api/archive/documents?q=${encodeURIComponent('قرارداد پشتیبانی')}`);
    expect(search.body.items.map((x: any) => x.id)).toContain(d.body.id);

    // Not yet due → disposal refused; legal hold blocks even forced disposal.
    expect((await as('admin').post(`/api/archive/documents/${d.body.id}/dispose`, { reason: 'پایان قرارداد' })).status).toBe(409);
    expect((await as('clerk').post(`/api/archive/documents/${d.body.id}/dispose`, { reason: 'پایان قرارداد', force: true })).status).toBe(403);
    await as('admin').patch(`/api/archive/documents/${d.body.id}`, { legalHold: true });
    expect((await as('admin').post(`/api/archive/documents/${d.body.id}/dispose`, { reason: 'پایان قرارداد', force: true })).status).toBe(409);
    await as('admin').patch(`/api/archive/documents/${d.body.id}`, { legalHold: false });
    await pool.query(`UPDATE documents SET retention_until = current_date - 1 WHERE id = $1`, [d.body.id]);
    const due = await as('admin').get('/api/archive/documents?due=true');
    expect(due.body.items.map((x: any) => x.id)).toContain(d.body.id);
    const disp = await as('admin').post(`/api/archive/documents/${d.body.id}/dispose`, { reason: 'پایان دوره نگهداری' });
    expect(disp.status).toBe(200);
    doc = (await as('admin').get(`/api/archive/documents/${d.body.id}`)).body;
    expect(doc.status).toBe('disposed');
    expect(doc.versions.every((v: any) => !v.available)).toBe(true);
    expect((await as('admin').get(`/api/archive/versions/${v2.body.id}/download`)).status).toBe(409);
  });
});

describe('reports & audit', () => {
  it('dashboard KPIs and Excel export', async () => {
    expect((await as('cmsexpert').get('/api/reports/dashboard')).status).toBe(403);
    const r = await as('president').get('/api/reports/dashboard');
    expect(r.status).toBe(200);
    expect(r.body.letters.byKind.incoming).toBeGreaterThanOrEqual(2);
    expect(r.body.routing.done).toBeGreaterThanOrEqual(1);
    expect(Number(r.body.routing.avg_response_hours)).toBeGreaterThanOrEqual(0);
    expect(r.body.units.length).toBeGreaterThan(3);
    const x = await as('president').get('/api/reports/export?report=units&format=xlsx').buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(x.status).toBe(200);
    expect((x.body as Buffer).subarray(0, 2).toString()).toBe('PK');
    const csv = await as('president').get('/api/reports/export?report=letters&format=csv');
    expect(csv.text.charCodeAt(0)).toBe(0xfeff);
  });

  it('keeps a tamper-evident audit chain', async () => {
    const v = await as('admin').get('/api/audit/verify');
    expect(v.body.brokenAt).toBeNull();
    expect(v.body.count).toBeGreaterThan(20);
    await expect(pool.query(`UPDATE audit_logs SET action = 'x' WHERE id = 1`)).rejects.toThrow(/append-only/);
    expect((await as('clerk').get('/api/audit')).status).toBe(403);
  });

  it('exposes health and Prometheus metrics', async () => {
    expect((await request(app).get('/health')).body.ok).toBe(true);
    const m = await request(app).get('/metrics');
    expect(m.text).toContain('http_requests_total');
  });
});

void readdir;
