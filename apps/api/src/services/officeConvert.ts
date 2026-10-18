import { execFile } from 'node:child_process';
import { mkdtemp, readdir, rename, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { logger } from '../lib/logger.js';

/**
 * PowerPoint/Word → PDF with LibreOffice (headless), for presenting documents in meetings.
 * Conversions run one at a time (a conversion takes a few hundred MB of memory) and are cached by the caller.
 */
const run = promisify(execFile);
const CANDIDATES = process.env.SOFFICE_PATH ? [process.env.SOFFICE_PATH] : ['soffice', 'libreoffice', '/usr/lib/libreoffice/program/soffice'];
let SOFFICE = CANDIDATES[0];

let available: Promise<boolean> | null = null;
export function officeConverterAvailable(): Promise<boolean> {
  available ??= (async () => {
    for (const c of CANDIDATES) {
      if (await run(c, ['--version'], { timeout: 30_000 }).then(() => true, () => false)) {
        SOFFICE = c;
        return true;
      }
    }
    return false;
  })();
  return available;
}

let queue: Promise<unknown> = Promise.resolve();

/** Converts `src` (with its original extension in `name`) to a PDF written at `dest`. */
export function convertToPdf(src: string, name: string, dest: string): Promise<void> {
  const job = queue.then(async () => {
    await officeConverterAvailable();
    const dir = await mkdtemp(path.join(os.tmpdir(), 'kx-convert-'));
    try {
      // LibreOffice picks the import filter from the extension.
      const input = path.join(dir, `input${path.extname(name).toLowerCase()}`);
      await run('cp', [src, input]);
      await run(SOFFICE, ['--headless', '--norestore', `-env:UserInstallation=file://${dir}/profile`, '--convert-to', 'pdf', '--outdir', dir, input], {
        timeout: 180_000,
        env: { ...process.env, HOME: dir },
      });
      const pdf = (await readdir(dir)).find((f) => f.endsWith('.pdf'));
      if (!pdf) throw new Error('LibreOffice produced no PDF');
      await rename(path.join(dir, pdf), dest).catch(async () => run('cp', [path.join(dir, pdf), dest]));
    } catch (e) {
      logger.warn({ err: (e as Error).message }, 'document conversion failed');
      throw e;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  queue = job.catch(() => undefined);
  return job;
}
