import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, randomNationalId } from './helpers.js';

const say = async (t, token, sid, m) => (await t.chat(token, sid, m)).text;

test('assistant: one-word specialty answer, honest messages when that specialty or any GP is not free', async () => {
  const t = await startApp({ disableSweeper: true });
  try {
    const { token } = await t.newPatient({ nationalId: randomNationalId() });
    let sid = t.uuid();
    assert.match(await say(t, token, sid, 'نوبت میخوام'), /برای چه تخصصی/);
    // «داخلی» alone is understood (no internal-medicine doctor in the demo → GP offered, with the reason).
    const r = await say(t, token, sid, 'داخلی');
    assert.match(r, /هنوز پزشک «داخلی» در درمان پلاس فعال نیست/);
    assert.match(r, /این زمان‌ها آزاد است/);
    // Declining the GP sends the specialist request to an operator.
    assert.match(await say(t, token, sid, 'انصراف'), /برای نوبت «داخلی» به اپراتور ارسال شد/);

    // A cardiologist exists: «قلب» alone books cardiology.
    sid = t.uuid();
    await say(t, token, sid, 'نوبت میخوام');
    assert.match(await say(t, token, sid, 'قلب'), /\(قلب و عروق\)/);

    // Unclear answer: asked again instead of silently switching to a GP.
    sid = t.uuid();
    await say(t, token, sid, 'نوبت میخوام');
    assert.match(await say(t, token, sid, 'یه دکتر خوب'), /متوجه نشدم کدام تخصص/);

    // No GP time either: both are named.
    t.app.db.run(`DELETE FROM slots WHERE doctor_id IN (SELECT id FROM doctors WHERE specialty = 'general') AND id NOT IN (SELECT slot_id FROM appointments)`);
    sid = t.uuid();
    const none = await say(t, token, sid, 'نوبت داخلی میخوام');
    assert.match(none, /هنوز پزشک «داخلی» در درمان پلاس فعال نیست و پزشک عمومی هم فعلاً زمان آزاد ندارد/);
    assert.match(none, /اپراتور/);
  } finally {
    t.close();
  }
});
