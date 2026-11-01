import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { Readable } from 'node:stream';
import { type AttendanceStatus, formatJalaliLong, isAttending, toPersianDigits } from '@kx/shared';
import { config } from '../config.js';
import { one, query } from '../db/pool.js';
import { logger } from '../lib/logger.js';
import { notify } from './notifications.js';

/**
 * Draft minutes from a meeting's recording, entirely on the organisation's own servers:
 *  1. speech-to-text: the recording is sent to a Whisper service (STT_BASE_URL, OpenAI-compatible
 *     /audio/transcriptions: faster-whisper «speaches», whisper.cpp server…);
 *  2. drafting: a local chat model on Ollama (AI_BASE_URL + AI_CHAT_MODEL) writes the «متن جلسه» and the draft
 *     resolutions from the transcript. Long transcripts are summarised part by part, then combined.
 * Jobs run one at a time in the background (meeting_transcripts); the secretary reviews the result and decides
 * what goes into the minutes and which resolutions are registered.
 */

export const transcriptionEnabled = () => !!config.stt.baseUrl;
export const draftingEnabled = () => !!config.ai.baseUrl && !!config.ai.chatModel;
export const aiCapabilities = () => ({ transcription: transcriptionEnabled(), drafting: draftingEnabled() });

export interface DraftResolution {
  text: string;
  agendaItemId: string | null;
  responsible: string | null;
  deadline: string | null;
}

class EngineError extends Error {}

// ───────────────────────── HTTP (no response timeout: CPU transcription of a long meeting takes a while) ─────────────────────────

function request(
  url: string,
  opts: { method?: string; headers?: Record<string, string | number>; body?: Buffer | Readable; timeoutMs: number; signal?: AbortSignal },
): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request(u, { method: opts.method ?? 'GET', headers: opts.headers, signal: opts.signal }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', reject);
    });
    req.setTimeout(opts.timeoutMs, () => req.destroy(new EngineError('پاسخ موتور در زمان مقرر نرسید')));
    req.on('error', (e: any) => {
      if (e?.name === 'AbortError') reject(e);
      else if (e instanceof EngineError) reject(e);
      else reject(new EngineError(`اتصال به موتور برقرار نشد (${e?.code ?? e?.message ?? 'خطا'})`));
    });
    if (!opts.body) req.end();
    else if (Buffer.isBuffer(opts.body)) req.end(opts.body);
    else {
      opts.body.on('error', (e) => req.destroy(e));
      opts.body.pipe(req);
    }
  });
}

// ───────────────────────── Speech to text ─────────────────────────

const clock = (s: number) => {
  const t = Math.max(0, Math.floor(s));
  return [Math.floor(t / 3600), Math.floor((t % 3600) / 60), t % 60].map((n) => String(n).padStart(2, '0')).join(':');
};

/** Text of a transcription response: timed lines when the service gives segments. */
export function transcriptText(raw: string): string {
  let j: any;
  try {
    j = JSON.parse(raw);
  } catch {
    return raw.trim();
  }
  const segs: any[] = Array.isArray(j?.segments) ? j.segments : [];
  if (segs.length) {
    return segs
      .map((s) => ({ start: Number(s.start ?? 0), text: String(s.text ?? '').trim() }))
      .filter((s) => s.text)
      .map((s) => `[${clock(s.start)}] ${s.text}`)
      .join('\n');
  }
  return String(j?.text ?? '').trim();
}

/** Streams the recording to the speech-to-text service (multipart, with a known length). */
export async function transcribeFile(file: string, fileName: string, mime: string, hint: string, signal?: AbortSignal): Promise<string> {
  const boundary = `----kx${Math.random().toString(16).slice(2)}${Date.now()}`;
  const field = (name: string, value: string) => `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`;
  const fields = [
    field('model', config.stt.model),
    field('language', config.stt.language),
    field('response_format', 'verbose_json'),
    field('temperature', '0'),
    ...(hint ? [field('prompt', hint)] : []),
  ].join('');
  const safeName = `recording${path.extname(fileName).toLowerCase() || '.bin'}`;
  const head = Buffer.from(`${fields}--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${safeName}"\r\nContent-Type: ${mime}\r\n\r\n`);
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  const size = (await stat(file)).size;
  const body = Readable.from(
    (async function* () {
      yield head;
      for await (const c of createReadStream(file)) yield c as Buffer;
      yield tail;
    })(),
  );
  const res = await request(`${config.stt.baseUrl}/audio/transcriptions`, {
    method: 'POST',
    headers: {
      'content-type': `multipart/form-data; boundary=${boundary}`,
      'content-length': head.length + size + tail.length,
      ...(config.stt.apiKey ? { authorization: `Bearer ${config.stt.apiKey}` } : {}),
    },
    body,
    timeoutMs: config.stt.timeoutMinutes * 60_000,
    signal,
  });
  if (res.status !== 200) throw new EngineError(`موتور تبدیل گفتار به متن خطا داد (${res.status}): ${res.text.slice(0, 200)}`);
  const text = transcriptText(res.text);
  if (!text) throw new EngineError('در فایل صوتی گفتاری تشخیص داده نشد');
  return text;
}

// ───────────────────────── Drafting with the local model ─────────────────────────

/** Sends a chat to Ollama (its own API, so the context window can be set) or another OpenAI-compatible server. */
async function chatJson(system: string, user: string, schema: object, signal?: AbortSignal): Promise<any> {
  const base = config.ai.baseUrl;
  const ollama = /\/v1$/.test(base) || /:11434/.test(base);
  const messages = [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
  const payload = ollama
    ? { model: config.ai.chatModel, messages, stream: false, format: schema, options: { num_ctx: config.ai.chatContext, temperature: 0.2 } }
    : { model: config.ai.chatModel, messages, temperature: 0.2, response_format: { type: 'json_object' } };
  const url = ollama ? `${base.replace(/\/v1$/, '')}/api/chat` : `${base}/chat/completions`;
  const body = Buffer.from(JSON.stringify(payload));
  const res = await request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'content-length': body.length, ...(config.ai.apiKey ? { authorization: `Bearer ${config.ai.apiKey}` } : {}) },
    body,
    timeoutMs: config.ai.chatTimeoutMinutes * 60_000,
    signal,
  });
  if (res.status !== 200) {
    const hint = res.status === 404 ? ` — مدل ${config.ai.chatModel} روی موتور نصب نیست` : '';
    throw new EngineError(`مدل زبانی خطا داد (${res.status})${hint}: ${res.text.slice(0, 200)}`);
  }
  const j = JSON.parse(res.text);
  const content: string = ollama ? j?.message?.content : j?.choices?.[0]?.message?.content;
  return parseJsonLoose(content ?? '');
}

/** The model's JSON, tolerating a code fence or text around it. */
export function parseJsonLoose(s: string): any {
  const t = s.trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/, '');
  try {
    return JSON.parse(t);
  } catch {
    const a = t.indexOf('{');
    const b = t.lastIndexOf('}');
    if (a >= 0 && b > a) {
      try {
        return JSON.parse(t.slice(a, b + 1));
      } catch {
        /* fall through */
      }
    }
    throw new EngineError('پاسخ مدل زبانی قابل خواندن نبود؛ دوباره تلاش کنید یا مدل بزرگ‌تری به کار ببرید');
  }
}

const DECISION = {
  type: 'object',
  properties: {
    text: { type: 'string' },
    agendaItem: { type: ['integer', 'null'] },
    responsible: { type: ['string', 'null'] },
    deadline: { type: ['string', 'null'] },
  },
  required: ['text'],
};
const PART_SCHEMA = { type: 'object', properties: { notes: { type: 'string' }, decisions: { type: 'array', items: DECISION } }, required: ['notes', 'decisions'] };
const FINAL_SCHEMA = { type: 'object', properties: { discussion: { type: 'string' }, resolutions: { type: 'array', items: DECISION } }, required: ['discussion', 'resolutions'] };
const NOTES_SCHEMA = { type: 'object', properties: { notes: { type: 'string' } }, required: ['notes'] };

const SYSTEM = [
  'شما دستیار دبیرخانهٔ یک کمیسیون تخصصی اتاق بازرگانی هستید و از روی متن پیاده‌شدهٔ گفتگوهای جلسه، پیش‌نویس صورتجلسه را به فارسی رسمی و اداری می‌نویسید.',
  'فقط آنچه در متن آمده را بنویسید و هیچ مطلب، نام، عدد یا تصمیمی از خود نیفزایید. متن از گفتار به نوشتار تبدیل شده و ممکن است غلط املایی داشته باشد؛ نام‌ها را با فهرست حاضرین تطبیق دهید.',
  'مصوبه فقط تصمیمی است که در جلسه گرفته یا تصویب شده است (نه پیشنهاد یا بحثی که به نتیجه نرسید). متن هر مصوبه را کامل و مستقل بنویسید، مسئول اجرا و مهلت را فقط اگر در جلسه گفته شده بیاورید.',
  'برای agendaItem شمارهٔ بند دستور جلسهٔ مرتبط را بدهید، یا null.',
  'پاسخ فقط JSON باشد.',
].join('\n');

export interface MeetingContext {
  commission: string;
  title: string;
  date: string;
  agenda: { id: string; title: string }[];
  attendees: string[];
}

function contextText(ctx: MeetingContext): string {
  return [
    `کمیسیون: ${ctx.commission}`,
    `عنوان جلسه: ${ctx.title} — تاریخ: ${ctx.date}`,
    ctx.agenda.length ? `دستور جلسه:\n${ctx.agenda.map((a, i) => `${i + 1}. ${a.title}`).join('\n')}` : 'دستور جلسه: —',
    ctx.attendees.length ? `حاضرین: ${ctx.attendees.join('، ')}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

/** Characters of transcript that fit in one request beside the instructions and the answer (Persian ≈ 1.5 chars per token). */
export const partChars = () => Math.max(3000, Math.floor((config.ai.chatContext - 4000) * 1.5));

/** Splits a transcript at line breaks into parts of at most `max` characters. */
export function splitText(text: string, max: number): string[] {
  const parts: string[] = [];
  let cur = '';
  for (const line of text.split('\n')) {
    for (let i = 0; i < Math.max(1, line.length); i += max) {
      const piece = line.slice(i, i + max);
      if (cur && cur.length + piece.length + 1 > max) {
        parts.push(cur);
        cur = '';
      }
      cur = cur ? `${cur}\n${piece}` : piece;
    }
  }
  if (cur.trim()) parts.push(cur);
  return parts;
}

function cleanDecisions(list: any[], ctx: MeetingContext): DraftResolution[] {
  const out: DraftResolution[] = [];
  const seen = new Set<string>();
  for (const d of Array.isArray(list) ? list : []) {
    const text = String(d?.text ?? '').trim();
    if (text.length < 5 || seen.has(text)) continue;
    seen.add(text);
    const n = Number(d?.agendaItem);
    const str = (v: unknown) => (typeof v === 'string' && v.trim() && v.trim() !== 'null' ? v.trim().slice(0, 300) : null);
    out.push({ text: text.slice(0, 4000), agendaItemId: Number.isInteger(n) && ctx.agenda[n - 1] ? ctx.agenda[n - 1].id : null, responsible: str(d?.responsible), deadline: str(d?.deadline) });
  }
  return out;
}

/** Drafts «متن جلسه» and the resolutions from a transcript. */
export async function draftFromTranscript(transcript: string, ctx: MeetingContext, signal?: AbortSignal): Promise<{ discussion: string; resolutions: DraftResolution[] }> {
  const head = contextText(ctx);
  const max = partChars();
  const finalAsk =
    'خروجی: discussion = «شرح مذاکرات جلسه» به ترتیب بندهای دستور جلسه، هر بند با یک خط «### عنوان بند» و سپس خلاصهٔ نظرات مطرح‌شده (با نام گوینده در صورت مشخص بودن) در چند بند کوتاه؛ resolutions = فهرست مصوبات.';
  const parts = splitText(transcript, max);
  if (parts.length === 1) {
    const r = await chatJson(SYSTEM, `${head}\n\n${finalAsk}\n\nمتن پیاده‌شدهٔ جلسه:\n${transcript}`, FINAL_SCHEMA, signal);
    return { discussion: String(r?.discussion ?? '').trim(), resolutions: cleanDecisions(r?.resolutions, ctx) };
  }
  // Long meeting: notes and decisions of each part, then one combined draft.
  let notes: string[] = [];
  const decisions: any[] = [];
  for (const [i, part] of parts.entries()) {
    const r = await chatJson(
      SYSTEM,
      `${head}\n\nاین بخش ${i + 1} از ${parts.length} متن جلسه است. خروجی: notes = خلاصهٔ دقیق مطالب این بخش با ذکر بند دستور جلسه و گوینده؛ decisions = تصمیم‌هایی که در همین بخش گرفته شد.\n\nمتن:\n${part}`,
      PART_SCHEMA,
      signal,
    );
    notes.push(String(r?.notes ?? '').trim());
    decisions.push(...(Array.isArray(r?.decisions) ? r.decisions : []));
  }
  // Notes too long for one request are condensed again.
  while (notes.join('\n\n').length > max && notes.length > 1) {
    const groups = splitText(notes.join('\n\n'), max);
    if (groups.length >= notes.length) break;
    const next: string[] = [];
    for (const g of groups) next.push(String((await chatJson(SYSTEM, `${head}\n\nاین یادداشت‌ها را بدون حذف نظر یا تصمیم مهمی خلاصه‌تر کنید. خروجی: notes.\n\n${g}`, NOTES_SCHEMA, signal))?.notes ?? '').trim());
    notes = next;
  }
  const decisionsText = cleanDecisions(decisions, ctx)
    .map((d, i) => `${i + 1}. ${d.text}${d.responsible ? ` — مسئول: ${d.responsible}` : ''}${d.deadline ? ` — مهلت: ${d.deadline}` : ''}`)
    .join('\n');
  const r = await chatJson(
    SYSTEM,
    `${head}\n\n${finalAsk} تصمیم‌های تکراری را یکی کنید.\n\nیادداشت‌های بخش‌های جلسه:\n${notes.join('\n\n')}\n\nتصمیم‌های استخراج‌شده:\n${decisionsText || '—'}`,
    FINAL_SCHEMA,
    signal,
  );
  return { discussion: String(r?.discussion ?? '').trim(), resolutions: cleanDecisions(r?.resolutions, ctx) };
}

// ───────────────────────── Background jobs ─────────────────────────

export async function meetingContext(meetingId: string): Promise<MeetingContext> {
  const m = (await one(`SELECT m.title, m.scheduled_at, c.name AS commission FROM meetings m JOIN commissions c ON c.id = m.commission_id WHERE m.id = $1`, [meetingId]))!;
  const agenda = await query<{ id: string; title: string }>(`SELECT id, title FROM agenda_items WHERE meeting_id = $1 AND status <> 'removed' ORDER BY order_no`, [meetingId]);
  const people = await query<{ full_name: string; status: AttendanceStatus }>(
    `SELECT u.full_name, a.status FROM attendance a JOIN users u ON u.id = a.user_id WHERE a.meeting_id = $1 ORDER BY u.full_name`,
    [meetingId],
  );
  const attendees = [...new Set(people.filter((p) => isAttending(p.status)).map((p) => p.full_name))];
  return { commission: m.commission, title: m.title, date: formatJalaliLong(m.scheduled_at), agenda, attendees };
}

/** Words that help the recogniser spell names and terms (Whisper «prompt», kept short). */
function sttHint(ctx: MeetingContext): string {
  return toPersianDigits([ctx.commission, ...ctx.attendees, ...ctx.agenda.map((a) => a.title)].join('، ')).slice(0, 600);
}

const running = new Map<string, AbortController>();
let busy = false;
let timer: NodeJS.Timeout | null = null;

/** Moves a job on only if nobody cancelled it meanwhile; false → stop working on it. */
async function advance(id: string, from: string, set: string, values: unknown[]): Promise<boolean> {
  const r = await query(`UPDATE meeting_transcripts SET ${set} WHERE id = $1 AND status = '${from}' RETURNING id`, [id, ...values]);
  return r.length > 0;
}

async function processJob(job: any): Promise<void> {
  const ac = new AbortController();
  running.set(job.id, ac);
  try {
    const ctx = await meetingContext(job.meeting_id);
    let transcript: string | null = job.transcript;
    if (!transcript) {
      const d = job.document_id ? await one(`SELECT storage_key, file_name, mime_type FROM documents WHERE id = $1`, [job.document_id]) : null;
      if (!d) throw new EngineError('فایل جلسه حذف شده است');
      const file = path.resolve(config.uploadDir, d.storage_key);
      if (job.source === 'text') {
        transcript = (await readFile(file, 'utf8')).trim();
      } else {
        if (!transcriptionEnabled()) throw new EngineError('موتور تبدیل گفتار به متن روی سرور راه‌اندازی نشده است');
        transcript = await transcribeFile(file, d.file_name, d.mime_type, sttHint(ctx), ac.signal);
      }
      const next = draftingEnabled() ? 'drafting' : 'done';
      const ok = await advance(job.id, 'transcribing', `transcript = $2, stt_model = $3, status = $4${next === 'done' ? ', finished_at = now()' : ''}`, [
        transcript,
        job.source === 'recording' ? config.stt.model : null,
        next,
      ]);
      if (!ok) return;
      if (next === 'done') return void (await told(job));
    } else if (!(await advance(job.id, 'transcribing', `status = 'drafting'`, []))) {
      return;
    }
    if (!draftingEnabled()) {
      await advance(job.id, 'drafting', `status = 'done', finished_at = now()`, []);
      return void (await told(job));
    }
    const draft = await draftFromTranscript(transcript, ctx, ac.signal);
    const ok = await advance(job.id, 'drafting', `discussion = $2, resolutions = $3, llm_model = $4, status = 'done', finished_at = now()`, [
      draft.discussion,
      JSON.stringify(draft.resolutions),
      config.ai.chatModel,
    ]);
    if (ok) await told(job);
  } catch (e: any) {
    if (e?.name === 'AbortError') return;
    const msg = e instanceof EngineError ? e.message : 'خطای پیش‌بینی‌نشده در پردازش فایل';
    if (!(e instanceof EngineError)) logger.error({ err: e, job: job.id }, 'transcript job failed');
    await query(`UPDATE meeting_transcripts SET status = 'failed', error = $2, finished_at = now() WHERE id = $1 AND status IN ('transcribing','drafting')`, [job.id, msg]);
    await told(job, msg);
  } finally {
    running.delete(job.id);
  }
}

async function told(job: any, error?: string) {
  const m = await one(`SELECT chamber_id, title FROM meetings WHERE id = $1`, [job.meeting_id]);
  if (!m || !job.created_by) return;
  await notify({
    chamberId: m.chamber_id,
    userIds: [job.created_by],
    event: 'minutes.transcript_ready',
    title: error ? 'تبدیل فایل جلسه به متن انجام نشد' : 'پیش‌نویس صورتجلسه از فایل صوتی آماده شد',
    body: error ? `جلسه «${m.title}»: ${error}` : `متن و پیش‌نویس مصوبات جلسه «${m.title}» برای بررسی آماده است.`,
    data: { meetingId: job.meeting_id },
  }).catch((e) => logger.warn({ err: e }, 'transcript notification failed'));
}

/** Takes the oldest queued job and works on it; one job at a time per API process. */
export async function runNextTranscript(): Promise<boolean> {
  if (busy) return false;
  busy = true;
  try {
    const job = await one(
      `UPDATE meeting_transcripts SET status = 'transcribing', started_at = now(), error = NULL
        WHERE id = (SELECT id FROM meeting_transcripts WHERE status = 'queued' ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1)
        RETURNING *`,
    );
    if (!job) return false;
    await processJob(job);
    return true;
  } finally {
    busy = false;
  }
}

export function kickTranscriptWorker(): void {
  if (config.isTest) return;
  setImmediate(() => void drain());
}

async function drain() {
  try {
    while (await runNextTranscript());
  } catch (e) {
    logger.error({ err: e }, 'transcript worker');
  }
}

export function cancelRunningTranscript(id: string): void {
  running.get(id)?.abort();
}

export async function startTranscriptWorker(): Promise<void> {
  // Jobs cut off by a restart start over (a finished transcript is kept and not made again).
  await query(`UPDATE meeting_transcripts SET status = 'queued' WHERE status IN ('transcribing','drafting')`);
  timer = setInterval(() => void drain(), 30_000);
  timer.unref();
  void drain();
}
