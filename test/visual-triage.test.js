import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { assessStructured, validateForm, questionsFor, FormError } from '../src/modules/ai/triage-structured.js';
import { startApp } from './helpers.js';

const base = (over = {}) => validateForm({
  who: 'self', age_years: 35, sex: 'male', regions: [], symptoms: [], answers: {}, severity: 3, onset: 'gradual', duration: 'd1_3', ...over,
});

test('emergency discriminators win regardless of pain score', () => {
  const r = assessStructured(base({ regions: ['chest'], severity: 2, answers: { chest_radiation: 'yes' } }));
  assert.equal(r.urgency_level, 'emergency');
  assert.equal(r.acuity.color, 'red');
});

test('unsure about an emergency sign is up-triaged, never down', () => {
  const r = assessStructured(base({ regions: ['head'], severity: 2, answers: { thunderclap: 'unsure' } }));
  assert.equal(r.urgency_level, 'urgent');
});

test('sudden severe headache is an emergency (thunderclap pattern)', () => {
  assert.equal(assessStructured(base({ regions: ['head'], severity: 8, onset: 'sudden' })).urgency_level, 'emergency');
});

test('measured vitals: low SpO2 and infant fever are emergencies; plausibility enforced', () => {
  assert.equal(assessStructured(base({ symptoms: ['dyspnea'], vitals: { spo2: 89 } })).urgency_level, 'emergency');
  assert.equal(assessStructured(base({ who: 'child', age_years: 0.15, symptoms: ['fever'] })).urgency_level, 'emergency');
  assert.throws(() => base({ symptoms: ['fever'], vitals: { temp_c: 52 } }), FormError);
});

test('mild, recent, non-red-flag complaint → self care; chest pain never self care', () => {
  assert.equal(assessStructured(base({ regions: ['throat_neck'], severity: 2, duration: 'lt_24h' })).urgency_level, 'self_care');
  assert.notEqual(assessStructured(base({ regions: ['chest'], severity: 1, duration: 'lt_24h' })).urgency_level, 'self_care');
});

test('specialty routing and pediatric override', () => {
  assert.equal(assessStructured(base({ regions: ['back_lower'], severity: 4 })).recommended_specialty, 'orthopedics');
  assert.equal(assessStructured(base({ who: 'child', age_years: 6, regions: ['ear'] })).recommended_specialty, 'pediatrics');
  assert.equal(assessStructured(base({ sex: 'female', regions: ['pelvis'] })).recommended_specialty, 'gynecology');
});

test('pregnancy question only appears when relevant; unknown answers are dropped', () => {
  assert.ok(!questionsFor({ regions: ['abdomen_lower'] }).some((q) => q.id === 'pregnancy_pain'));
  assert.ok(questionsFor({ regions: ['abdomen_lower'], may_be_pregnant: true }).some((q) => q.id === 'pregnancy_pain'));
  const f = base({ regions: ['ear'], answers: { cauda_equina: 'yes' } });
  assert.deepEqual(f.answers, {});
});

test('free-text note still passes the fixed emergency rules', () => {
  assert.equal(assessStructured(base({ regions: ['arm_left'], note: 'درد قفسه سینه هم دارم' })).urgency_level, 'emergency');
});

// ---------------- API ----------------
let t;
before(async () => { t = await startApp(); });
after(() => t.close());

async function submitForm(token, sid, form) {
  const r = await t.call('POST', '/v1/ai/chat', { token, body: { session_id: sid, message: { type: 'triage_form', form } } });
  const events = r.text.split('\n\n').filter(Boolean).map((b) => ({ event: /^event: (.+)$/m.exec(b)?.[1], data: JSON.parse(/^data: (.+)$/m.exec(b)?.[1] ?? 'null') }));
  return { status: r.status, body: r.body, events, done: events.find((e) => e.event === 'done')?.data };
}

test('API: visual triage form → result card event → booking options', async () => {
  const p = await t.newPatient({ nationalId: '0067749828' });
  const cat = await t.call('GET', '/v1/ai/triage/catalog', { token: p.token });
  assert.ok(cat.body.regions.find((r) => r.id === 'chest'));
  const sid = t.uuid();
  const r = await submitForm(p.token, sid, {
    who: 'self', age_years: 30, sex: 'female', regions: ['back_lower'], answers: { breathing_hard: 'no', collapse: 'no', cauda_equina: 'no', urinary_fever: 'no' },
    severity: 5, onset: 'gradual', duration: 'd4_7',
  });
  assert.equal(r.status, 200);
  const card = r.events.find((e) => e.event === 'triage_result');
  assert.equal(card.data.urgency_level, 'routine');
  assert.ok(card.data.safety_net.length);
  assert.equal(r.done.mode, 'BOOKING_MODE');
  assert.ok(r.events.some((e) => e.event === 'options'));
  const row = t.app.db.get('SELECT rule_version, symptoms FROM triage_results WHERE id = ?', card.data.triage_result_id);
  assert.match(row.rule_version, /^visual-triage-/);
  assert.equal(JSON.parse(row.symptoms)[0].form.regions[0], 'back_lower');
});

test('API: emergency answer in the form escalates to a human and enters EMERGENCY_MODE', async () => {
  const p = await t.newPatient({ nationalId: '0076229645' });
  const r = await submitForm(p.token, t.uuid(), {
    who: 'self', age_years: 58, regions: ['chest'], answers: { chest_sweat: 'yes' }, severity: 6, onset: 'sudden', duration: 'lt_6h',
  });
  assert.equal(r.done.mode, 'EMERGENCY_MODE');
  assert.ok(r.events.some((e) => e.event === 'escalation' && e.data.kind === 'emergency'));
  assert.equal(t.app.db.get(`SELECT COUNT(*) AS n FROM triage_results WHERE user_id = (SELECT user_id FROM chat_sessions ORDER BY created_at DESC LIMIT 1)`).n, 1);
});

test('API: invalid form is rejected with 422', async () => {
  const p = await t.newPatient({ nationalId: '0013542419' });
  const r = await submitForm(p.token, t.uuid(), { regions: [], symptoms: [] });
  assert.equal(r.status, 422);
  assert.equal(r.body.code, 'invalid_triage_form');
});
