// Support assistant: answers system questions from its knowledge base, hands the conversation to
// staff with support.handle on request (or after two misses); agents answer and close.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, randomNationalId } from './helpers.js';
import { DEMO_ACCOUNTS } from '../src/seed.js';

let t;
before(async () => { t = await startApp({ disableSweeper: true }); });
after(() => t.close());

test('support assistant answers, escalates to the support desk; agents reply and close', async () => {
  const p = await t.newPatient({ nationalId: randomNationalId() });
  const s0 = await t.call('GET', '/v1/support', { token: p.token });
  assert.equal(s0.body.ticket, null);
  assert.ok(s0.body.topics.some((x) => x.id === 'cancel'));
  assert.ok(!s0.body.topics.some((x) => x.id === 'doc-calendar')); // doctors' topics stay with doctors

  // A question about the system → answer from the knowledge base (with the current refund deadline).
  const a1 = await t.call('POST', '/v1/support/messages', { token: p.token, body: { body: 'میخوام نوبتمو کنسل کنم پولم برمیگرده؟' } });
  assert.equal(a1.status, 201);
  const bot1 = a1.body.messages.at(-1);
  assert.equal(bot1.sender, 'bot');
  assert.match(bot1.body, /۲۴ ساعت/);
  assert.ok(bot1.actions.some((x) => x.type === 'escalate'));
  // A topic button.
  const a2 = await t.call('POST', '/v1/support/messages', { token: p.token, body: { topic: 'otp' } });
  assert.match(a2.body.messages.at(-1).body, /ارسال مجدد کد/);
  assert.equal((await t.call('POST', '/v1/support/messages', { token: p.token, body: { topic: 'doc-money' } })).status, 422);

  // Two questions it cannot answer → the conversation goes to the team.
  await t.call('POST', '/v1/support/messages', { token: p.token, body: { body: 'هوا امروز چطوره' } });
  const miss2 = await t.call('POST', '/v1/support/messages', { token: p.token, body: { body: 'رنگ آبی بهتره یا قرمز' } });
  assert.equal(miss2.body.ticket.status, 'waiting');

  // An operator (support.handle by default) sees it, gets suggested answers, replies.
  const op = await t.login(DEMO_ACCOUNTS.operator.phone);
  const list = await t.call('GET', '/v1/support/tickets?status=waiting', { token: op });
  const item = list.body.items.find((x) => x.user.phone === p.phone);
  assert.ok(item);
  const opNotes = (await t.call('GET', '/v1/notifications', { token: op })).body.items;
  assert.ok(opNotes.some((n) => n.body.startsWith('درخواست پشتیبانی جدید')));
  const d = await t.call('GET', `/v1/support/tickets/${item.id}`, { token: op });
  assert.ok(d.body.messages.length >= 6);
  const r = await t.call('POST', `/v1/support/tickets/${item.id}/reply`, { token: op, body: { body: 'سلام، بررسی کردم؛ مشکلی در حساب شما نیست.' } });
  assert.equal(r.status, 201);
  const mine = await t.call('GET', '/v1/support', { token: p.token });
  assert.equal(mine.body.ticket.status, 'answered');
  assert.equal(mine.body.messages.at(-1).sender, 'staff');
  assert.ok((await t.call('GET', '/v1/notifications', { token: p.token })).body.items.some((n) => n.body.startsWith('پاسخ پشتیبانی')));
  // The user writes again → back in the queue; the bot stays out of a conversation with a person.
  const again = await t.call('POST', '/v1/support/messages', { token: p.token, body: { body: 'کد تایید نمیاد' } });
  assert.equal(again.body.ticket.status, 'waiting');
  assert.equal(again.body.messages.at(-1).sender, 'user');
  // Only agents reach the desk; closing.
  assert.equal((await t.call('GET', '/v1/support/tickets', { token: p.token })).status, 403);
  await t.call('POST', `/v1/support/tickets/${item.id}/close`, { token: op, body: {} });
  const closed = await t.call('GET', '/v1/support', { token: p.token });
  assert.equal(closed.body.ticket, null);

  // Asking for a person goes straight to the team; doctors get doctors' answers.
  const doc = await t.login(DEMO_ACCOUNTS.doctors[0].phone);
  const dq = await t.call('POST', '/v1/support/messages', { token: doc, body: { body: 'چطور تقویمم رو منتشر کنم' } });
  assert.match(dq.body.messages.at(-1).body, /تقویم/);
  const human = await t.call('POST', '/v1/support/messages', { token: doc, body: { body: 'میخوام با کارشناس صحبت کنم' } });
  assert.equal(human.body.ticket.status, 'waiting');
});

test('support agents: ready-made limited role, ratings after closing, performance report', async () => {
  const admin = await t.login(DEMO_ACCOUNTS.admin.phone);
  const roles = (await t.call('GET', '/v1/admin/roles', { token: admin })).body.items;
  const role = roles.find((r) => r.name === 'کارشناس پشتیبانی');
  assert.deepEqual(role.permissions, ['support.handle']);
  // A support agent: an operator account with that role — the support desk only.
  const agentPhone = '09125557777';
  const created = await t.call('POST', '/v1/admin/staff', { token: admin, body: { phone: agentPhone, full_name: 'مینا کارشناس', role: 'operator', staff_role_id: role.id } });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const agent = await t.login(agentPhone);
  assert.equal((await t.call('GET', '/v1/escalations', { token: agent })).status, 403);
  assert.equal((await t.call('GET', '/v1/admin/accounting', { token: agent })).status, 403);
  assert.equal((await t.call('GET', '/v1/admin/doctor-applications', { token: agent })).status, 403);
  assert.equal((await t.call('GET', '/v1/support/report', { token: agent })).status, 403);

  const p = await t.newPatient({ nationalId: randomNationalId() });
  await t.call('POST', '/v1/support/messages', { token: p.token, body: { body: 'میخوام با کارشناس صحبت کنم' } });
  const tk = (await t.call('GET', '/v1/support/tickets?status=waiting', { token: agent })).body.items.find((x) => x.user.phone === p.phone);
  await t.call('POST', `/v1/support/tickets/${tk.id}/reply`, { token: agent, body: { body: 'سلام، مشکل حساب شما برطرف شد.' } });
  const desk = await t.call('GET', `/v1/support/tickets/${tk.id}`, { token: agent });
  assert.equal(desk.body.messages.find((m) => m.sender === 'staff').staff_name, 'مینا کارشناس');
  const mine = await t.call('GET', '/v1/support', { token: p.token });
  assert.equal(mine.body.messages.find((m) => m.sender === 'staff').staff_name, undefined);
  assert.equal((await t.call('POST', `/v1/support/tickets/${tk.id}/rate`, { token: p.token, body: { rating: 5 } })).body.code, 'not_closed');
  await t.call('POST', `/v1/support/tickets/${tk.id}/close`, { token: agent, body: {} });
  const after = await t.call('GET', '/v1/support', { token: p.token });
  assert.equal(after.body.rate.id, tk.id);
  assert.equal((await t.call('POST', `/v1/support/tickets/${tk.id}/rate`, { token: p.token, body: { rating: 9 } })).status, 422);
  const rated = await t.call('POST', `/v1/support/tickets/${tk.id}/rate`, { token: p.token, body: { rating: 4, comment: 'پاسخ سریع و خوب بود' } });
  assert.equal(rated.body.rate, null);
  assert.equal((await t.call('POST', `/v1/support/tickets/${tk.id}/rate`, { token: p.token, body: { rating: 1 } })).body.code, 'already_rated');

  const own = await t.call('GET', '/v1/support/report/me', { token: agent });
  assert.deepEqual([own.body.me.replies, own.body.me.tickets, own.body.me.closed, own.body.me.avg_rating], [1, 1, 1, 4]);
  const rep = await t.call('GET', '/v1/support/report', { token: admin });
  const row = rep.body.agents.find((a) => a.agent_id === own.body.me.agent_id);
  assert.equal(row.satisfied, 1);
  assert.ok(rep.body.ratings.some((r) => r.rating_comment === 'پاسخ سریع و خوب بود' && r.agent_name === 'مینا کارشناس'));
  assert.ok(rep.body.totals.escalated >= 1);
});

test('inappropriate messages are rejected and logged; repeated abuse pauses sending', async () => {
  const p = await t.newPatient({ nationalId: randomNationalId() });
  const bad = await t.call('POST', '/v1/support/messages', { token: p.token, body: { body: 'احمق جواب بده' } });
  assert.equal(bad.status, 422);
  assert.equal(bad.body.code, 'inappropriate_content');
  assert.equal((await t.call('GET', '/v1/support', { token: p.token })).body.ticket, null); // nothing stored
  assert.equal((await t.call('POST', '/v1/support/messages', { token: p.token, body: { body: 'ک.ی.ر' } })).body.code, 'inappropriate_content');
  assert.equal((await t.call('POST', '/v1/support/messages', { token: p.token, body: { body: 'تخفیف ویژه www.example.com' } })).body.code, 'inappropriate_content');
  assert.equal((await t.call('POST', '/v1/support/messages', { token: p.token, body: { body: '!!!!!!!!!!????' } })).body.code, 'inappropriate_content');
  // Ordinary words that contain those letters pass.
  assert.equal((await t.call('POST', '/v1/support/messages', { token: p.token, body: { body: 'آیا کسی هست؟ مبلغ از حسابم کسر شد' } })).status, 201);
  // The health assistant rejects them too.
  const sid = crypto.randomUUID();
  const ai = await t.call('POST', '/v1/ai/chat', { token: p.token, body: { session_id: sid, message: { type: 'text', content: 'دستیار احمق' } } });
  assert.equal(ai.body.code, 'inappropriate_content');
  // Fifth rejection within the hour → paused.
  await t.call('POST', '/v1/support/messages', { token: p.token, body: { body: 'عوضی' } });
  const paused = await t.call('POST', '/v1/support/messages', { token: p.token, body: { body: 'کد تایید نمیاد' } });
  assert.equal(paused.status, 429);
  assert.equal(paused.body.code, 'moderation_blocked');
  // Staff answers are checked as well; the report lists rejections.
  const admin = await t.login(DEMO_ACCOUNTS.admin.phone);
  const tk = (await t.call('GET', '/v1/support/tickets?status=bot', { token: admin })).body.items.find((x) => x.user.phone === p.phone);
  assert.equal((await t.call('POST', `/v1/support/tickets/${tk.id}/reply`, { token: admin, body: { body: 'خفه شو' } })).body.code, 'inappropriate_content');
  const rep = await t.call('GET', '/v1/support/report', { token: admin });
  assert.ok(rep.body.moderation.filter((m) => m.phone === p.phone).length >= 5);
});
