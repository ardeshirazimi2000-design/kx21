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
