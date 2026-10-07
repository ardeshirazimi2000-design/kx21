import {
  formatJalaliDate,
  formatJalaliLong,
  MEETING_STATUS_LABELS,
  RESOLUTION_STATUS_LABELS,
  roleLabel,
  toPersianDigits,
  type MeetingStatus,
  type ResolutionStatus,
} from '@kx/shared';
import {
  AlignmentType,
  BorderStyle,
  Document,
  HeadingLevel,
  Packer,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from 'docx';
import * as pptxNs from 'pptxgenjs';
import { one, query } from '../db/pool.js';

/**
 * Periodic activity report of a commission (گزارش دوره‌ای فعالیت کمیسیون):
 * meetings held, attendance, decisions, resolutions and their follow-up, expert referrals.
 */
export interface ActivityData {
  commission: { id: string; name: string; code: string; domain: string | null; chamber: string; term: string };
  officers: { role: string; full_name: string }[];
  from: string;
  to: string;
  meetings: {
    id: string;
    number: number;
    title: string;
    scheduled_at: string;
    status: MeetingStatus;
    eligible: number;
    attended: number;
    agenda: { title: string; status: string; decision: string | null }[];
  }[];
  attendance: { full_name: string; role: string; role_title: string | null; meetings: number; attended: number; excused: number }[];
  resolutions: {
    number: string;
    text: string;
    owner_name: string | null;
    addressee: string | null;
    due_date: string | null;
    status: ResolutionStatus;
    progress: number;
    is_overdue: boolean;
    created_at: string;
  }[];
  openFromBefore: number;
  referrals: { total: number; answered: number };
  votes: { total: number; passed: number };
}

export async function loadActivityData(commissionId: string, from: string, to: string): Promise<ActivityData> {
  const c = (await one(
    `SELECT c.id, c.name, c.code, c.domain, ch.name AS chamber, t.title AS term
       FROM commissions c JOIN chambers ch ON ch.id = c.chamber_id JOIN terms t ON t.id = c.term_id WHERE c.id = $1`,
    [commissionId],
  ))!;
  const range = [commissionId, from, to];
  const [officers, meetings, attendance, resolutions, openBefore, referrals, votes] = await Promise.all([
    query(
      `SELECT m.position AS role, u.full_name FROM commission_memberships m JOIN users u ON u.id = m.user_id
        WHERE m.commission_id = $1 AND m.status = 'active' AND m.position IN ('chair','vice_chair','secretary')
        ORDER BY array_position(ARRAY['chair','vice_chair','secretary'], m.position)`,
      [commissionId],
    ),
    query(
      `SELECT m.id, m.number, m.title, m.scheduled_at, m.status,
              (SELECT count(*) FROM meeting_invitees i WHERE i.meeting_id = m.id AND i.has_vote) AS eligible,
              (SELECT count(*) FROM attendance a JOIN meeting_invitees i ON i.meeting_id = a.meeting_id AND i.user_id = a.user_id
                WHERE a.meeting_id = m.id AND i.has_vote AND a.status IN ('present','online','proxy','manual_present')) AS attended,
              COALESCE((SELECT json_agg(json_build_object('title', ai.title, 'status', ai.status, 'decision', ai.decision) ORDER BY ai.order_no)
                 FROM agenda_items ai WHERE ai.meeting_id = m.id AND ai.status <> 'removed'), '[]') AS agenda
         FROM meetings m
        WHERE m.commission_id = $1 AND m.scheduled_at >= $2::date AND m.scheduled_at < $3::date + 1 AND m.status <> 'draft'
        ORDER BY m.scheduled_at`,
      range,
    ),
    query(
      `SELECT u.full_name, i.role, cr.title AS role_title, count(*) AS meetings,
              count(*) FILTER (WHERE a.status IN ('present','online','proxy','manual_present')) AS attended,
              count(*) FILTER (WHERE a.status = 'excused') AS excused
         FROM meetings m JOIN meeting_invitees i ON i.meeting_id = m.id JOIN users u ON u.id = i.user_id
         LEFT JOIN attendance a ON a.meeting_id = m.id AND a.user_id = i.user_id
         LEFT JOIN custom_roles cr ON cr.chamber_id = m.chamber_id AND cr.key = i.role
        WHERE m.commission_id = $1 AND m.scheduled_at >= $2::date AND m.scheduled_at < $3::date + 1
          AND m.status IN ('minutes_draft','pending_approval','approved','archived') AND i.role <> 'guest'
        GROUP BY u.full_name, i.role, cr.title ORDER BY attended DESC, u.full_name`,
      range,
    ),
    query(
      `SELECT r.number, r.text, u.full_name AS owner_name, r.addressee, r.due_date, r.status, r.progress, r.created_at,
              (r.due_date < current_date AND r.status NOT IN ('done','cancelled')) AS is_overdue
         FROM resolutions r LEFT JOIN users u ON u.id = r.owner_id
        WHERE r.commission_id = $1 AND r.created_at >= $2::date AND r.created_at < $3::date + 1
        ORDER BY r.created_at`,
      range,
    ),
    one(
      `SELECT count(*) AS n FROM resolutions WHERE commission_id = $1 AND created_at < $2::date AND status NOT IN ('done','cancelled')`,
      [commissionId, from],
    ),
    one(
      `SELECT count(*) AS total, count(*) FILTER (WHERE status = 'answered') AS answered FROM referrals
        WHERE commission_id = $1 AND created_at >= $2::date AND created_at < $3::date + 1`,
      range,
    ),
    one(
      `SELECT count(*) AS total, count(*) FILTER (WHERE (vs.result->>'passed')::boolean) AS passed
         FROM vote_sessions vs JOIN meetings m ON m.id = vs.meeting_id
        WHERE m.commission_id = $1 AND vs.status = 'closed' AND m.scheduled_at >= $2::date AND m.scheduled_at < $3::date + 1`,
      range,
    ),
  ]);
  return {
    commission: c,
    officers,
    from,
    to,
    meetings: meetings.map((m: any) => ({ ...m, eligible: Number(m.eligible), attended: Number(m.attended) })),
    attendance: attendance.map((a: any) => ({ ...a, meetings: Number(a.meetings), attended: Number(a.attended), excused: Number(a.excused) })),
    resolutions,
    openFromBefore: Number(openBefore?.n ?? 0),
    referrals: { total: Number(referrals?.total ?? 0), answered: Number(referrals?.answered ?? 0) },
    votes: { total: Number(votes?.total ?? 0), passed: Number(votes?.passed ?? 0) },
  };
}

const HELD: MeetingStatus[] = ['minutes_draft', 'pending_approval', 'approved', 'archived'];
const fa = (v: string | number) => toPersianDigits(v);
const jd = (d: string | Date | null) => (d ? formatJalaliDate(typeof d === 'string' && d.length === 10 ? `${d}T12:00:00` : d) : '—');
const pct = (a: number, b: number) => (b ? Math.round((a / b) * 100) : 0);

export function summarize(d: ActivityData) {
  const held = d.meetings.filter((m) => HELD.includes(m.status));
  const cancelled = d.meetings.filter((m) => m.status === 'cancelled').length;
  const eligible = held.reduce((s, m) => s + m.eligible, 0);
  const attended = held.reduce((s, m) => s + m.attended, 0);
  const byStatus: Record<string, number> = {};
  for (const r of d.resolutions) byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
  const agendaItems = held.reduce((s, m) => s + m.agenda.length, 0);
  return {
    held: held.length,
    cancelled,
    attendanceRate: pct(attended, eligible),
    agendaItems,
    resolutions: d.resolutions.length,
    done: byStatus.done ?? 0,
    inProgress: (byStatus.open ?? 0) + (byStatus.in_progress ?? 0) + (byStatus.returned ?? 0) + (byStatus.submitted ?? 0),
    overdue: d.resolutions.filter((r) => r.is_overdue).length,
    byStatus,
  };
}

// ─────────────────────────────── Word (.docx) ───────────────────────────────

const FONT = 'Tahoma';
const run = (text: string, opts: { bold?: boolean; size?: number; color?: string } = {}) =>
  new TextRun({ text, rightToLeft: true, font: { name: FONT, hint: 'cs' }, bold: opts.bold, boldComplexScript: opts.bold, size: opts.size ?? 21, sizeComplexScript: opts.size ?? 21, color: opts.color });
const para = (text: string, opts: { bold?: boolean; size?: number; heading?: (typeof HeadingLevel)[keyof typeof HeadingLevel]; center?: boolean; after?: number; color?: string } = {}) =>
  new Paragraph({
    bidirectional: true,
    heading: opts.heading,
    alignment: opts.center ? AlignmentType.CENTER : AlignmentType.START,
    spacing: { after: opts.after ?? 120 },
    children: [run(text, opts)],
  });

function table(headers: string[], rows: string[][], widths?: number[]) {
  const border = { style: BorderStyle.SINGLE, size: 4, color: 'C9D3D8' };
  const cell = (text: string, header = false, w?: number) =>
    new TableCell({
      width: w ? { size: w, type: WidthType.PERCENTAGE } : undefined,
      shading: header ? { type: ShadingType.CLEAR, fill: '0F4C5C', color: 'auto' } : undefined,
      borders: { top: border, bottom: border, left: border, right: border },
      margins: { top: 60, bottom: 60, left: 80, right: 80 },
      children: [new Paragraph({ bidirectional: true, children: [run(text, { bold: header, size: 19, color: header ? 'FFFFFF' : undefined })] })],
    });
  return new Table({
    visuallyRightToLeft: true,
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [
      new TableRow({ tableHeader: true, children: headers.map((h, i) => cell(h, true, widths?.[i])) }),
      ...rows.map((r) => new TableRow({ children: r.map((v, i) => cell(v, false, widths?.[i])) })),
    ],
  });
}

export async function buildActivityDocx(d: ActivityData): Promise<Buffer> {
  const s = summarize(d);
  const held = d.meetings.filter((m) => HELD.includes(m.status));
  const H = HeadingLevel.HEADING_2;
  const children: (Paragraph | Table)[] = [
    para(d.commission.chamber, { center: true, size: 24, bold: true }),
    para(`گزارش دوره‌ای فعالیت ${d.commission.name}`, { center: true, size: 34, bold: true, color: '0F4C5C' }),
    para(`${d.commission.term} — از ${jd(d.from)} تا ${jd(d.to)}`, { center: true, size: 22, after: 300 }),
    ...(d.officers.length ? [para(d.officers.map((o) => `${roleLabel(o.role)}: ${o.full_name}`).join('    '), { center: true, after: 300 })] : []),

    para('۱. خلاصه عملکرد', { heading: H, bold: true, size: 26 }),
    table(
      ['شاخص', 'مقدار'],
      [
        ['جلسات برگزارشده', fa(s.held)],
        ['جلسات لغوشده', fa(s.cancelled)],
        ['میانگین حضور اعضای دارای حق رأی', `${fa(s.attendanceRate)}٪`],
        ['موضوعات بررسی‌شده در دستور جلسات', fa(s.agendaItems)],
        ['رأی‌گیری‌ها (تصویب‌شده / کل)', `${fa(d.votes.passed)} / ${fa(d.votes.total)}`],
        ['مصوبات ثبت‌شده در دوره', fa(s.resolutions)],
        ['مصوبات انجام‌شده', fa(s.done)],
        ['مصوبات در جریان', fa(s.inProgress)],
        ['مصوبات معوق', fa(s.overdue)],
        ['مصوبات باز از دوره‌های قبل', fa(d.openFromBefore)],
        ['ارجاعات کارشناسی (پاسخ‌داده / کل)', `${fa(d.referrals.answered)} / ${fa(d.referrals.total)}`],
      ],
      [70, 30],
    ),

    para('۲. جلسات برگزارشده', { heading: H, bold: true, size: 26 }),
    held.length
      ? table(
          ['شماره', 'تاریخ', 'عنوان', 'حضور', 'وضعیت'],
          held.map((m) => [fa(m.number), jd(m.scheduled_at), m.title, `${fa(m.attended)} از ${fa(m.eligible)}`, MEETING_STATUS_LABELS[m.status]]),
          [10, 15, 45, 14, 16],
        )
      : para('در این دوره جلسه‌ای برگزار نشده است.'),

    para('۳. موضوعات و تصمیمات جلسات', { heading: H, bold: true, size: 26 }),
    ...held.flatMap((m) => [
      para(`جلسه ${fa(m.number)} — ${formatJalaliLong(m.scheduled_at)}: ${m.title}`, { bold: true }),
      ...(m.agenda.length
        ? m.agenda.map((a, i) => para(`${fa(i + 1)}. ${a.title}${a.decision ? ` — تصمیم: ${a.decision}` : ''}`, { size: 20, after: 60 }))
        : [para('دستور جلسه‌ای ثبت نشده است.', { size: 20 })]),
    ]),

    para('۴. حضور و غیاب اعضا', { heading: H, bold: true, size: 26 }),
    d.attendance.length
      ? table(
          ['نام', 'سمت', 'جلسات', 'حضور', 'غیبت موجه', 'درصد حضور'],
          d.attendance.map((a) => [a.full_name, roleLabel(a.role, a.role_title), fa(a.meetings), fa(a.attended), fa(a.excused), `${fa(pct(a.attended, a.meetings))}٪`]),
          [30, 16, 12, 12, 14, 16],
        )
      : para('اطلاعات حضوری برای این دوره ثبت نشده است.'),

    para('۵. مصوبات و وضعیت پیگیری', { heading: H, bold: true, size: 26 }),
    d.resolutions.length
      ? table(
          ['شماره', 'متن مصوبه', 'مسئول اجرا / مخاطب', 'مهلت', 'وضعیت', 'پیشرفت'],
          d.resolutions.map((r) => [
            fa(r.number),
            r.text,
            [r.owner_name, r.addressee].filter(Boolean).join(' / ') || '—',
            jd(r.due_date),
            `${RESOLUTION_STATUS_LABELS[r.status]}${r.is_overdue ? ' (معوق)' : ''}`,
            `${fa(r.progress)}٪`,
          ]),
          [10, 38, 18, 11, 13, 10],
        )
      : para('در این دوره مصوبه‌ای ثبت نشده است.'),
    para(`این گزارش در تاریخ ${formatJalaliLong(new Date())} از سامانه کمیسیون‌های تخصصی تهیه شده است.`, { size: 18, color: '5D6D78' }),
  ];
  const doc = new Document({
    creator: 'سامانه کمیسیون‌های تخصصی',
    title: `گزارش دوره‌ای ${d.commission.name}`,
    styles: { default: { document: { run: { font: FONT, rightToLeft: true } } } },
    sections: [{ properties: { page: { margin: { top: 1000, bottom: 1000, left: 1000, right: 1000 } } }, children }],
  });
  return Packer.toBuffer(doc);
}

// ─────────────────────────────── PowerPoint (.pptx) ───────────────────────────────

// pptxgenjs ships CJS with a default export; resolve the constructor under both ESM and CJS interop.
const PptxGen: any = (pptxNs as any).default?.default ?? (pptxNs as any).default ?? pptxNs;
type Slide = any;

const PRIMARY = '0F4C5C';
const ACCENT = 'B7791F';

export async function buildActivityPptx(d: ActivityData): Promise<Buffer> {
  const s = summarize(d);
  const held = d.meetings.filter((m) => HELD.includes(m.status));
  const pres = new PptxGen();
  pres.layout = 'LAYOUT_WIDE'; // 13.33 x 7.5 in
  pres.rtlMode = true;
  pres.title = `گزارش دوره‌ای ${d.commission.name}`;
  const T = { fontFace: FONT, rtlMode: true, align: 'right' as const, color: '17232B' };
  const header = (slide: Slide, title: string) => {
    slide.background = { color: 'FFFFFF' };
    slide.addShape(pres.ShapeType.rect, { x: 0, y: 0, w: 13.33, h: 0.9, fill: { color: PRIMARY } });
    slide.addText(title, { ...T, x: 0.5, y: 0.12, w: 12.3, h: 0.66, fontSize: 24, bold: true, color: 'FFFFFF' });
    slide.addText(`${d.commission.name} — ${jd(d.from)} تا ${jd(d.to)}`, { ...T, x: 0.5, y: 7.0, w: 12.3, h: 0.35, fontSize: 11, color: '5D6D78' });
  };

  // 1. Title
  const s1 = pres.addSlide();
  s1.background = { color: PRIMARY };
  s1.addText(d.commission.chamber, { ...T, align: 'center', x: 0.5, y: 1.4, w: 12.3, h: 0.6, fontSize: 20, color: 'D6E6EA' });
  s1.addText(`گزارش دوره‌ای فعالیت\n${d.commission.name}`, { ...T, align: 'center', x: 0.5, y: 2.3, w: 12.3, h: 2.0, fontSize: 40, bold: true, color: 'FFFFFF' });
  s1.addText(`${d.commission.term} — از ${jd(d.from)} تا ${jd(d.to)}`, { ...T, align: 'center', x: 0.5, y: 4.5, w: 12.3, h: 0.6, fontSize: 20, color: 'E9C46A' });
  if (d.officers.length) {
    s1.addText(d.officers.map((o) => `${roleLabel(o.role)}: ${o.full_name}`).join('   |   '), { ...T, align: 'center', x: 0.5, y: 5.6, w: 12.3, h: 0.5, fontSize: 16, color: 'FFFFFF' });
  }

  // 2. Key figures
  const s2 = pres.addSlide();
  header(s2, 'خلاصه عملکرد');
  const tiles: [string, string, string][] = [
    ['جلسات برگزارشده', fa(s.held), PRIMARY],
    ['میانگین حضور', `${fa(s.attendanceRate)}٪`, PRIMARY],
    ['موضوعات بررسی‌شده', fa(s.agendaItems), PRIMARY],
    ['مصوبات دوره', fa(s.resolutions), ACCENT],
    ['مصوبات انجام‌شده', fa(s.done), '1F7A4D'],
    ['مصوبات معوق', fa(s.overdue), 'B42318'],
  ];
  tiles.forEach(([label, value, color], i) => {
    const col = i % 3;
    const row = Math.floor(i / 3);
    const x = 9.0 - col * 4.1; // right-to-left
    const y = 1.4 + row * 2.6;
    s2.addShape(pres.ShapeType.roundRect, { x, y, w: 3.8, h: 2.2, fill: { color: 'F4F6F8' }, line: { color: 'E2E8EC' }, rectRadius: 0.15 });
    s2.addText(value, { ...T, align: 'center', x, y: y + 0.25, w: 3.8, h: 1.1, fontSize: 44, bold: true, color });
    s2.addText(label, { ...T, align: 'center', x, y: y + 1.4, w: 3.8, h: 0.6, fontSize: 18, color: '5D6D78' });
  });

  // 3. Resolutions status chart
  const statusEntries = Object.entries(s.byStatus).filter(([, n]) => n > 0);
  if (statusEntries.length) {
    const s3 = pres.addSlide();
    header(s3, 'وضعیت مصوبات دوره');
    s3.addChart(pres.ChartType.doughnut, [{ name: 'مصوبات', labels: statusEntries.map(([k]) => RESOLUTION_STATUS_LABELS[k as ResolutionStatus]), values: statusEntries.map(([, n]) => n) }], {
      x: 3.4, y: 1.2, w: 6.5, h: 5.6, showLegend: true, legendPos: 'r', legendFontFace: FONT, legendFontSize: 14,
      showPercent: true, dataLabelColor: 'FFFFFF', chartColors: ['1F7A4D', 'B7791F', '175CD3', 'A15C07', 'B42318', '93A6AE'],
    });
  }

  // 4. Attendance chart
  if (d.attendance.length) {
    const s4 = pres.addSlide();
    header(s4, 'درصد حضور اعضا در جلسات');
    const top = d.attendance.slice(0, 15);
    s4.addChart(pres.ChartType.bar, [{ name: 'درصد حضور', labels: top.map((a) => a.full_name), values: top.map((a) => pct(a.attended, a.meetings)) }], {
      x: 0.6, y: 1.1, w: 12.1, h: 5.8, barDir: 'bar', chartColors: [PRIMARY], valAxisMaxVal: 100, valAxisMinVal: 0,
      catAxisLabelFontFace: FONT, catAxisLabelFontSize: 12, valAxisLabelFontSize: 11, showValue: true, dataLabelFontSize: 11, catAxisOrientation: 'maxMin',
    });
  }

  // 5. Meetings list
  if (held.length) {
    const rows = held.slice(0, 12).map((m) => [fa(m.number), jd(m.scheduled_at), m.title, `${fa(m.attended)} از ${fa(m.eligible)}`, fa(m.agenda.length)]);
    const s5 = pres.addSlide();
    header(s5, 'جلسات برگزارشده');
    const cellOpts = { fontFace: FONT, fontSize: 13, align: 'right' as const, rtlMode: true };
    s5.addTable(
      [
        ['شماره', 'تاریخ', 'عنوان جلسه', 'حضور', 'موضوعات'].map((t) => ({ text: t, options: { ...cellOpts, bold: true, color: 'FFFFFF', fill: { color: PRIMARY } } })),
        ...rows.map((r) => r.map((t) => ({ text: t, options: cellOpts }))),
      ].map((r) => r.reverse()),
      { x: 0.5, y: 1.2, w: 12.3, colW: [1.4, 1.6, 6.3, 1.7, 1.3].reverse(), border: { type: 'solid', color: 'E2E8EC', pt: 1 } },
    );
  }

  // 6. Key decisions
  const decisions = held.flatMap((m) => m.agenda.filter((a) => a.decision).map((a) => `${a.title}: ${a.decision}`)).slice(0, 10);
  if (decisions.length) {
    const s6 = pres.addSlide();
    header(s6, 'مهم‌ترین تصمیمات');
    s6.addText(decisions.map((t) => ({ text: t, options: { bullet: true, breakLine: true } })), { ...T, x: 0.6, y: 1.2, w: 12.1, h: 5.6, fontSize: 16, valign: 'top', paraSpaceAfter: 8 });
  }

  // 7. Overdue / open resolutions
  const pending = d.resolutions.filter((r) => r.status !== 'done' && r.status !== 'cancelled').slice(0, 10);
  if (pending.length) {
    const s7 = pres.addSlide();
    header(s7, 'مصوبات در دست پیگیری');
    const cellOpts = { fontFace: FONT, fontSize: 12, align: 'right' as const, rtlMode: true };
    s7.addTable(
      [
        ['شماره', 'متن مصوبه', 'مسئول اجرا', 'مهلت', 'پیشرفت'].map((t) => ({ text: t, options: { ...cellOpts, bold: true, color: 'FFFFFF', fill: { color: PRIMARY } } })),
        ...pending.map((r) =>
          [fa(r.number), r.text, r.owner_name ?? '—', jd(r.due_date), `${fa(r.progress)}٪${r.is_overdue ? ' (معوق)' : ''}`].map((t) => ({
            text: t,
            options: { ...cellOpts, color: r.is_overdue ? 'B42318' : '17232B' },
          })),
        ),
      ].map((r) => r.reverse()),
      { x: 0.5, y: 1.2, w: 12.3, colW: [1.3, 6.4, 2.2, 1.3, 1.1].reverse(), border: { type: 'solid', color: 'E2E8EC', pt: 1 } },
    );
  }

  const out = (await pres.write({ outputType: 'nodebuffer' })) as Buffer;
  return out;
}
