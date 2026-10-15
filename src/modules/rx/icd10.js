// Common outpatient/telehealth diagnoses with WHO ICD-10 codes (Persian + English labels and
// search synonyms). The physician writes/chooses the diagnosis; this list only provides the code.
// Not the full classification — extend as the clinic needs. Version every change.
import { normalizeFa } from '../../lib/fa.js';

export const ICD10_VERSION = 'icd10-common-2026.10.1';

// [code, Persian label, English label, extra search terms]
const C = [
  // infections / respiratory
  ['J00', 'سرماخوردگی (رینوفارنژیت حاد)', 'Acute nasopharyngitis [common cold]', 'سرماخوردگی زکام common cold'],
  ['J01.9', 'سینوزیت حاد، نامشخص', 'Acute sinusitis, unspecified', 'سینوزیت سینوس'],
  ['J02.0', 'فارنژیت استرپتوکوکی', 'Streptococcal pharyngitis', 'گلودرد چرکی استرپ'],
  ['J02.9', 'فارنژیت حاد، نامشخص', 'Acute pharyngitis, unspecified', 'گلودرد فارنژیت'],
  ['J03.9', 'تونسیلیت حاد، نامشخص', 'Acute tonsillitis, unspecified', 'لوزه تونسیلیت'],
  ['J04.0', 'لارنژیت حاد', 'Acute laryngitis', 'لارنژیت گرفتگی صدا'],
  ['J06.9', 'عفونت حاد دستگاه تنفسی فوقانی، نامشخص', 'Acute upper respiratory infection, unspecified', 'urti عفونت تنفسی فوقانی'],
  ['J10.1', 'آنفلوانزا با سایر تظاهرات تنفسی، ویروس شناسایی‌شده', 'Influenza with other respiratory manifestations, virus identified', 'آنفولانزا'],
  ['J11.1', 'آنفلوانزا با سایر تظاهرات تنفسی، ویروس شناسایی‌نشده', 'Influenza with other respiratory manifestations, virus not identified', 'آنفولانزا آنفلوآنزا flu'],
  ['J18.9', 'پنومونی، نامشخص', 'Pneumonia, unspecified organism', 'ذات الریه پنومونی'],
  ['J20.9', 'برونشیت حاد، نامشخص', 'Acute bronchitis, unspecified', 'برونشیت'],
  ['J30.4', 'رینیت آلرژیک، نامشخص', 'Allergic rhinitis, unspecified', 'آلرژی فصلی حساسیت بینی'],
  ['J45.9', 'آسم، نامشخص', 'Asthma, unspecified', 'آسم'],
  ['J44.9', 'بیماری مزمن انسدادی ریه، نامشخص', 'Chronic obstructive pulmonary disease, unspecified', 'copd'],
  ['U07.1', 'کووید-۱۹، ویروس شناسایی‌شده', 'COVID-19, virus identified', 'کرونا کووید covid'],
  ['B34.9', 'عفونت ویروسی، نامشخص', 'Viral infection, unspecified', 'ویروسی'],
  ['A09', 'گاستروانتریت و کولیت عفونی، نامشخص', 'Infectious gastroenteritis and colitis, unspecified', 'اسهال عفونی گاستروانتریت'],
  ['B01.9', 'آبله‌مرغان بدون عارضه', 'Varicella without complication', 'آبله مرغان'],
  ['B02.9', 'زونا بدون عارضه', 'Zoster without complications', 'زونا هرپس زوستر'],
  ['B00.1', 'تبخال (درماتیت وزیکولار هرپسی)', 'Herpesviral vesicular dermatitis', 'تبخال هرپس'],
  ['B35.3', 'کچلی پا (پای ورزشکار)', 'Tinea pedis', 'قارچ پا'],
  ['B37.3', 'کاندیدیازیس واژن و ولو', 'Candidiasis of vulva and vagina', 'قارچ واژن عفونت قارچی'],
  ['B86', 'گال', 'Scabies', 'گال جرب'],
  ['N39.0', 'عفونت دستگاه ادراری، محل نامشخص', 'Urinary tract infection, site not specified', 'عفونت ادراری uti'],
  ['N30.0', 'سیستیت حاد', 'Acute cystitis', 'عفونت مثانه سیستیت'],
  ['H66.9', 'اوتیت میانی، نامشخص', 'Otitis media, unspecified', 'عفونت گوش میانی'],
  ['H60.9', 'اوتیت خارجی، نامشخص', 'Otitis externa, unspecified', 'عفونت گوش خارجی'],
  ['H10.9', 'کونژنکتیویت، نامشخص', 'Conjunctivitis, unspecified', 'ورم ملتحمه چشم قرمز'],
  ['H61.2', 'جرم گوش (سرومن نهفته)', 'Impacted cerumen', 'جرم گوش واکس'],
  ['L01.0', 'زرد زخم (ایمپتیگو)', 'Impetigo', 'زردزخم'],
  ['L03.9', 'سلولیت، نامشخص', 'Cellulitis, unspecified', 'سلولیت عفونت پوست'],
  // digestive
  ['K21.9', 'ریفلاکس معده به مری بدون ازوفاژیت', 'Gastro-oesophageal reflux disease without oesophagitis', 'ریفلاکس سوزش سر دل gerd'],
  ['K29.7', 'گاستریت، نامشخص', 'Gastritis, unspecified', 'گاستریت ورم معده'],
  ['K30', 'سوءهاضمه عملکردی (دیس‌پپسی)', 'Functional dyspepsia', 'سوهاضمه دیسپپسی نفخ'],
  ['K25.9', 'زخم معده، نامشخص', 'Gastric ulcer, unspecified', 'زخم معده'],
  ['K58.9', 'سندرم روده تحریک‌پذیر بدون اسهال', 'Irritable bowel syndrome without diarrhoea', 'روده تحریک پذیر ibs'],
  ['K59.0', 'یبوست', 'Constipation', 'یبوست'],
  ['K52.9', 'گاستروانتریت و کولیت غیرعفونی، نامشخص', 'Noninfective gastroenteritis and colitis, unspecified', 'اسهال غیرعفونی'],
  ['K64.9', 'هموروئید، نامشخص', 'Haemorrhoids, unspecified', 'بواسیر هموروئید'],
  ['K80.2', 'سنگ کیسه صفرا بدون کوله‌سیستیت', 'Calculus of gallbladder without cholecystitis', 'سنگ صفرا'],
  ['K76.0', 'کبد چرب', 'Fatty (change of) liver, not elsewhere classified', 'کبد چرب'],
  ['R10.4', 'درد شکم، سایر و نامشخص', 'Other and unspecified abdominal pain', 'دل درد درد شکم'],
  ['R11', 'تهوع و استفراغ', 'Nausea and vomiting', 'تهوع استفراغ حالت تهوع'],
  ['B98.0', 'هلیکوباکتر پیلوری به‌عنوان عامل بیماری', 'Helicobacter pylori as the cause of diseases classified to other chapters', 'هلیکوباکتر h pylori'],
  // cardiovascular / metabolic
  ['I10', 'فشار خون بالای اولیه', 'Essential (primary) hypertension', 'فشار خون هایپرتانسیون'],
  ['I20.9', 'آنژین صدری، نامشخص', 'Angina pectoris, unspecified', 'آنژین درد قفسه سینه قلبی'],
  ['I25.1', 'بیماری آترواسکلروتیک قلب', 'Atherosclerotic heart disease', 'بیماری عروق کرونر'],
  ['I48.9', 'فیبریلاسیون دهلیزی، نامشخص', 'Atrial fibrillation and flutter, unspecified', 'فیبریلاسیون دهلیزی af'],
  ['I50.9', 'نارسایی قلب، نامشخص', 'Heart failure, unspecified', 'نارسایی قلب'],
  ['I83.9', 'واریس اندام تحتانی', 'Varicose veins of lower extremities without ulcer or inflammation', 'واریس'],
  ['R00.2', 'تپش قلب', 'Palpitations', 'تپش قلب'],
  ['E11.9', 'دیابت نوع ۲ بدون عارضه', 'Type 2 diabetes mellitus without complications', 'دیابت قند'],
  ['E10.9', 'دیابت نوع ۱ بدون عارضه', 'Type 1 diabetes mellitus without complications', 'دیابت نوع یک'],
  ['R73.0', 'تست تحمل گلوکز غیرطبیعی (پیش‌دیابت)', 'Abnormal glucose tolerance test', 'پیش دیابت'],
  ['E78.0', 'هیپرکلسترولمی خالص', 'Pure hypercholesterolaemia', 'کلسترول بالا'],
  ['E78.5', 'هیپرلیپیدمی، نامشخص', 'Hyperlipidaemia, unspecified', 'چربی خون بالا'],
  ['E03.9', 'کم‌کاری تیروئید، نامشخص', 'Hypothyroidism, unspecified', 'کم کاری تیروئید هیپوتیروئیدی'],
  ['E05.9', 'پرکاری تیروئید، نامشخص', 'Thyrotoxicosis, unspecified', 'پرکاری تیروئید'],
  ['E55.9', 'کمبود ویتامین D، نامشخص', 'Vitamin D deficiency, unspecified', 'کمبود ویتامین دی'],
  ['E66.9', 'چاقی، نامشخص', 'Obesity, unspecified', 'چاقی اضافه وزن'],
  ['D50.9', 'کم‌خونی فقر آهن، نامشخص', 'Iron deficiency anaemia, unspecified', 'کم خونی فقر آهن آنمی'],
  ['D64.9', 'کم‌خونی، نامشخص', 'Anaemia, unspecified', 'کم خونی'],
  ['E86', 'کم‌آبی بدن', 'Volume depletion', 'دهیدراتاسیون کم آبی'],
  ['M10.9', 'نقرس، نامشخص', 'Gout, unspecified', 'نقرس'],
  // neuro / psych
  ['G43.9', 'میگرن، نامشخص', 'Migraine, unspecified', 'میگرن'],
  ['G44.2', 'سردرد تنشی', 'Tension-type headache', 'سردرد تنشی'],
  ['R51', 'سردرد', 'Headache', 'سردرد'],
  ['R42', 'سرگیجه', 'Dizziness and giddiness', 'سرگیجه'],
  ['H81.1', 'سرگیجه وضعیتی حمله‌ای خوش‌خیم', 'Benign paroxysmal vertigo', 'bppv سرگیجه وضعیتی'],
  ['G47.0', 'اختلال در شروع و حفظ خواب (بی‌خوابی)', 'Disorders of initiating and maintaining sleep [insomnias]', 'بی خوابی'],
  ['F51.0', 'بی‌خوابی غیرعضوی', 'Nonorganic insomnia', 'بی خوابی'],
  ['G40.9', 'صرع، نامشخص', 'Epilepsy, unspecified', 'صرع تشنج'],
  ['G56.0', 'سندرم تونل کارپ', 'Carpal tunnel syndrome', 'تونل کارپال'],
  ['G51.0', 'فلج بل', "Bell's palsy", 'فلج صورت'],
  ['F32.9', 'اپیزود افسردگی، نامشخص', 'Depressive episode, unspecified', 'افسردگی'],
  ['F33.9', 'اختلال افسردگی عودکننده، نامشخص', 'Recurrent depressive disorder, unspecified', 'افسردگی عودکننده'],
  ['F41.1', 'اختلال اضطراب منتشر', 'Generalized anxiety disorder', 'اضطراب gad'],
  ['F41.0', 'اختلال هراس (پانیک)', 'Panic disorder', 'حمله پانیک'],
  ['F41.9', 'اختلال اضطرابی، نامشخص', 'Anxiety disorder, unspecified', 'اضطراب'],
  ['F42.9', 'اختلال وسواسی-جبری، نامشخص', 'Obsessive-compulsive disorder, unspecified', 'وسواس ocd'],
  ['F43.1', 'اختلال استرس پس از سانحه', 'Post-traumatic stress disorder', 'ptsd'],
  ['F43.2', 'اختلال سازگاری', 'Adjustment disorders', 'سازگاری'],
  ['F90.0', 'اختلال کمبود توجه و بیش‌فعالی', 'Disturbance of activity and attention (ADHD)', 'بیش فعالی adhd'],
  ['F31.9', 'اختلال دوقطبی، نامشخص', 'Bipolar affective disorder, unspecified', 'دوقطبی'],
  // musculoskeletal
  ['M54.5', 'کمردرد', 'Low back pain', 'کمر درد'],
  ['M54.2', 'گردن‌درد', 'Cervicalgia', 'گردن درد'],
  ['M54.1', 'رادیکولوپاتی', 'Radiculopathy', 'سیاتیک رادیکولوپاتی'],
  ['M54.3', 'سیاتیک', 'Sciatica', 'سیاتیک'],
  ['M17.9', 'آرتروز زانو، نامشخص', 'Gonarthrosis, unspecified', 'آرتروز زانو'],
  ['M19.9', 'آرتروز، نامشخص', 'Arthrosis, unspecified', 'آرتروز استئوآرتریت'],
  ['M25.5', 'درد مفصل', 'Pain in joint', 'درد مفصل'],
  ['M79.1', 'درد عضلانی (میالژی)', 'Myalgia', 'درد عضلانی'],
  ['M75.1', 'سندرم روتاتور کاف', 'Rotator cuff syndrome', 'شانه روتاتور'],
  ['M77.1', 'اپی‌کندیلیت خارجی (آرنج تنیس‌بازان)', 'Lateral epicondylitis', 'آرنج تنیس'],
  ['M72.2', 'فاسیئیت کف پا', 'Plantar fascial fibromatosis (plantar fasciitis)', 'خار پاشنه فاسیت'],
  ['M81.9', 'پوکی استخوان، نامشخص', 'Osteoporosis, unspecified', 'پوکی استخوان'],
  ['M06.9', 'آرتریت روماتوئید، نامشخص', 'Rheumatoid arthritis, unspecified', 'روماتیسم مفصلی'],
  ['S93.4', 'پیچ‌خوردگی مچ پا', 'Sprain and strain of ankle', 'پیچ خوردگی مچ'],
  ['T14.0', 'آسیب سطحی، ناحیه نامشخص', 'Superficial injury of unspecified body region', 'خراشیدگی'],
  // skin
  ['L20.9', 'درماتیت آتوپیک (اگزما)، نامشخص', 'Atopic dermatitis, unspecified', 'اگزما'],
  ['L30.9', 'درماتیت، نامشخص', 'Dermatitis, unspecified', 'درماتیت'],
  ['L23.9', 'درماتیت تماسی آلرژیک', 'Allergic contact dermatitis, unspecified cause', 'حساسیت پوستی تماسی'],
  ['L50.9', 'کهیر، نامشخص', 'Urticaria, unspecified', 'کهیر'],
  ['L70.0', 'آکنه ولگاریس', 'Acne vulgaris', 'جوش آکنه'],
  ['L40.0', 'پسوریازیس ولگاریس', 'Psoriasis vulgaris', 'پسوریازیس'],
  ['L21.9', 'درماتیت سبورئیک', 'Seborrhoeic dermatitis, unspecified', 'شوره سبوره'],
  ['L63.9', 'ریزش موی سکه‌ای', 'Alopecia areata, unspecified', 'ریزش مو سکه ای'],
  ['L64.9', 'ریزش موی آندروژنیک', 'Androgenic alopecia, unspecified', 'ریزش مو طاسی'],
  ['L80', 'ویتیلیگو (پیسی)', 'Vitiligo', 'پیسی لک سفید'],
  ['B07', 'زگیل ویروسی', 'Viral warts', 'زگیل'],
  ['L29.9', 'خارش، نامشخص', 'Pruritus, unspecified', 'خارش'],
  ['R21', 'بثورات پوستی', 'Rash and other nonspecific skin eruption', 'راش بثورات'],
  // genitourinary / women
  ['N20.0', 'سنگ کلیه', 'Calculus of kidney', 'سنگ کلیه'],
  ['N40', 'بزرگی پروستات', 'Hyperplasia of prostate', 'پروستات bph'],
  ['N94.6', 'دیسمنوره، نامشخص', 'Dysmenorrhoea, unspecified', 'درد قاعدگی'],
  ['N92.6', 'قاعدگی نامنظم، نامشخص', 'Irregular menstruation, unspecified', 'نامنظمی قاعدگی'],
  ['N95.1', 'یائسگی و حالات کلیماکتریک', 'Menopausal and female climacteric states', 'یائسگی'],
  ['N76.0', 'واژینیت حاد', 'Acute vaginitis', 'واژینیت عفونت واژن'],
  ['E28.2', 'سندرم تخمدان پلی‌کیستیک', 'Polycystic ovarian syndrome', 'تخمدان پلی کیستیک pcos'],
  ['O21.0', 'استفراغ خفیف بارداری', 'Mild hyperemesis gravidarum', 'ویار تهوع بارداری'],
  ['Z34.9', 'نظارت بر بارداری طبیعی', 'Supervision of normal pregnancy, unspecified', 'مراقبت بارداری'],
  ['N52.9', 'اختلال نعوظ', 'Male erectile dysfunction, unspecified', 'ناتوانی جنسی'],
  // ENT / eye / dental
  ['H65.9', 'اوتیت میانی غیرچرکی', 'Nonsuppurative otitis media, unspecified', 'گوش میانی'],
  ['H93.1', 'وزوز گوش', 'Tinnitus', 'وزوز'],
  ['J34.2', 'انحراف تیغه بینی', 'Deviated nasal septum', 'انحراف بینی'],
  ['R04.0', 'خون‌دماغ', 'Epistaxis', 'خون دماغ'],
  ['H00.0', 'گل‌مژه', 'Hordeolum and other deep inflammation of eyelid', 'گل مژه'],
  ['H04.1', 'خشکی چشم', 'Other disorders of lacrimal gland (dry eye)', 'خشکی چشم'],
  ['K04.7', 'آبسه دندان', 'Periapical abscess without sinus', 'آبسه دندان'],
  ['K12.0', 'آفت دهان', 'Recurrent oral aphthae', 'آفت'],
  // symptoms / general
  ['R50.9', 'تب، نامشخص', 'Fever, unspecified', 'تب'],
  ['R05', 'سرفه', 'Cough', 'سرفه'],
  ['R06.0', 'تنگی نفس', 'Dyspnoea', 'تنگی نفس'],
  ['R07.4', 'درد قفسه سینه، نامشخص', 'Chest pain, unspecified', 'درد قفسه سینه'],
  ['R53', 'ضعف و خستگی', 'Malaise and fatigue', 'خستگی ضعف'],
  ['R63.4', 'کاهش وزن غیرطبیعی', 'Abnormal weight loss', 'کاهش وزن'],
  ['R19.7', 'اسهال، نامشخص', 'Diarrhoea, unspecified', 'اسهال'],
  ['R30.0', 'سوزش ادرار', 'Dysuria', 'سوزش ادرار'],
  ['R35', 'تکرر ادرار', 'Polyuria', 'تکرر ادرار'],
  ['R55', 'غش و سنکوپ', 'Syncope and collapse', 'غش سنکوپ'],
  ['R59.0', 'بزرگی موضعی غدد لنفاوی', 'Localized enlarged lymph nodes', 'غدد لنفاوی'],
  ['T78.4', 'آلرژی، نامشخص', 'Allergy, unspecified', 'آلرژی حساسیت'],
  ['T78.3', 'آنژیوادم', 'Angioneurotic oedema', 'آنژیوادم تورم صورت'],
  ['Z00.0', 'معاینه عمومی سلامت', 'General medical examination', 'چکاپ'],
  ['Z09', 'معاینه پیگیری پس از درمان', 'Follow-up examination after treatment', 'پیگیری'],
  ['Z71.1', 'نگرانی بدون یافته بیماری', 'Person with feared complaint in whom no diagnosis is made', 'نگرانی'],
  ['Z76.0', 'مراجعه برای تمدید نسخه', 'Issue of repeat prescription', 'تمدید نسخه'],
  ['Z72.0', 'مصرف دخانیات', 'Tobacco use', 'سیگار'],
  // paediatrics
  ['P59.9', 'زردی نوزادی، نامشخص', 'Neonatal jaundice, unspecified', 'زردی نوزاد'],
  ['L22', 'درماتیت پوشک', 'Diaper [napkin] dermatitis', 'سوختگی پای کودک'],
  ['R62.8', 'تأخیر در رشد', 'Other lack of expected normal physiological development', 'رشد کم'],
  ['B80', 'کرمک (انتروبیازیس)', 'Enterobiasis', 'کرمک'],
  ['A08.4', 'عفونت ویروسی روده، نامشخص', 'Viral intestinal infection, unspecified', 'اسهال ویروسی'],
];

export const ICD10 = C.map(([code, fa, en, terms]) => ({ code, label_fa: fa, label_en: en, search: normalizeFa(`${code} ${fa} ${en} ${terms ?? ''}`) }));
const BY_CODE = new Map(ICD10.map((x) => [x.code, x]));
export const icdByCode = (code) => BY_CODE.get(String(code ?? '').toUpperCase().trim()) ?? null;

export function searchIcd(q, limit = 12) {
  const t = normalizeFa(q).replace(/[‌]/g, ' ').trim();
  if (!t) return [];
  const words = t.split(/\s+/);
  const scored = [];
  for (const x of ICD10) {
    if (!words.every((w) => x.search.includes(w))) continue;
    let s = 0;
    if (x.code.toLowerCase().startsWith(t)) s += 10;
    if (normalizeFa(x.label_fa).startsWith(t)) s += 5;
    s -= x.label_fa.length / 100;
    scored.push([s, x]);
  }
  return scored.sort((a, b) => b[0] - a[0]).slice(0, limit).map(([, x]) => ({ code: x.code, label_fa: x.label_fa, label_en: x.label_en }));
}
