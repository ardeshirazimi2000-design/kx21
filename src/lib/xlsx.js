// Minimal .xlsx reader (no dependencies): ZIP central directory + inflate, shared strings,
// worksheet cells. Enough for tabular imports (e.g. the national eRx/IRC drug coding file).
// Values come back as strings; formulas are read from their cached values.
import { inflateRawSync } from 'node:zlib';

const MAX_ENTRY = 200 * 1024 * 1024;

function unzip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a zip file');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const entries = new Map();
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('bad zip directory');
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28);
    const xlen = buf.readUInt16LE(p + 30);
    const clen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nlen).toString('utf8');
    entries.set(name, { method, csize, usize, local });
    p += 46 + nlen + xlen + clen;
  }
  return (name) => {
    const e = entries.get(name);
    if (!e) return null;
    if (e.usize > MAX_ENTRY) throw new Error('zip entry too large');
    const start = e.local + 30 + buf.readUInt16LE(e.local + 26) + buf.readUInt16LE(e.local + 28);
    const data = buf.subarray(start, start + e.csize);
    if (e.method === 0) return data.toString('utf8');
    if (e.method === 8) return inflateRawSync(data, { maxOutputLength: MAX_ENTRY }).toString('utf8');
    throw new Error(`unsupported zip method ${e.method}`);
  };
}

const unescape = (s) => s.replace(/&(lt|gt|amp|quot|apos|#\d+|#x[0-9a-f]+);/gi, (m, e) => {
  const map = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
  if (map[e.toLowerCase()]) return map[e.toLowerCase()];
  return String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
});
const textOf = (xml) => unescape([...xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => m[1]).join(''));
const colIndex = (ref) => {
  let n = 0;
  for (const ch of ref.replace(/\d+/g, '')) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
};

/** → [{ name, rows: string[][] }] in workbook order. */
export function readXlsx(buf) {
  const get = unzip(buf);
  const wb = get('xl/workbook.xml');
  if (!wb) throw new Error('not an xlsx workbook');
  const rels = get('xl/_rels/workbook.xml.rels') ?? '';
  const target = new Map([...rels.matchAll(/<Relationship\b[^>]*>/g)].map((m) => {
    const id = m[0].match(/\bId="([^"]+)"/)?.[1];
    const t = m[0].match(/\bTarget="([^"]+)"/)?.[1] ?? '';
    return [id, t.startsWith('/') ? t.slice(1) : `xl/${t}`];
  }));
  const ssXml = get('xl/sharedStrings.xml');
  const shared = ssXml ? [...ssXml.matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => textOf(m[1])) : [];
  const sheets = [];
  for (const m of wb.matchAll(/<sheet\b[^>]*>/g)) {
    const name = unescape(m[0].match(/\bname="([^"]*)"/)?.[1] ?? '');
    const rid = m[0].match(/\br:id="([^"]+)"/)?.[1];
    const xml = get(target.get(rid) ?? '');
    if (!xml) continue;
    const rows = [];
    for (const r of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
      const row = [];
      for (const c of r[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const attrs = c[1];
        const ref = attrs.match(/\br="([A-Z]+\d+)"/)?.[1];
        const type = attrs.match(/\bt="([^"]+)"/)?.[1];
        const body = c[2] ?? '';
        let v = '';
        if (type === 'inlineStr') v = textOf(body);
        else {
          const raw = body.match(/<v>([\s\S]*?)<\/v>/)?.[1];
          if (raw != null) v = type === 's' ? shared[Number(raw)] ?? '' : unescape(raw);
        }
        row[ref ? colIndex(ref) : row.length] = v;
      }
      rows.push(Array.from(row, (x) => x ?? ''));
    }
    sheets.push({ name, rows });
  }
  return sheets;
}
