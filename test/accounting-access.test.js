// Platform commission, doctor/clinic accounting and payouts; staff roles & permissions;
// disabling users; login history and activity.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, randomNationalId } from './helpers.js';
import { DEMO_ACCOUNTS } from '../src/seed.js';
import { normalizeSheba } from '../src/modules/accounting.js';

let t;
let admin;
before(async () => { t = await startApp({ disableSweeper: true }); admin = await t.login(DEMO_ACCOUNTS.admin.phone); });
after(() => t.close());

test('Sheba (IBAN) validation', () => {
  assert.equal(normalizeSheba('IR06 2960 0000 0010 0324 2000 01'), 'IR062960000000100324200001');
  assert.equal(normalizeSheba('062960000000100324200001'), 'IR062960000000100324200001');
  assert.equal(normalizeSheba('IR062960000000100324200002'), null);
  assert.equal(normalizeSheba('IR12'), null);
});

async function paidVisit(patient, doctorPhone, specialty, key) {
  const [slot] = (await t.call('GET', `/v1/slots?specialty=${specialty}&limit=5`, { token: patient.token })).body.items;
  const a = (await t.call('POST', '/v1/appointments', { token: patient.token, headers: { 'Idempotency-Key': key }, body: { doctor_id: slot.doctor_id, slot_id: slot.id, channel: 'video' } })).body;
  const st = await t.call('POST', `/v1/payments/${a.payment.id}/start`, { token: patient.token, body: {} });
  await fetch(`${t.base}/v1/payments/callback?Authority=${st.body.authority}&Status=OK`);
  return a;
}

test('commission split, doctor accounting (earned vs pending), clinic totals, payouts, CSV', async () => {
  // 20% platform commission on a 1,000,000 Rial (100,000 Toman) video visit.
  const s = await t.call('PUT', '/v1/admin/settings', { token: admin, body: { tariffs: { visit_video: 1_000_000, triage: 0 }, commission_percent: 20 } });
  assert.equal(s.body.commission_percent, 20);
  assert.equal((await t.call('PUT', '/v1/admin/settings', { token: admin, body: { commission_percent: 120 } })).status, 422);

  const p = await t.newPatient({ nationalId: randomNationalId() });
  const doc = await t.login(DEMO_ACCOUNTS.doctors[7].phone); // neurology
  const a1 = await paidVisit(p, DEMO_ACCOUNTS.doctors[7].phone, 'neurology', 'acc-1');
  const a2 = await paidVisit(p, DEMO_ACCOUNTS.doctors[7].phone, 'neurology', 'acc-2');
  const pay = (await t.call('GET', `/v1/payments/${a1.payment.id}`, { token: p.token })).body;
  assert.deepEqual([pay.commission_percent, pay.platform_amount, pay.doctor_amount], [20, 200_000, 800_000]);

  // One visit done, one still ahead.
  await t.call('POST', `/v1/consultations/${a1.consultation.id}/end`, { token: doc, body: {} });
  let mine = (await t.call('GET', '/v1/doctors/me/accounting', { token: doc })).body;
  assert.deepEqual(mine.overall, { earned: 800_000, pending: 800_000, paid_out: 0, balance: 800_000 });
  assert.equal(mine.period.commission, 200_000);
  assert.equal(mine.items.length, 2);

  assert.equal((await t.call('PUT', '/v1/doctors/me/sheba', { token: doc, body: { sheba: 'IR000000' } })).body.code, 'invalid_sheba');
  assert.equal((await t.call('PUT', '/v1/doctors/me/sheba', { token: doc, body: { sheba: 'IR062960000000100324200001' } })).status, 200);

  const acc = (await t.call('GET', '/v1/admin/accounting', { token: admin })).body;
  assert.equal(acc.totals.platform_commission, 200_000);
  assert.equal(acc.totals.doctors_share_earned, 800_000);
  assert.equal(acc.totals.doctors_share_pending, 800_000);
  const row = acc.doctors.find((d) => d.balance === 800_000);
  assert.equal(row.has_sheba, true);
  assert.equal(acc.months.length, 1);

  // Payout: not above the balance; reference required.
  assert.equal((await t.call('POST', '/v1/admin/accounting/payouts', { token: admin, body: { doctor_id: row.doctor_id, amount: 900_000, reference: 'TX1' } })).body.code, 'exceeds_balance');
  const po = await t.call('POST', '/v1/admin/accounting/payouts', { token: admin, body: { doctor_id: row.doctor_id, amount: 500_000, reference: 'PAYA-1234' } });
  assert.equal(po.status, 201);
  assert.equal(po.body.balance, 300_000);
  mine = (await t.call('GET', '/v1/doctors/me/accounting', { token: doc })).body;
  assert.equal(mine.payouts[0].reference, 'PAYA-1234');
  assert.equal(mine.overall.paid_out, 500_000);

  const csv = await fetch(`${t.base}/v1/admin/accounting/export`, { headers: { Authorization: `Bearer ${admin}` } });
  const bytes = Buffer.from(await csv.arrayBuffer());
  const text = bytes.toString('utf8').replace(/^\uFEFF/, '');
  assert.match(csv.headers.get('content-type'), /text\/csv/);
  assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]); // BOM so Excel reads Persian
  assert.equal(text.trim().split('\r\n').length, 3); // header + 2 visits
  await t.call('PUT', '/v1/admin/settings', { token: admin, body: { tariffs: { visit_video: 0 }, commission_percent: 0 } });
  void a2;
});

test('staff roles: an accountant sees accounting only; super admin cannot be locked out', async () => {
  const perms = (await t.call('GET', '/v1/admin/permissions', { token: admin })).body.items.map((x) => x.key);
  assert.ok(perms.includes('accounting.payout'));
  const role = await t.call('POST', '/v1/admin/roles', { token: admin, body: { name: 'حسابدار', permissions: ['accounting.view', 'accounting.payout', 'payments.view'] } });
  assert.equal(role.status, 201);
  assert.equal((await t.call('POST', '/v1/admin/roles', { token: admin, body: { name: 'x', permissions: ['nope'] } })).status, 422);

  const st = await t.call('POST', '/v1/admin/staff', { token: admin, body: { phone: '09125550001', role: 'admin', full_name: 'حسابدار کلینیک', staff_role_id: role.body.id } });
  assert.equal(st.status, 201);
  const acct = await t.login('09125550001');
  const me = (await t.call('GET', '/v1/auth/me', { token: acct })).body;
  assert.deepEqual(me.permissions.sort(), ['accounting.payout', 'accounting.view', 'payments.view']);
  assert.equal(me.super_admin, false);
  assert.equal((await t.call('GET', '/v1/admin/accounting', { token: acct })).status, 200);
  assert.equal((await t.call('GET', '/v1/admin/drug-catalog', { token: acct })).body.code, 'permission_denied');
  assert.equal((await t.call('GET', '/v1/admin/users', { token: acct })).status, 403);
  assert.equal((await t.call('DELETE', `/v1/admin/roles/${role.body.id}`, { token: admin })).body.code, 'role_in_use');

  // The only super admin can neither restrict nor disable themselves.
  const self = (await t.call('GET', `/v1/admin/users?q=${DEMO_ACCOUNTS.admin.phone}`, { token: admin })).body.items[0];
  assert.equal(self.super_admin, true);
  assert.equal((await t.call('PUT', `/v1/admin/users/${self.id}/staff-role`, { token: admin, body: { staff_role_id: role.body.id } })).body.code, 'last_super_admin');
  assert.equal((await t.call('POST', `/v1/admin/users/${self.id}/disable`, { token: admin, body: {} })).body.code, 'self');

  // Disabling cuts access immediately (existing token) and blocks new logins.
  await t.call('POST', `/v1/admin/users/${st.body.id}/disable`, { token: admin, body: { reason: 'پایان همکاری' } });
  assert.equal((await t.call('GET', '/v1/admin/accounting', { token: acct })).body.code, 'account_disabled');
  assert.equal((await t.call('POST', '/v1/auth/otp/request', { body: { phone: '09125550001', role: 'doctor' } })).body.code, 'account_disabled');
  await t.call('POST', `/v1/admin/users/${st.body.id}/enable`, { token: admin, body: {} });
  assert.equal((await t.call('POST', '/v1/auth/otp/request', { body: { phone: '09125550001', role: 'doctor' } })).status, 202);
});

test('disabled doctor leaves the directory; login history and activity (own + admin)', async () => {
  const p = await t.newPatient({ nationalId: randomNationalId() });
  const list = async () => (await t.call('GET', '/v1/doctors?specialty=psychiatry', { token: p.token })).body.items.length;
  assert.equal(await list(), 1);
  const u = (await t.call('GET', `/v1/admin/users?q=${DEMO_ACCOUNTS.doctors[4].phone}`, { token: admin })).body.items[0];
  await t.call('POST', `/v1/admin/users/${u.id}/disable`, { token: admin, body: {} });
  assert.equal(await list(), 0);
  await t.call('POST', `/v1/admin/users/${u.id}/enable`, { token: admin, body: {} });
  assert.equal(await list(), 1);

  // A wrong code is recorded as a failed login.
  await t.call('POST', '/v1/auth/otp/request', { body: { phone: p.phone, role: 'patient' } });
  await t.call('POST', '/v1/auth/otp/verify', { body: { phone: p.phone, code: '000000' } });
  const mine = (await t.call('GET', '/v1/me/activity', { token: p.token })).body;
  assert.ok(mine.logins.some((e) => e.success && e.method === 'otp'));
  assert.ok(mine.logins.some((e) => !e.success && e.reason === 'wrong_code'));
  assert.ok(mine.actions.some((a) => a.action === 'patient.create'));

  const pid = (await t.call('GET', `/v1/admin/users?q=${p.phone}`, { token: admin })).body.items[0].id;
  const logins = (await t.call('GET', `/v1/admin/activity?user_id=${pid}`, { token: admin })).body;
  assert.ok(logins.items.length >= 2);
  assert.equal(logins.items[0].user.phone, p.phone);
  const failed = (await t.call('GET', '/v1/admin/activity?failed=1', { token: admin })).body;
  assert.ok(failed.items.every((e) => !e.success));
  const actions = (await t.call('GET', '/v1/admin/activity?kind=actions&action=user.', { token: admin })).body;
  assert.ok(actions.items.some((a) => a.action === 'user.disable'));
  assert.equal((await t.call('GET', '/v1/admin/activity', { token: p.token })).status, 403);
});
