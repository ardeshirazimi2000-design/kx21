// Small, curated drug knowledge base for prescription SAFETY CHECKS (phase 1).
// It recognises common generics (English + Persian spellings + a few well-known brands), maps
// them to therapeutic/allergy groups, and knows a short list of well-established, high-impact
// interactions. It is deliberately conservative and NOT a complete interaction database —
// every warning is advisory and the prescriber decides. Version every change.
import { normalizeFa } from '../../lib/fa.js';

export const DRUG_KB_VERSION = 'drug-kb-2026.10.1';

// group → [Persian label, duplicate-therapy check?]
export const GROUPS = {
  penicillin: ['پنی‌سیلین‌ها', true],
  cephalosporin: ['سفالوسپورین‌ها', true],
  carbapenem: ['کارباپنم‌ها', true],
  macrolide: ['ماکرولیدها', true],
  fluoroquinolone: ['فلوروکینولون‌ها', true],
  tetracycline: ['تتراسایکلین‌ها', true],
  sulfonamide_ab: ['سولفونامیدهای ضدمیکروب', true],
  nitroimidazole: ['نیتروایمیدازول‌ها', true],
  nsaid: ['ضدالتهاب‌های غیراستروئیدی (NSAID)', true],
  aspirin: ['آسپرین', false],
  paracetamol: ['استامینوفن', true],
  opioid: ['اپیوئیدها', true],
  ppi: ['مهارکننده‌های پمپ پروتون', true],
  h2: ['آنتاگونیست‌های H2', true],
  ssri: ['SSRIها', true],
  snri: ['SNRIها', true],
  tca: ['ضدافسردگی‌های سه‌حلقه‌ای', true],
  maoi: ['مهارکننده‌های MAO', true],
  benzodiazepine: ['بنزودیازپین‌ها', true],
  ace_inhibitor: ['مهارکننده‌های ACE', true],
  arb: ['ARBها', true],
  beta_blocker: ['بتابلاکرها', true],
  ccb: ['کلسیم‌بلاکرها', true],
  thiazide: ['تیازیدها', true],
  loop_diuretic: ['دیورتیک‌های لوپ', true],
  k_sparing: ['دیورتیک‌های نگه‌دارنده پتاسیم', true],
  statin: ['استاتین‌ها', true],
  vka: ['ضدانعقاد خوراکی (وارفارین)', true],
  doac: ['ضدانعقادهای خوراکی جدید', true],
  antiplatelet: ['ضدپلاکت‌ها', false],
  biguanide: ['متفورمین', true],
  sulfonylurea: ['سولفونیل‌اوره‌ها', true],
  corticosteroid: ['کورتیکواستروئید سیستمیک', true],
  antihistamine: ['آنتی‌هیستامین‌ها', true],
  triptan: ['تریپتان‌ها', true],
  nitrate: ['نیترات‌ها', true],
  pde5: ['مهارکننده‌های PDE5', true],
  methotrexate: ['متوترکسات', true],
  serotonergic: ['سروتونرژیک', false],
};

// generic → { groups, names (aliases: English, Persian, brands) }
const D = (generic, groups, ...names) => ({ generic, groups, names: [generic, ...names] });
export const DRUGS = [
  D('Amoxicillin', ['penicillin'], 'آموکسی سیلین', 'آموکسی‌سیلین', 'amoxil'),
  D('Co-amoxiclav', ['penicillin'], 'amoxicillin clavulanate', 'amoxicillin/clavulanate', 'کوآموکسی کلاو', 'کو آموکسی کلاو', 'augmentin', 'اگمنتین'),
  D('Penicillin V', ['penicillin'], 'penicillin', 'پنی سیلین', 'پنی‌سیلین', 'penicillin vk'),
  D('Benzathine penicillin', ['penicillin'], 'پنی سیلین بنزاتین', 'penicillin 6.3.3', 'پنی سیلین ۶۳۳'),
  D('Ampicillin', ['penicillin'], 'آمپی سیلین'),
  D('Cloxacillin', ['penicillin'], 'کلوگزاسیلین', 'کلوکساسیلین'),
  D('Cefixime', ['cephalosporin'], 'سفکسیم'),
  D('Cephalexin', ['cephalosporin'], 'cefalexin', 'سفالکسین'),
  D('Cefuroxime', ['cephalosporin'], 'سفوروکسیم'),
  D('Ceftriaxone', ['cephalosporin'], 'سفتریاکسون'),
  D('Cefazolin', ['cephalosporin'], 'سفازولین'),
  D('Meropenem', ['carbapenem'], 'مروپنم'),
  D('Azithromycin', ['macrolide'], 'آزیترومایسین', 'آزیترومایسین'),
  D('Clarithromycin', ['macrolide'], 'کلاریترومایسین'),
  D('Erythromycin', ['macrolide'], 'اریترومایسین'),
  D('Ciprofloxacin', ['fluoroquinolone'], 'سیپروفلوکساسین'),
  D('Levofloxacin', ['fluoroquinolone'], 'لووفلوکساسین'),
  D('Ofloxacin', ['fluoroquinolone'], 'افلوکساسین'),
  D('Doxycycline', ['tetracycline'], 'داکسی سایکلین', 'داکسی‌سایکلین'),
  D('Tetracycline', ['tetracycline'], 'تتراسایکلین'),
  D('Co-trimoxazole', ['sulfonamide_ab'], 'trimethoprim sulfamethoxazole', 'cotrimoxazole', 'کوتریموکسازول', 'کوتریموکسازول', 'bactrim', 'باکتریم'),
  D('Metronidazole', ['nitroimidazole'], 'مترونیدازول', 'flagyl'),
  D('Ibuprofen', ['nsaid'], 'ایبوپروفن', 'بروفن', 'brufen'),
  D('Naproxen', ['nsaid'], 'ناپروکسن'),
  D('Diclofenac', ['nsaid'], 'دیکلوفناک', 'voltaren', 'ولتارن'),
  D('Mefenamic acid', ['nsaid'], 'مفنامیک اسید', 'مفنامیک‌اسید'),
  D('Indomethacin', ['nsaid'], 'ایندومتاسین'),
  D('Celecoxib', ['nsaid'], 'سلکوکسیب'),
  D('Meloxicam', ['nsaid'], 'ملوکسیکام'),
  D('Ketorolac', ['nsaid'], 'کتورولاک'),
  D('Aspirin', ['aspirin', 'nsaid', 'antiplatelet'], 'acetylsalicylic acid', 'asa', 'آسپرین', 'آ اس آ'),
  D('Acetaminophen', ['paracetamol'], 'paracetamol', 'استامینوفن', 'پاراستامول'),
  D('Codeine', ['opioid'], 'کدئین', 'استامینوفن کدئین', 'acetaminophen codeine'),
  D('Tramadol', ['opioid', 'serotonergic'], 'ترامادول'),
  D('Morphine', ['opioid'], 'مورفین'),
  D('Methadone', ['opioid'], 'متادون'),
  D('Pethidine', ['opioid', 'serotonergic'], 'meperidine', 'پتیدین'),
  D('Omeprazole', ['ppi'], 'امپرازول'),
  D('Pantoprazole', ['ppi'], 'پنتوپرازول', 'پانتوپرازول'),
  D('Esomeprazole', ['ppi'], 'ازومپرازول'),
  D('Lansoprazole', ['ppi'], 'لانزوپرازول'),
  D('Famotidine', ['h2'], 'فاموتیدین'),
  D('Ranitidine', ['h2'], 'رانیتیدین'),
  D('Fluoxetine', ['ssri', 'serotonergic'], 'فلوکستین', 'فلوکسیتین'),
  D('Sertraline', ['ssri', 'serotonergic'], 'سرترالین'),
  D('Citalopram', ['ssri', 'serotonergic'], 'سیتالوپرام'),
  D('Escitalopram', ['ssri', 'serotonergic'], 'اسیتالوپرام'),
  D('Paroxetine', ['ssri', 'serotonergic'], 'پاروکستین'),
  D('Fluvoxamine', ['ssri', 'serotonergic'], 'فلووکسامین'),
  D('Venlafaxine', ['snri', 'serotonergic'], 'ونلافاکسین'),
  D('Duloxetine', ['snri', 'serotonergic'], 'دولوکستین'),
  D('Amitriptyline', ['tca', 'serotonergic'], 'آمی تریپتیلین', 'آمی‌تریپتیلین'),
  D('Nortriptyline', ['tca'], 'نورتریپتیلین'),
  D('Clomipramine', ['tca', 'serotonergic'], 'کلومیپرامین'),
  D('Phenelzine', ['maoi'], 'فنلزین'),
  D('Tranylcypromine', ['maoi'], 'ترانیل سیپرومین'),
  D('Selegiline', ['maoi'], 'سلژیلین'),
  D('Diazepam', ['benzodiazepine'], 'دیازپام'),
  D('Alprazolam', ['benzodiazepine'], 'آلپرازولام'),
  D('Clonazepam', ['benzodiazepine'], 'کلونازپام'),
  D('Lorazepam', ['benzodiazepine'], 'لورازپام'),
  D('Oxazepam', ['benzodiazepine'], 'اگزازپام'),
  D('Chlordiazepoxide', ['benzodiazepine'], 'کلردیازپوکساید'),
  D('Captopril', ['ace_inhibitor'], 'کاپتوپریل'),
  D('Enalapril', ['ace_inhibitor'], 'انالاپریل'),
  D('Lisinopril', ['ace_inhibitor'], 'لیزینوپریل'),
  D('Ramipril', ['ace_inhibitor'], 'رامیپریل'),
  D('Losartan', ['arb'], 'لوزارتان'),
  D('Valsartan', ['arb'], 'والسارتان'),
  D('Candesartan', ['arb'], 'کاندسارتان'),
  D('Telmisartan', ['arb'], 'تلمیسارتان'),
  D('Irbesartan', ['arb'], 'ایربسارتان'),
  D('Metoprolol', ['beta_blocker'], 'متوپرولول'),
  D('Atenolol', ['beta_blocker'], 'آتنولول'),
  D('Propranolol', ['beta_blocker'], 'پروپرانولول'),
  D('Bisoprolol', ['beta_blocker'], 'بیزوپرولول'),
  D('Carvedilol', ['beta_blocker'], 'کارودیلول'),
  D('Amlodipine', ['ccb'], 'آملودیپین'),
  D('Nifedipine', ['ccb'], 'نیفدیپین'),
  D('Diltiazem', ['ccb'], 'دیلتیازم'),
  D('Verapamil', ['ccb'], 'وراپامیل'),
  D('Hydrochlorothiazide', ['thiazide'], 'هیدروکلروتیازید', 'hctz'),
  D('Furosemide', ['loop_diuretic'], 'فوروزماید', 'لازیکس', 'lasix'),
  D('Spironolactone', ['k_sparing'], 'اسپیرونولاکتون'),
  D('Triamterene', ['k_sparing'], 'تریامترن'),
  D('Atorvastatin', ['statin'], 'آتورواستاتین'),
  D('Simvastatin', ['statin'], 'سیمواستاتین'),
  D('Rosuvastatin', ['statin'], 'رزوواستاتین'),
  D('Lovastatin', ['statin'], 'لوواستاتین'),
  D('Warfarin', ['vka'], 'وارفارین'),
  D('Rivaroxaban', ['doac'], 'ریواروکسابان', 'xarelto', 'زارلتو'),
  D('Apixaban', ['doac'], 'آپیکسابان'),
  D('Clopidogrel', ['antiplatelet'], 'کلوپیدوگرل', 'plavix', 'پلاویکس'),
  D('Metformin', ['biguanide'], 'متفورمین'),
  D('Glibenclamide', ['sulfonylurea'], 'glyburide', 'گلی بن کلامید', 'گلی‌بن‌کلامید'),
  D('Gliclazide', ['sulfonylurea'], 'گلی کلازید', 'گلیکلازید'),
  D('Prednisolone', ['corticosteroid'], 'پردنیزولون'),
  D('Prednisone', ['corticosteroid'], 'پردنیزون'),
  D('Dexamethasone', ['corticosteroid'], 'دگزامتازون'),
  D('Cetirizine', ['antihistamine'], 'ستیریزین'),
  D('Loratadine', ['antihistamine'], 'لوراتادین'),
  D('Chlorpheniramine', ['antihistamine'], 'کلرفنیرامین'),
  D('Diphenhydramine', ['antihistamine'], 'دیفن هیدرامین', 'دیفن‌هیدرامین'),
  D('Fexofenadine', ['antihistamine'], 'فکسوفنادین'),
  D('Sumatriptan', ['triptan', 'serotonergic'], 'سوماتریپتان'),
  D('Nitroglycerin', ['nitrate'], 'glyceryl trinitrate', 'نیتروگلیسیرین', 'tng'),
  D('Isosorbide dinitrate', ['nitrate'], 'ایزوسورباید دی نیترات', 'ایزوسوربید'),
  D('Isosorbide mononitrate', ['nitrate'], 'ایزوسورباید مونونیترات'),
  D('Sildenafil', ['pde5'], 'سیلدنافیل', 'viagra'),
  D('Tadalafil', ['pde5'], 'تادالافیل'),
  D('Methotrexate', ['methotrexate'], 'متوترکسات'),
];

const norm = (s) => normalizeFa(s).replace(/[‌\-_/]+/g, ' ').replace(/\s+/g, ' ').trim();
const INDEX = new Map();
for (const d of DRUGS) for (const n of d.names) INDEX.set(norm(n), d);
const NAMES_BY_LEN = [...INDEX.keys()].sort((a, b) => b.length - a.length);

/** Best-effort recognition of a prescribed drug name ("Amoxicillin 500 cap" → Amoxicillin). */
export function identifyDrug(name) {
  const n = norm(name);
  if (!n) return null;
  if (INDEX.has(n)) return INDEX.get(n);
  for (const k of NAMES_BY_LEN) {
    if (k.length < 4) continue;
    const re = new RegExp(`(^|[^a-z؀-ۿ])${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^a-z؀-ۿ])`);
    if (re.test(n)) return INDEX.get(k);
  }
  return null;
}

// Allergy text → groups (direct) and cross-reactive groups (lower severity).
const ALLERGY_RULES = [
  { re: /پنی ?سیلین|penicillin|آموکسی|amoxi|آمپی سیلین|ampicillin|کوآموکسی|augmentin/, groups: ['penicillin'], cross: ['cephalosporin', 'carbapenem'] },
  { re: /سفالوسپورین|cephalosporin|سفکسیم|cefixime|سفالکسین|cephalexin|سفتریاکسون|ceftriaxone|سفوروکسیم|cefuroxime/, groups: ['cephalosporin'], cross: ['penicillin'] },
  { re: /سولفا|sulfa|کوتریموکسازول|cotrimoxazole|co trimoxazole|bactrim|باکتریم/, groups: ['sulfonamide_ab'], cross: [] },
  { re: /آسپرین|aspirin|nsaid|ان ?سید|ایبوپروفن|ibuprofen|بروفن|دیکلوفناک|diclofenac|ناپروکسن|naproxen|ضدالتهاب|مفنامیک/, groups: ['nsaid', 'aspirin'], cross: [] },
  { re: /کدئین|codeine|مورفین|morphine|اپیوئید|opioid|ترامادول|tramadol|مخدر/, groups: ['opioid'], cross: [] },
  { re: /ماکرولید|macrolide|اریترومایسین|erythromycin|آزیترو|azithro|کلاریترو|clarithro/, groups: ['macrolide'], cross: [] },
  { re: /کینولون|quinolone|سیپرو|cipro|لووفلو|levoflox/, groups: ['fluoroquinolone'], cross: [] },
  { re: /تتراسایکلین|tetracycline|داکسی|doxy/, groups: ['tetracycline'], cross: [] },
  { re: /مترونیدازول|metronidazole|فلاژیل|flagyl/, groups: ['nitroimidazole'], cross: [] },
  { re: /استامینوفن|acetaminophen|paracetamol|پاراستامول/, groups: ['paracetamol'], cross: [] },
];

// Patterns are written naturally; match them against normalised text (آ→ا, ي→ی, digits, case).
for (const r of ALLERGY_RULES) r.re = new RegExp(normalizeFa(r.re.source));

// Well-established, high-impact pairs only (group or generic on each side).
const INTERACTIONS = [
  { a: ['maoi'], b: ['ssri', 'snri', 'tca', 'Tramadol', 'Pethidine', 'triptan'], severity: 'high', text: 'خطر سندرم سروتونین / واکنش شدید؛ مصرف هم‌زمان منع است.' },
  { a: ['nitrate'], b: ['pde5'], severity: 'high', text: 'افت فشار شدید و خطرناک؛ مصرف هم‌زمان منع است.' },
  { a: ['Methotrexate'], b: ['Co-trimoxazole'], severity: 'high', text: 'افزایش سمیت مغز استخوان متوترکسات.' },
  { a: ['Clarithromycin', 'Erythromycin'], b: ['Simvastatin', 'Lovastatin'], severity: 'high', text: 'افزایش شدید سطح استاتین و خطر رابدومیولیز.' },
  { a: ['vka'], b: ['nsaid'], severity: 'high', text: 'افزایش قابل توجه خطر خونریزی.' },
  { a: ['vka'], b: ['Co-trimoxazole', 'Metronidazole', 'Clarithromycin', 'Erythromycin', 'Ciprofloxacin', 'Levofloxacin'], severity: 'moderate', text: 'تقویت اثر وارفارین؛ INR پایش شود.' },
  { a: ['doac'], b: ['nsaid'], severity: 'moderate', text: 'افزایش خطر خونریزی.' },
  { a: ['opioid'], b: ['benzodiazepine'], severity: 'high', text: 'خطر تضعیف تنفس و آرام‌بخشی شدید.' },
  { a: ['ssri', 'snri'], b: ['Tramadol', 'triptan'], severity: 'moderate', text: 'خطر سندرم سروتونین؛ با احتیاط و آموزش علائم.' },
  { a: ['ace_inhibitor', 'arb'], b: ['k_sparing'], severity: 'moderate', text: 'خطر هایپرکالمی؛ پتاسیم و عملکرد کلیه پایش شود.' },
  { a: ['ace_inhibitor'], b: ['arb'], severity: 'moderate', text: 'مهار دوگانه سیستم رنین-آنژیوتانسین؛ خطر هایپرکالمی و آسیب کلیه.' },
  { a: ['ssri', 'snri'], b: ['nsaid', 'vka', 'doac', 'antiplatelet'], severity: 'moderate', text: 'افزایش خطر خونریزی (به‌ویژه گوارشی).' },
];

const has = (d, keys) => keys.some((k) => d.generic === k || d.groups.includes(k));
const label = (g) => GROUPS[g]?.[0] ?? g;

/**
 * drugs: [{ name, … }] being prescribed; ctx: { allergies: [text], activeDrugs: [{ name, prescribed_at }] }
 * → [{ severity: 'high'|'moderate', type, message, drugs: [names] }]
 */
export function checkPrescription(drugs, { allergies = [], activeDrugs = [] } = {}) {
  const warnings = [];
  const items = drugs.map((d) => ({ name: d.name, kb: identifyDrug(d.name) }));
  const known = items.filter((i) => i.kb);

  // 1) allergies
  const allergyText = allergies.map(norm).filter(Boolean);
  for (const i of known) {
    for (const a of allergyText) {
      if (i.kb.names.some((n) => norm(n).length >= 4 && a.includes(norm(n)))) {
        warnings.push({ severity: 'high', type: 'allergy', drugs: [i.name], message: `بیمار به «${a}» حساسیت ثبت کرده و «${i.name}» همان دارو است.` });
        continue;
      }
      for (const r of ALLERGY_RULES) {
        if (!r.re.test(a)) continue;
        const direct = i.kb.groups.find((g) => r.groups.includes(g));
        const cross = i.kb.groups.find((g) => r.cross.includes(g));
        if (direct) warnings.push({ severity: 'high', type: 'allergy', drugs: [i.name], message: `حساسیت ثبت‌شده «${a}»؛ «${i.name}» از گروه ${label(direct)} است.` });
        else if (cross) warnings.push({ severity: 'moderate', type: 'allergy_cross', drugs: [i.name], message: `حساسیت ثبت‌شده «${a}»؛ «${i.name}» (${label(cross)}) احتمال واکنش متقاطع دارد.` });
      }
    }
  }

  // 2) duplicates within this prescription
  const seen = new Map();
  for (const i of known) {
    if (seen.has(i.kb.generic)) warnings.push({ severity: 'high', type: 'duplicate', drugs: [seen.get(i.kb.generic), i.name], message: `«${i.kb.generic}» دو بار در نسخه آمده است.` });
    else seen.set(i.kb.generic, i.name);
  }
  const byGroup = new Map();
  for (const i of known) for (const g of i.kb.groups) if (GROUPS[g]?.[1]) {
    const list = byGroup.get(g) ?? [];
    if (!list.some((x) => x.kb.generic === i.kb.generic)) list.push(i);
    byGroup.set(g, list);
  }
  for (const [g, list] of byGroup) if (list.length > 1) {
    warnings.push({ severity: 'moderate', type: 'duplicate_class', drugs: list.map((x) => x.name), message: `دو داروی هم‌گروه (${label(g)}): ${list.map((x) => x.name).join('، ')}.` });
  }

  // 3) interactions within the prescription and with the patient's recent prescriptions
  const recent = activeDrugs.map((d) => ({ name: d.name, kb: identifyDrug(d.name), recent: true })).filter((x) => x.kb);
  const pairs = [];
  for (let x = 0; x < known.length; x++) {
    for (let y = x + 1; y < known.length; y++) pairs.push([known[x], known[y]]);
    for (const r of recent) if (r.kb.generic !== known[x].kb.generic) pairs.push([known[x], r]);
  }
  for (const [p, q] of pairs) {
    for (const rule of INTERACTIONS) {
      if ((has(p.kb, rule.a) && has(q.kb, rule.b)) || (has(p.kb, rule.b) && has(q.kb, rule.a))) {
        warnings.push({
          severity: rule.severity, type: 'interaction', drugs: [p.name, q.name],
          message: `تداخل «${p.name}» و «${q.name}»${q.recent ? ' (از نسخه اخیر بیمار)' : ''}: ${rule.text}`,
        });
        break;
      }
    }
  }
  // same drug / same class already on a recent prescription
  for (const i of known) {
    const r = recent.find((x) => x.kb.generic === i.kb.generic);
    if (r) { warnings.push({ severity: 'moderate', type: 'duplicate_recent', drugs: [i.name], message: `«${i.kb.generic}» در نسخه اخیر بیمار هم تجویز شده است.` }); continue; }
    const g = i.kb.groups.find((gr) => GROUPS[gr]?.[1] && recent.some((x) => x.kb.groups.includes(gr)));
    if (g) {
      const other = recent.find((x) => x.kb.groups.includes(g));
      warnings.push({ severity: 'moderate', type: 'duplicate_recent', drugs: [i.name, other.name], message: `«${i.name}» با «${other.name}» از نسخه اخیر بیمار هم‌گروه است (${label(g)}).` });
    }
  }

  // de-duplicate identical messages
  const uniq = new Map();
  for (const w of warnings) if (!uniq.has(w.message)) uniq.set(w.message, w);
  return [...uniq.values()].sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'high' ? -1 : 1));
}

export const unknownDrugs = (drugs) => drugs.filter((d) => !identifyDrug(d.name)).map((d) => d.name);
export const drugSuggestions = () => DRUGS.map((d) => d.generic);
