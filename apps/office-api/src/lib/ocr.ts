/**
 * Reading the text of a scanned letter on this server (no outside service): a PDF is rendered page by page with
 * pdftoppm and read with Tesseract, images go to Tesseract directly. Every PDF is read from its rendered pages, even one
 * that carries text: the text layer of Persian PDFs is often scrambled (لا ligatures, presentation forms, word order),
 * so it is only a fallback when nothing readable comes off the pages. Needs the tesseract-ocr (+ Persian data «fas»)
 * and poppler-utils packages; without them OCR reports itself unavailable and nothing else changes.
 */
import { execFile } from 'node:child_process';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { config } from '../config.js';

const run = promisify(execFile);

export const OCR_MIME = ['application/pdf', 'image/png', 'image/jpeg', 'image/tiff', 'text/plain'];

export interface OcrResult {
  text: string;
  pages: number;
  method: 'text-layer' | 'ocr' | 'text';
}

let probe: Promise<{ available: boolean; langs: string[]; reason?: string }> | null = null;

/** Whether Tesseract with the configured languages and Poppler are installed (checked once per process). */
export function ocrStatus() {
  if (!config.ocr.enabled) return Promise.resolve({ available: false, langs: [], reason: 'OCR در تنظیمات سرور خاموش است (OCR_ENABLED=false)' });
  probe ??= (async () => {
    try {
      const { stdout, stderr } = await run('tesseract', ['--list-langs'], { timeout: 10_000 });
      const langs = `${stdout}\n${stderr}`.split(/\r?\n/).map((l) => l.trim()).filter((l) => /^[a-z_]{3,}$/i.test(l) && l !== 'osd');
      const missing = config.ocr.langs.split('+').filter((l) => !langs.includes(l));
      if (missing.length) return { available: false, langs, reason: `داده زبان Tesseract نصب نیست: ${missing.join('، ')}` };
      await run('pdftoppm', ['-v'], { timeout: 10_000 });
      return { available: true, langs };
    } catch {
      return { available: false, langs: [], reason: 'Tesseract یا Poppler روی سرور نصب نیست' };
    }
  })();
  return probe;
}

/** Tidy OCR output: Persian letters for Arabic look-alikes, no trailing spaces, at most one blank line in a row. */
export function cleanOcrText(t: string): string {
  return t
    .replace(/\r/g, '')
    .replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '') // bidi marks from pdftotext/Tesseract
    .replace(/\f/g, '\n\n')
    .replace(/[يى]/g, 'ی')
    .replace(/ك/g, 'ک')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Characters that carry meaning (letters and digits of any script). */
const meaningful = (t: string) => (t.match(/[\p{L}\p{N}]/gu) ?? []).length;

async function tesseract(file: string, deadline: number): Promise<string> {
  const { stdout } = await run('tesseract', [file, 'stdout', '-l', config.ocr.langs, '--psm', '3'], {
    timeout: Math.max(5_000, deadline - Date.now()),
    maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, OMP_THREAD_LIMIT: '1' },
  });
  return stdout;
}

export async function extractText(buf: Buffer, mime: string): Promise<OcrResult> {
  if (mime === 'text/plain') return { text: cleanOcrText(buf.toString('utf8')), pages: 1, method: 'text' };
  if (!OCR_MIME.includes(mime)) throw new Error('این نوع فایل با OCR خوانده نمی‌شود');
  const st = await ocrStatus();
  if (!st.available) throw new Error(st.reason ?? 'OCR در دسترس نیست');
  const deadline = Date.now() + config.ocr.timeoutSeconds * 1000;
  const dir = await mkdtemp(path.join(os.tmpdir(), 'rasa-ocr-'));
  try {
    if (mime !== 'application/pdf') {
      const file = path.join(dir, mime === 'image/tiff' ? 'in.tif' : mime === 'image/png' ? 'in.png' : 'in.jpg');
      await writeFile(file, buf, { mode: 0o600 });
      const raw = await tesseract(file, deadline); // a multi-page TIFF comes back with pages split by form feeds
      return { text: cleanOcrText(raw), pages: Math.max(1, raw.split('\f').filter((p) => p.trim()).length), method: 'ocr' };
    }
    const pdf = path.join(dir, 'in.pdf');
    await writeFile(pdf, buf, { mode: 0o600 });
    const last = String(config.ocr.maxPages);
    await run('pdftoppm', ['-r', String(config.ocr.dpi), '-gray', '-png', '-l', last, pdf, path.join(dir, 'p')], {
      timeout: Math.max(5_000, deadline - Date.now()),
    });
    const pages = (await readdir(dir)).filter((f) => /^p-\d+\.png$/.test(f)).sort((a, b) => Number(a.match(/\d+/)![0]) - Number(b.match(/\d+/)![0]));
    const texts: string[] = [];
    for (const p of pages) texts.push(cleanOcrText(await tesseract(path.join(dir, p), deadline)));
    const text = texts.filter(Boolean).join('\n\n');
    if (meaningful(text) >= 20) return { text, pages: pages.length, method: 'ocr' };
    // Nothing readable on the rendered pages (e.g. tiny print): fall back to the PDF's own text, if it has any.
    const layer = await run('pdftotext', ['-l', last, '-enc', 'UTF-8', pdf, '-'], { timeout: 30_000, maxBuffer: 16 * 1024 * 1024 }).catch(() => null);
    const layerText = cleanOcrText(layer?.stdout ?? '');
    return meaningful(layerText) > meaningful(text) ? { text: layerText, pages: pages.length, method: 'text-layer' } : { text, pages: pages.length, method: 'ocr' };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
