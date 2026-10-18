import { formatJalaliDate, formatJalaliLong, toPersianDigits } from '@kx/shared';
import { AlignmentType, BorderStyle, Document, Packer, Paragraph, TextRun } from 'docx';
import { one, query } from '../db/pool.js';
import { notFound } from '../lib/errors.js';

/**
 * Letter of a national proposal (نامه پیشنهاد ملی). The draft is assembled from the network's data
 * (originating resolution, supporting chambers and their comments); the coordinator edits and exports it.
 * The draft engine is a template for now; a chat model can later rewrite the same data into fluent prose.
 */

export interface LetterData {
  network: { id: string; name: string };
  resolution: { id: string; number: string; text: string; addressee: string | null; share_note: string | null; due_date: string | null };
  origin: { commission: string; chamber: string; province: string };
  endorsements: { commission: string; chamber: string; province: string; comment: string | null }[];
  coordinators: string[];
  proposal: { status: string; reached_at: Date };
}

export interface Letter {
  addressee: string;
  subject: string;
  body: string;
}

export async function loadLetterData(networkId: string, resolutionId: string): Promise<LetterData> {
  const row = await one(
    `SELECT n.id AS network_id, n.name AS network_name, r.id, r.number, r.text, r.addressee, r.share_note, r.due_date::text,
            c.name AS commission, ch.name AS chamber, ch.province, p.status, p.reached_at
       FROM network_proposals p JOIN networks n ON n.id = p.network_id JOIN resolutions r ON r.id = p.resolution_id
       JOIN commissions c ON c.id = r.commission_id JOIN chambers ch ON ch.id = r.chamber_id
      WHERE p.network_id = $1 AND p.resolution_id = $2`,
    [networkId, resolutionId],
  );
  if (!row) throw notFound('پیشنهاد ملی یافت نشد');
  const endorsements = await query(
    `SELECT c.name AS commission, ch.name AS chamber, ch.province, e.comment
       FROM resolution_endorsements e JOIN commissions c ON c.id = e.commission_id JOIN chambers ch ON ch.id = e.chamber_id
      WHERE e.resolution_id = $1 AND e.commission_id IN (SELECT commission_id FROM network_commissions WHERE network_id = $2)
      ORDER BY e.created_at`,
    [resolutionId, networkId],
  );
  const coordinators = await query<{ full_name: string }>(
    `SELECT u.full_name FROM network_coordinators k JOIN users u ON u.id = k.user_id WHERE k.network_id = $1 ORDER BY u.full_name`,
    [networkId],
  );
  return {
    network: { id: row.network_id, name: row.network_name },
    resolution: { id: row.id, number: row.number, text: row.text, addressee: row.addressee, share_note: row.share_note, due_date: row.due_date },
    origin: { commission: row.commission, chamber: row.chamber, province: row.province },
    endorsements,
    coordinators: coordinators.map((c) => c.full_name),
    proposal: { status: row.status, reached_at: row.reached_at },
  };
}

const fa = (v: string | number) => toPersianDigits(String(v));
const ordinal = ['اول', 'دوم', 'سوم', 'چهارم', 'پنجم', 'ششم', 'هفتم', 'هشتم', 'نهم', 'دهم'];

/** Persian list «الف، ب و ج». */
function joinFa(items: string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join('، ')} و ${items[items.length - 1]}`;
}

/** Short subject from the resolution text (first clause, at most ~12 words). */
function topic(text: string): string {
  const first = text.split(/[.؛\n]/)[0].trim();
  const words = first.split(/\s+/);
  return words.length > 12 ? `${words.slice(0, 12).join(' ')}…` : first;
}

export function draftLetter(d: LetterData): Letter {
  const provinces = [d.origin.province, ...d.endorsements.map((e) => e.province)].filter((p, i, a) => a.indexOf(p) === i);
  const lines: string[] = [];
  lines.push('با سلام و احترام،');
  lines.push(
    `به استحضار می‌رساند موضوع «${d.resolution.text.trim()}» در ${d.origin.commission} ${d.origin.chamber} به‌عنوان مصوبه شماره ${d.resolution.number} به تصویب رسید و در ${d.network.name} برای کمیسیون‌های هم‌موضوع اتاق‌های بازرگانی سایر استان‌ها به اشتراک گذاشته شد.`,
  );
  if (d.resolution.share_note) lines.push(`کمیسیون مبدأ در توضیح این مصوبه اعلام کرده است: «${d.resolution.share_note.trim()}»`);
  if (d.endorsements.length) {
    lines.push(
      `این موضوع تاکنون مورد حمایت کمیسیون‌های تخصصی ${fa(d.endorsements.length)} اتاق دیگر قرار گرفته و در مجموع در ${fa(provinces.length)} استان (${joinFa(provinces)}) به‌عنوان مسئله مشترک فعالان اقتصادی مطرح است. خلاصه دیدگاه کمیسیون‌های حامی به شرح زیر است:`,
    );
    d.endorsements.forEach((e, i) => {
      lines.push(`${ordinal[i] ?? fa(i + 1)}- ${e.commission} (${e.chamber})${e.comment ? `: ${e.comment.trim()}` : ': حمایت از مصوبه بدون توضیح تکمیلی.'}`);
    });
  }
  lines.push(
    `با توجه به فراگیر بودن این مسئله در استان‌های یادشده، خواهشمند است دستور فرمایید موضوع در دستور کار قرار گیرد و نتیجه بررسی و تصمیم متخذه به این اتاق اعلام شود تا به کمیسیون‌های تخصصی اتاق‌های استان‌ها منعکس گردد.`,
  );
  lines.push('پیشاپیش از حسن توجه و همکاری جنابعالی سپاسگزاری می‌شود.');
  return {
    addressee: d.resolution.addressee?.trim() || '',
    subject: `پیشنهاد ملی ${d.network.name}: ${topic(d.resolution.text)}`,
    body: lines.join('\n\n'),
  };
}

// ─────────────────────────────── Word (.docx) ───────────────────────────────

const FONT = 'Tahoma';
const run = (text: string, opts: { bold?: boolean; size?: number; color?: string } = {}) =>
  new TextRun({ text, rightToLeft: true, font: { name: FONT, hint: 'cs' }, bold: opts.bold, boldComplexScript: opts.bold, size: opts.size ?? 24, sizeComplexScript: opts.size ?? 24, color: opts.color });
const para = (children: TextRun[], opts: { align?: (typeof AlignmentType)[keyof typeof AlignmentType]; after?: number; border?: boolean } = {}) =>
  new Paragraph({
    bidirectional: true,
    alignment: opts.align ?? AlignmentType.BOTH,
    spacing: { after: opts.after ?? 160, line: 360 },
    border: opts.border ? { bottom: { style: BorderStyle.SINGLE, size: 6, color: '0F4C5C', space: 6 } } : undefined,
    children,
  });

export async function buildLetterDocx(letter: Letter, d: LetterData, signer: string | null): Promise<Buffer> {
  const children: Paragraph[] = [
    para([run('اتاق بازرگانی، صنایع، معادن و کشاورزی ایران', { bold: true, size: 26, color: '0F4C5C' })], { align: AlignmentType.CENTER, after: 40 }),
    para([run(d.network.name, { size: 22, color: '5D6D78' })], { align: AlignmentType.CENTER, after: 200, border: true }),
    para([run('تاریخ: ', { bold: true, size: 20 }), run(fa(formatJalaliDate(new Date(), false)), { size: 20 })], { align: AlignmentType.END, after: 40 }),
    para([run('پیوست: ', { bold: true, size: 20 }), run(`مصوبه ${d.resolution.number} و حمایت ${fa(d.endorsements.length)} کمیسیون`, { size: 20 })], { align: AlignmentType.END, after: 240 }),
  ];
  if (letter.addressee) children.push(para([run(letter.addressee, { bold: true })], { align: AlignmentType.START }));
  children.push(para([run('موضوع: ', { bold: true }), run(letter.subject)], { align: AlignmentType.START, after: 240 }));
  for (const p of letter.body.split(/\n{2,}/)) {
    const lines = p.split('\n');
    children.push(para(lines.flatMap((l, i) => (i ? [new TextRun({ break: 1 }), run(l)] : [run(l)]))));
  }
  children.push(para([run(signer || 'دبیر شبکه', { bold: true })], { align: AlignmentType.END, after: 40 }));
  children.push(para([run(`دبیر ${d.network.name}`, { size: 20, color: '5D6D78' })], { align: AlignmentType.END, after: 400 }));
  children.push(
    para([run(`این نامه بر اساس داده‌های سامانه کمیسیون‌های تخصصی در ${formatJalaliLong(new Date())} تهیه شده است.`, { size: 16, color: '8A99A3' })], {
      align: AlignmentType.CENTER,
    }),
  );
  const doc = new Document({
    creator: 'سامانه کمیسیون‌های تخصصی',
    title: letter.subject,
    styles: { default: { document: { run: { font: FONT, rightToLeft: true } } } },
    sections: [{ properties: { page: { margin: { top: 1200, bottom: 1200, left: 1300, right: 1300 } } }, children }],
  });
  return Packer.toBuffer(doc);
}
