// "From my formulary": prescription suggestions drawn ONLY from the physician's own practice —
// their saved templates and the prescriptions they themselves issued before for the same
// ICD-10 diagnosis. The diagnosis is always the physician's (chosen codes, or codes matched in
// the assessment they wrote, shown for confirmation). Nothing is filled in automatically: each
// suggestion is checked against this patient (allergy, duplicates, interactions) and the
// physician applies and edits it. Suggestions shown/applied are audited.
import { badRequest } from '../../lib/http.js';
import { parseJson } from '../../lib/db.js';
import { requireUser } from '../auth.js';
import { searchIcd, icdByCode } from './icd10.js';

export const SUGGEST_VERSION = 'own-formulary-2026.10.1';
const MAX = 5;

// Codes found in the physician's free-text assessment ("فارنژیت حاد؛ تب") — for confirmation only.
// Qualifiers alone ("نامشخص", "حاد" …) are not diagnoses and would match unrelated codes.
const QUALIFIERS = /^(نامشخص|حاد|مزمن|خفیف|متوسط|شدید|احتمالی|راجعه|عودکننده|اولیه|ثانویه|چپ|راست|دوطرفه|unspecified|acute|chronic|mild|moderate|severe|probable|r\/o|rule out)$/i;
export function codesFromAssessment(text) {
  const parts = String(text ?? '').split(/[\n،؛,.;:]+/).map((s) => s.trim()).filter((s) => s.length >= 2 && !QUALIFIERS.test(s)).slice(0, 8);
  const out = [];
  for (const p of parts) {
    const hit = searchIcd(p, 1)[0] ?? searchIcd(p.split(/\s+/).slice(0, 2).join(' '), 1)[0];
    if (hit && !out.some((x) => x.code === hit.code)) out.push(hit);
  }
  return out.slice(0, 4);
}

const comboKey = (drugs) => drugs.map((d) => String(d.erx_code ?? d.name).toLowerCase().trim()).sort().join('|');

export function register(router, { db, platform, domain }) {
  router.post('/v1/prescriptions/suggest', async (ctx) => {
    requireUser(ctx, 'doctor');
    const cid = ctx.body?.consultation_id;
    const c = db.get(
      `SELECT c.id, a.patient_id, a.doctor_id FROM consultations c JOIN appointments a ON a.id = c.appointment_id WHERE c.id = ? AND c.tenant_id = ?`,
      String(cid ?? ''), ctx.tenantId,
    );
    if (!c || c.doctor_id !== ctx.user.did) throw badRequest('ویزیت نامعتبر است');

    const chosen = (Array.isArray(ctx.body.diagnoses) ? ctx.body.diagnoses : []).map((x) => icdByCode(x)).filter(Boolean);
    const summary = db.get('SELECT assessment FROM visit_summaries WHERE consultation_id = ?', c.id);
    const fromAssessment = codesFromAssessment(summary?.assessment).filter((x) => !chosen.some((y) => y.code === x.code));
    const codes = chosen.map((x) => x.code);
    if (!codes.length) {
      return { body: { version: SUGGEST_VERSION, diagnoses: [], from_assessment: fromAssessment, items: [], hint: 'ابتدا تشخیص را انتخاب کنید (یا از کدهای پیشنهادی ارزیابی خودتان تأیید کنید).' } };
    }

    const candidates = new Map();
    const add = (key, item) => {
      const prev = candidates.get(key);
      if (prev) { prev.times_used += item.times_used; prev.last_used = [prev.last_used, item.last_used].sort().pop(); prev.sources = [...new Set([...prev.sources, ...item.sources])]; }
      else candidates.set(key, item);
    };
    // 1) the physician's templates for these diagnoses
    for (const t of db.all(`SELECT * FROM rx_templates WHERE doctor_id = ? AND diagnosis_code IN (${codes.map(() => '?').join(',')})`, ctx.user.did, ...codes)) {
      const drugs = parseJson(t.drugs, []);
      add(comboKey(drugs), { label: t.name, drugs, notes: t.notes, times_used: t.use_count, last_used: t.updated_at, sources: ['template'], diagnosis_code: t.diagnosis_code, template_id: t.id });
    }
    // 2) prescriptions the physician issued before with the same diagnosis code
    const issued = db.all(
      `SELECT drugs, notes, diagnoses, issued_at FROM prescriptions WHERE doctor_id = ? AND issued_at IS NOT NULL AND (${codes.map(() => 'diagnoses LIKE ?').join(' OR ')})
       ORDER BY issued_at DESC LIMIT 300`,
      ctx.user.did, ...codes.map((k) => `%"code":"${k}"%`),
    );
    for (const r of issued) {
      const drugs = parseJson(r.drugs, []).map(({ erx_title, ...d }) => d);
      if (!drugs.length) continue;
      const dx = parseJson(r.diagnoses, []).find((d) => codes.includes(d.code));
      add(comboKey(drugs), { label: drugs.map((d) => d.name).join(' + ').slice(0, 120), drugs, notes: r.notes, times_used: 1, last_used: r.issued_at, sources: ['history'], diagnosis_code: dx?.code ?? null });
    }

    // Check each candidate against THIS patient; safest and most used first.
    const items = [...candidates.values()].map((s) => {
      const safety = domain.prescription.safetyFor(c.patient_id, s.drugs, c.id);
      return { ...s, warnings: safety.warnings, blocked: safety.warnings.some((w) => w.severity === 'high') };
    }).sort((a, b) => (a.blocked - b.blocked) || (b.times_used - a.times_used) || String(b.last_used).localeCompare(String(a.last_used))).slice(0, MAX);

    platform.audit(ctx, 'rx.suggest', `consultation:${c.id}`, { codes, shown: items.length, version: SUGGEST_VERSION });
    return {
      body: {
        version: SUGGEST_VERSION, diagnoses: chosen.map((x) => ({ code: x.code, label_fa: x.label_fa })), from_assessment: fromAssessment, items,
        hint: items.length ? null : 'برای این تشخیص هنوز نسخه یا الگویی از خودتان ثبت نشده است. پس از چند نسخه، پیشنهادها ظاهر می‌شوند.',
      },
    };
  });

  // Applying a suggestion is recorded (which source, which diagnosis) — for the clinic's own review.
  router.post('/v1/prescriptions/suggest/applied', async (ctx) => {
    requireUser(ctx, 'doctor');
    const b = ctx.body ?? {};
    platform.audit(ctx, 'rx.suggest_applied', `consultation:${String(b.consultation_id ?? '').slice(0, 40)}`, {
      sources: Array.isArray(b.sources) ? b.sources.slice(0, 3) : [], diagnosis_code: icdByCode(b.diagnosis_code)?.code ?? null, had_warnings: !!b.had_warnings,
    });
    return { status: 204 };
  });
}
