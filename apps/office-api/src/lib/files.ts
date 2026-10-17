import path from 'node:path';
import type { Response } from 'express';
import multer from 'multer';
import { config } from '../config.js';
import { badRequest } from './errors.js';

export const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: config.maxUploadMb * 1024 * 1024, files: 1 } });

const ZIP = [[0x50, 0x4b, 0x03, 0x04]];
const OLE = [[0xd0, 0xcf, 0x11, 0xe0]];
const ALLOWED: Record<string, { mime: string; magic: number[][] | null; at?: number }> = {
  '.pdf': { mime: 'application/pdf', magic: [[0x25, 0x50, 0x44, 0x46]] },
  '.png': { mime: 'image/png', magic: [[0x89, 0x50, 0x4e, 0x47]] },
  '.jpg': { mime: 'image/jpeg', magic: [[0xff, 0xd8, 0xff]] },
  '.jpeg': { mime: 'image/jpeg', magic: [[0xff, 0xd8, 0xff]] },
  '.tif': { mime: 'image/tiff', magic: [[0x49, 0x49, 0x2a, 0x00], [0x4d, 0x4d, 0x00, 0x2a]] },
  '.tiff': { mime: 'image/tiff', magic: [[0x49, 0x49, 0x2a, 0x00], [0x4d, 0x4d, 0x00, 0x2a]] },
  '.docx': { mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', magic: ZIP },
  '.doc': { mime: 'application/msword', magic: OLE },
  '.xlsx': { mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', magic: ZIP },
  '.xls': { mime: 'application/vnd.ms-excel', magic: OLE },
  '.pptx': { mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', magic: ZIP },
  '.zip': { mime: 'application/zip', magic: ZIP },
  '.txt': { mime: 'text/plain', magic: null },
  '.eml': { mime: 'message/rfc822', magic: null },
};

/** Allow-listed extension + magic bytes; returns the canonical MIME type. */
export function validateFile(name: string, buf: Buffer): string {
  const rule = ALLOWED[path.extname(name).toLowerCase()];
  if (!rule) throw badRequest(`نوع فایل مجاز نیست. فرمت‌های مجاز: ${Object.keys(ALLOWED).join('، ')}`);
  if (rule.magic) {
    const at = rule.at ?? 0;
    if (!rule.magic.some((sig) => sig.every((b, i) => buf[at + i] === b))) throw badRequest('محتوای فایل با پسوند آن مطابقت ندارد');
  } else if (buf.subarray(0, 8192).includes(0)) {
    throw badRequest('فایل متنی معتبر نیست');
  }
  return rule.mime;
}

/** multer decodes names as latin1; restore UTF-8 (Persian file names). */
export const uploadedName = (f: Express.Multer.File) => Buffer.from(f.originalname, 'latin1').toString('utf8');

/** Malware scanning hook (ClamAV INSTREAM or an organisational scanner). */
export async function scanFile(_buf: Buffer): Promise<'clean' | 'infected'> {
  return 'clean';
}

const INLINE = ['application/pdf', 'image/png', 'image/jpeg'];

export function sendFile(res: Response, buf: Buffer, name: string, mime: string, inline = false) {
  res.setHeader('content-type', mime);
  res.setHeader('content-disposition', `${inline && INLINE.includes(mime) ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(name)}`);
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('cache-control', 'private, no-store');
  res.send(buf);
}
