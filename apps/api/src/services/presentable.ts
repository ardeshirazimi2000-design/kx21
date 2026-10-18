import { execFile } from 'node:child_process';
import { access, mkdir, rename } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { config } from '../config.js';
import { query } from '../db/pool.js';
import { conflict } from '../lib/errors.js';
import { convertToPdf, officeConverterAvailable } from './officeConvert.js';

/**
 * Documents presented live in meetings. PDFs (uploaded, or converted from PowerPoint/Word) are rendered
 * page by page to PNG with Poppler on the server and cached, so every participant — browser or phone —
 * sees exactly the same slide, with correct Persian text, without a PDF viewer.
 */
const run = promisify(execFile);

export const PDF = 'application/pdf';
export const IMAGES = ['image/png', 'image/jpeg', 'image/webp'];
export const OFFICE = [
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.openxmlformats-officedocument.presentationml.slideshow',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/msword',
];
export const PRESENTABLE = [PDF, ...IMAGES, ...OFFICE];

const abs = (key: string) => path.resolve(config.uploadDir, key);
const inFlight = new Map<string, Promise<unknown>>();
/** Runs `fn` once per key at a time (concurrent viewers share the same conversion or rendering). */
function once<T>(key: string, fn: () => Promise<T>): Promise<T> {
  let job = inFlight.get(key) as Promise<T> | undefined;
  if (!job) {
    job = fn().finally(() => inFlight.delete(key));
    inFlight.set(key, job);
  }
  return job;
}

let poppler: Promise<boolean> | null = null;
export function popplerAvailable(): Promise<boolean> {
  poppler ??= run('pdftoppm', ['-v'], { timeout: 10_000 }).then(
    () => true,
    () => false,
  );
  return poppler;
}

/** Storage key of the PDF behind a document: the document itself, or its PDF made from PowerPoint/Word. */
export async function pdfKeyOf(d: any): Promise<string> {
  if (d.mime_type === PDF) return d.storage_key;
  if (d.pdf_key) return d.pdf_key;
  if (!(await officeConverterAvailable())) {
    throw conflict('تبدیل پاورپوینت و Word روی این سرور فعال نیست؛ نسخه PDF فایل را بارگذاری کنید', 'conversion_unavailable');
  }
  return once(`pdf:${d.id}`, async () => {
    const key = `${d.storage_key}.pdf`;
    await mkdir(path.dirname(abs(key)), { recursive: true });
    await convertToPdf(abs(d.storage_key), d.file_name, abs(key));
    await query('UPDATE documents SET pdf_key = $2 WHERE id = $1', [d.id, key]);
    d.pdf_key = key;
    return key;
  }).catch((e) => {
    if (e?.status) throw e;
    throw conflict('تبدیل فایل برای ارائه ممکن نشد؛ نسخه PDF آن را بارگذاری کنید', 'conversion_failed');
  });
}

/** Number of pages of the document's PDF (cached on the document). */
export async function pageCountOf(d: any): Promise<number> {
  if (d.page_count) return d.page_count;
  const { stdout } = await run('pdfinfo', [abs(await pdfKeyOf(d))], { timeout: 30_000 });
  const n = Number(/^Pages:\s+(\d+)/m.exec(stdout)?.[1] ?? 0);
  if (!n) throw conflict('فایل PDF قابل خواندن نیست', 'pdf_unreadable');
  await query('UPDATE documents SET page_count = $2 WHERE id = $1', [d.id, n]);
  d.page_count = n;
  return n;
}

/** Absolute path of page `page` rendered to PNG (1600 px on the long side), rendering it once. */
export async function pageImage(d: any, page: number): Promise<string> {
  const pdf = await pdfKeyOf(d);
  const out = abs(`${pdf}.p${page}.png`);
  if (await access(out).then(() => true, () => false)) return out;
  return once(`page:${out}`, async () => {
    const tmp = `${out}.tmp`;
    await run('pdftoppm', ['-png', '-singlefile', '-scale-to', '1600', '-f', String(page), '-l', String(page), abs(pdf), tmp], { timeout: 60_000 });
    await rename(`${tmp}.png`, out);
    return out;
  });
}
