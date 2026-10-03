// Knowledge base + retrieval (RAG). Production: chunking → embedding → pgvector → rerank.
// Here: BM25 over normalised Persian tokens with the same contract (chunks + score + citation).
// NOTE: content below is sample text and must be reviewed by the clinical advisor before use.
import { normalizeFa } from '../../lib/fa.js';

export const KB_VERSION = 'kb-2026.10-draft';

export const KB = [
  {
    id: 'kb-visit-how', title: 'ویزیت آنلاین چگونه انجام می‌شود؟',
    text: 'برای ویزیت آنلاین ابتدا نوبت رزرو می‌کنید. در زمان نوبت از بخش «نوبت‌های من» وارد اتاق ویزیت می‌شوید. ویزیت می‌تواند ویدیویی، صوتی یا متنی (چت) باشد. پزشک پس از گفتگو در صورت نیاز نسخه الکترونیک صادر می‌کند.',
  },
  {
    id: 'kb-visit-prepare', title: 'آمادگی پیش از ویزیت ویدیویی',
    text: 'پیش از شروع ویزیت در مکانی آرام و پرنور قرار بگیرید، اینترنت پایدار داشته باشید و فهرست داروهای مصرفی، حساسیت‌ها و سوابق بیماری خود را آماده کنید. ورود به اتاق ویزیت از ۱۵ دقیقه قبل از زمان نوبت ممکن است.',
  },
  {
    id: 'kb-cancel', title: 'لغو یا جابه‌جایی نوبت',
    text: 'نوبت را می‌توانید از بخش «نوبت‌های من» لغو یا جابه‌جا کنید. پس از لغو، پیامک تأیید ارسال می‌شود و زمان آزادشده برای بیماران دیگر قابل رزرو است.',
  },
  {
    id: 'kb-prescription', title: 'نسخه الکترونیک',
    text: 'نسخه فقط توسط پزشک و پس از ویزیت صادر می‌شود و با امضای دیجیتال پزشک معتبر است. دستیار هوشمند نسخه صادر نمی‌کند و دوز دارو اعلام نمی‌کند. نسخه صادرشده در بخش «نسخه‌ها» قابل مشاهده است و داروخانه می‌تواند اعتبار آن را بررسی کند.',
  },
  {
    id: 'kb-privacy', title: 'حریم خصوصی و رضایت‌نامه‌ها',
    text: 'اطلاعات سلامت شما در مراکز داده داخل کشور و به‌صورت رمزنگاری‌شده ذخیره و نگهداری می‌شود. دسترسی دستیار به سوابق پزشکی شما فقط با رضایت‌نامه جداگانه ممکن است. ضبط ویزیت فقط با رضایت شما انجام می‌شود و داده شما بدون رضایت برای آموزش مدل استفاده نمی‌شود. از بخش «حریم خصوصی» می‌توانید رضایت‌ها را تغییر دهید یا داده‌های خود را دریافت کنید.',
  },
  {
    id: 'kb-emergency', title: 'چه زمانی باید به اورژانس مراجعه کرد؟',
    text: 'در صورت درد قفسه سینه، تنگی نفس شدید، کاهش هوشیاری، تشنج، فلج یا بی‌حسی ناگهانی یک طرف بدن، خونریزی شدید یا افکار آسیب به خود، فوراً با اورژانس ۱۱۵ تماس بگیرید. ویزیت آنلاین جایگزین اورژانس نیست.',
  },
  {
    id: 'kb-cold', title: 'مراقبت‌های عمومی در سرماخوردگی',
    text: 'در سرماخوردگی معمولاً استراحت کافی، نوشیدن مایعات و تغذیه مناسب توصیه می‌شود. اگر تب بیش از سه روز طول کشید، تنگی نفس داشتید یا حالتان بدتر شد، با پزشک مشورت کنید. برای مصرف هر دارو با پزشک یا داروساز مشورت کنید.',
  },
  {
    id: 'kb-fever', title: 'اطلاعات عمومی درباره تب',
    text: 'تب واکنش بدن به عوامل مختلف است. نوشیدن مایعات و استراحت کمک می‌کند. تب در نوزاد زیر سه ماه، تب بیش از سه روز، تب همراه با گردن‌درد شدید، بثورات پوستی یا کاهش هوشیاری نیاز به ارزیابی فوری پزشک دارد.',
  },
  {
    id: 'kb-network', title: 'اینترنت ضعیف در هنگام ویزیت',
    text: 'اگر کیفیت اینترنت پایین باشد، ویزیت به‌طور خودکار از ویدیو به صوت و در صورت نیاز به چت متنی تغییر می‌کند تا گفتگو با پزشک قطع نشود.',
  },
  {
    id: 'kb-assistant', title: 'دستیار هوشمند چه کارهایی انجام می‌دهد؟',
    text: 'دستیار هوشمند به پرسش‌های عمومی پاسخ می‌دهد، علائم شما را برای تعیین فوریت بررسی می‌کند و برایتان نوبت می‌گیرد. دستیار تشخیص بیماری نمی‌دهد، دارو تجویز نمی‌کند و تصمیم‌های درمانی فقط با پزشک است. هر زمان بخواهید می‌توانید با اپراتور انسانی صحبت کنید.',
  },
  {
    id: 'kb-hours', title: 'ساعت کاری، زمان ویزیت‌ها و انتخاب پزشک',
    text: 'ساعت کاری هر پزشک متفاوت است؛ هر پزشک تقویم کاری خود را منتشر می‌کند و زمان‌های آزاد در هنگام رزرو نمایش داده می‌شود. می‌توانید بر اساس تخصص پزشک را انتخاب کنید یا از دستیار بخواهید بر اساس علائم، تخصص مناسب را پیشنهاد دهد.',
  },
  {
    id: 'kb-login', title: 'ورود و ثبت‌نام',
    text: 'ورود با شماره موبایل و کد یکبار مصرف پیامکی انجام می‌شود. پس از اولین ورود، پروفایل خود شامل نام، کد ملی و تاریخ تولد را تکمیل کنید. پزشکان علاوه بر کد پیامکی، تأیید دومرحله‌ای دارند.',
  },
];

const STOP = new Set(['و', 'در', 'به', 'از', 'که', 'این', 'آن', 'ان', 'را', 'با', 'برای', 'است', 'هست', 'می', 'یا', 'تا',
  'من', 'ما', 'شما', 'چه', 'چی', 'چیه', 'چطور', 'چگونه', 'آیا', 'ایا', 'هم', 'یک', 'یه', 'کنم', 'کنید', 'میشه', 'شود',
  'بر', 'اگر', 'باید', 'دارم', 'دارید', 'رو', 'های', 'ها', 'کرد', 'کنیم', 'بکنم', 'هستم', 'خودم', 'خود']);

export function tokenize(text) {
  return normalizeFa(text)
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(' ')
    .map((w) => w.replace(/^(می|نمی)(?=\S{3,})/, ''))
    .filter((w) => w && !STOP.has(w));
}

// Light morphology: Persian attaches pronoun/plural suffixes, so a query token matches a
// document token when one is a prefix of the other and they differ by at most 3 letters.
const near = (q, d) => q === d || (Math.min(q.length, d.length) >= 3 && Math.abs(q.length - d.length) <= 3 &&
  (d.startsWith(q) || q.startsWith(d)));

export function buildIndex(docs) {
  const items = docs.map((d) => {
    const toks = tokenize(`${d.title} ${d.title} ${d.text}`);
    return { doc: d, toks, len: toks.length };
  });
  const N = items.length;
  const avg = items.reduce((a, b) => a + b.len, 0) / Math.max(N, 1);
  const tfOf = (it, q) => it.toks.reduce((n, t) => n + (near(q, t) ? 1 : 0), 0);
  const idf = (q) => {
    const df = items.filter((it) => it.toks.some((t) => near(q, t))).length;
    return { df, w: Math.log(1 + (N - df + 0.5) / (df + 0.5)) };
  };

  return {
    search(query, k = 3) {
      const q = [...new Set(tokenize(query))];
      if (!q.length) return [];
      const weights = new Map(q.map((t) => [t, idf(t)]));
      const maxPossible = q.reduce((a, t) => a + (weights.get(t).df ? weights.get(t).w : 0), 0) || 1;
      return items
        .map((it) => {
          let s = 0;
          let matched = 0;
          for (const t of q) {
            const f = tfOf(it, t);
            if (!f) continue;
            matched++;
            s += weights.get(t).w * ((f * 2.2) / (f + 1.2 * (0.25 + 0.75 * (it.len / avg))));
          }
          // confidence blends query coverage with score strength (0..1)
          const confidence = Math.min(1, 0.6 * (matched / q.length) + 0.4 * Math.min(1, s / (maxPossible * 1.2)));
          return { id: it.doc.id, title: it.doc.title, text: it.doc.text, score: s, confidence };
        })
        .filter((r) => r.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, k);
    },
  };
}

export const kbIndex = buildIndex(KB);
