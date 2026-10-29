// Lab sheet → candidate rows ({ name, value, unit, ref }) for the PATIENT to confirm.
// Text comes from the PDF's own text layer (pdftotext) or from on-server OCR (Tesseract,
// eng+fas, CPU only — nothing leaves the server). Rows are suggestions: every value is shown
// to the patient next to the sheet, and words Tesseract was unsure about are flagged.
import { execFile } from 'node:child_process';
import { mkdtemp, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeFa } from '../../lib/fa.js';
import { matchTest, parseRange, knownTest } from './lab-review.js';

export const LAB_OCR_VERSION = 'lab-ocr-2026.10.1';
const LOW_CONF = 75; // Tesseract word confidence (0–100) under which a value is flagged

const UNIT_RE = /^(mlu\/l|mg\/dl|g\/dl|g\/l|mmol\/l|meq\/l|µmol\/l|umol\/l|u\/l|iu\/l|miu\/l|miu\/ml|µiu\/ml|uiu\/ml|ng\/ml|ng\/dl|pg\/ml|mg\/l|mm\/h(r)?|mm\/1h|%|fl|pg|10\^3\/µl|10\^3\/ul|x10\^3\/µl|x10\^3\/ul|10\^6\/µl|\/µl|\/ul|\/cumm|\/mm3|cells\/µl)$/i;

const run = (cmd, args, opts = {}) => new Promise((resolve, reject) => {
  execFile(cmd, args, { timeout: 45_000, maxBuffer: 16 * 1024 * 1024, ...opts }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
});

// Tesseract TSV → lines of words with confidences.
export function tsvToLines(tsv) {
  const lines = new Map();
  for (const row of String(tsv).split('\n').slice(1)) {
    const c = row.split('\t');
    if (c.length < 12 || c[0] !== '5') continue; // level 5 = word
    const text = c[11].trim();
    if (!text) continue;
    const key = `${c[1]}.${c[2]}.${c[3]}.${c[4]}`; // page.block.par.line
    if (!lines.has(key)) lines.set(key, []);
    lines.get(key).push({ text, conf: Number(c[10]) });
  }
  return [...lines.values()];
}

// Plain text (PDF text layer) → same shape, full confidence.
export const textToLines = (text) => String(text).split('\n').map((l) => l.trim().split(/\s+/).filter(Boolean).map((t) => ({ text: t, conf: 100 }))).filter((l) => l.length);

const NUM = /^[<>≤≥]?\d+(?:[.,٫]\d+)?\*?$/;
const toNum = (t) => t.replace(/[<>≤≥*]/g, '').replace(/[٫]/g, '.').replace(/,(?=\d{3}\b)/g, '').replace(',', '.');

/** lines: [[{ text, conf }]] → [{ name, value, unit, ref, low_confidence, line }] */
export function parseLabLines(lines) {
  const out = [];
  const seen = new Set();
  for (const words of lines) {
    // Per-word normalisation; "f.b.s" / "t.s.h." style abbreviations lose their dots.
    const norm = words.map((w) => {
      let n = normalizeFa(w.text).replace(/^[|:،,;]+|[|:،,;]+$/g, '');
      if (/^([a-z]\.)+[a-z]?\.?$/.test(n)) n = n.replace(/\./g, '');
      return { ...w, n };
    }).filter((w) => w.n);
    if (!norm.length) continue;
    const starts = [];
    let lineText = '';
    for (const w of norm) { starts.push(lineText.length); lineText += `${w.n} `; }
    const m = matchTest(lineText.trim());
    if (!m || seen.has(m.id)) continue;
    const wordAt = (off) => { let i = 0; while (i + 1 < starts.length && starts[i + 1] <= off) i++; return i; };
    const first = wordAt(m.index);
    const wi = wordAt(m.end - 1);
    // The test name must open the row (a leading row number is allowed), not sit inside a note.
    const lead = norm.slice(0, first);
    if (lead.length > 1 || (lead.length === 1 && !/^\d{1,2}[.)-]?$/.test(lead[0].n))) continue;
    const vi = norm.findIndex((w, i) => i > wi && NUM.test(w.n));
    if (vi === -1) continue;
    const valueWord = norm[vi];
    const rest = norm.slice(vi + 1).map((w) => w.n);
    const unitWord = norm.slice(vi + 1).find((w) => UNIT_RE.test(w.n));
    const unit = unitWord ? unitWord.text.replace(/^mlu/i, 'mIU').replace(/[|:]+$/, '') : '';
    const ref = parseRange(rest.filter((t) => !/^[hl]$|^(high|low|normal)$/i.test(t) && !UNIT_RE.test(t)).join(' '));
    const value = toNum(valueWord.n);
    if (!Number.isFinite(Number(value))) continue;
    // Implausible magnitude vs. the usual range (e.g. a missing decimal point) → flag.
    const k = knownTest(m.alias);
    const hi = k?.[4] ?? Infinity;
    const scaled = ['wbc', 'plt'].includes(m.id) && Number(value) >= 1000 ? Number(value) / 1000 : Number(value);
    const lo = k?.[3] ?? 0;
    // Missing/extra decimal point is the typical OCR error: compare with the usual range,
    // and check that the printed reference range itself is in the usual ballpark.
    const implausible = (Number.isFinite(hi) && hi < 1000 && (scaled > hi * 8 || (lo > 0 && scaled < lo / 8)))
      || (ref && k && Number.isFinite(ref[1]) && hi < 1000 && !['wbc', 'plt'].includes(m.id) && (ref[1] > hi * 5 || ref[1] < hi / 5));
    seen.add(m.id);
    out.push({
      name: norm.slice(first, wi + 1).map((w) => w.text).join(' ').replace(/[:|]+$/, '').slice(0, 60),
      value: value.slice(0, 20), unit: unit.slice(0, 20),
      ref: ref ? (ref[1] === Infinity ? `> ${ref[0]}` : `${ref[0]} - ${ref[1]}`) : '',
      low_confidence: valueWord.conf < LOW_CONF || Boolean(implausible),
      line: words.map((w) => w.text).join(' ').slice(0, 160),
    });
  }
  return out;
}

export function createLabOcr({ tesseract = 'tesseract', pdftotext = 'pdftotext', pdftoppm = 'pdftoppm', convert = 'convert' } = {}) {
  let available = null;
  let canPrep = null;
  let busy = 0;
  async function isAvailable() {
    if (available === null) available = await run(tesseract, ['--version']).then(() => true, () => false);
    return available;
  }
  // Phone photos: honour EXIF rotation, grey, stretch contrast, deskew, and enlarge small images —
  // at ~16px glyphs Tesseract drops decimal points (1.1 → 11), which upscaling fixes.
  // The input format is forced from the sniffed type so ImageMagick never guesses a coder.
  async function prepare(path, mime, out) {
    if (canPrep === null) canPrep = await run(convert, ['-version']).then(() => true, () => false);
    if (!canPrep) return path;
    const fmt = { 'image/jpeg': 'jpeg', 'image/png': 'png', 'image/webp': 'webp' }[mime];
    if (!fmt) return path;
    await run(convert, [`${fmt}:${path}[0]`, '-auto-orient', '-colorspace', 'Gray', '-resize', '2600x<', '-normalize', '-deskew', '40%', `png:${out}`]);
    return out;
  }
  // Lab results are printed in Latin script; the English model reads digits and decimal points
  // far better than eng+fas (which turns some digits into Persian look-alikes).
  const ocrImage = async (path) => tsvToLines(await run(tesseract, [path, 'stdout', '-l', 'eng', '--psm', '6', 'tsv']));

  /** files: [{ mime, data: Buffer }] → { rows, engine } */
  async function extract(files) {
    if (busy >= 2) throw Object.assign(new Error('busy'), { code: 'busy' });
    busy++;
    const dir = await mkdtemp(join(tmpdir(), 'kx21-ocr-'));
    try {
      const lines = [];
      let engine = 'pdf-text';
      for (const [i, f] of files.entries()) {
        const path = join(dir, `f${i}${f.mime === 'application/pdf' ? '.pdf' : '.img'}`);
        await writeFile(path, f.data, { mode: 0o600 });
        if (f.mime === 'application/pdf') {
          const text = await run(pdftotext, ['-layout', '-l', '5', path, '-']).catch(() => '');
          if (text.replace(/\s/g, '').length > 40) { lines.push(...textToLines(text)); continue; }
          // Scanned PDF: rasterise the first pages and OCR them.
          await run(pdftoppm, ['-r', '250', '-png', '-f', '1', '-l', '3', path, join(dir, `p${i}`)]);
          for (const png of (await readdir(dir)).filter((n) => n.startsWith(`p${i}`)).sort()) {
            lines.push(...await ocrImage(await prepare(join(dir, png), 'image/png', join(dir, `g${png}`))));
          }
          engine = 'tesseract';
        } else {
          lines.push(...await ocrImage(await prepare(path, f.mime, join(dir, `g${i}.png`))));
          engine = 'tesseract';
        }
      }
      return { rows: parseLabLines(lines), engine, version: LAB_OCR_VERSION };
    } finally {
      busy--;
      await rm(dir, { recursive: true, force: true });
    }
  }
  return { extract, isAvailable };
}
