/**
 * Builds a PDF from JPEG pages (scanned or photographed papers), one image per page, without any library:
 * the JPEG data is embedded as is (DCTDecode), so nothing is re-encoded and the file stays small.
 * Used by the browser (camera scans) and by the server (pages from a network scanner).
 */

export interface JpegInfo {
  width: number;
  height: number;
  components: number;
  /** Adobe APP14 marker: CMYK JPEGs from Photoshop/scanners store inverted values. */
  adobe: boolean;
}

/** Reads the frame header (SOF) of a JPEG; throws on anything that is not a baseline/progressive JPEG. */
export function jpegInfo(b: Uint8Array): JpegInfo {
  if (b[0] !== 0xff || b[1] !== 0xd8) throw new Error('not a JPEG');
  let i = 2;
  let adobe = false;
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) throw new Error('corrupt JPEG');
    const marker = b[i + 1];
    if (marker === 0xff) {
      i++;
      continue;
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    const len = (b[i + 2] << 8) | b[i + 3];
    if (marker === 0xee && b[i + 4] === 0x41 && b[i + 5] === 0x64 && b[i + 6] === 0x6f && b[i + 7] === 0x62 && b[i + 8] === 0x65) adobe = true;
    // SOF0..SOF15 except DHT (C4), JPG (C8) and DAC (CC).
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      const height = (b[i + 5] << 8) | b[i + 6];
      const width = (b[i + 7] << 8) | b[i + 8];
      const components = b[i + 9];
      if (!width || !height || ![1, 3, 4].includes(components)) throw new Error('unsupported JPEG');
      return { width, height, components, adobe };
    }
    if (marker === 0xda || marker === 0xd9) break;
    i += 2 + len;
  }
  throw new Error('JPEG frame header not found');
}

const ascii = (s: string) => {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
};

/** A4 width in points; every page is A4-wide and as tall as the picture's proportions need. */
const PAGE_WIDTH = 595.28;

export function jpegsToPdf(pages: Uint8Array[]): Uint8Array {
  if (!pages.length) throw new Error('no pages');
  const chunks: Uint8Array[] = [];
  const offsets: number[] = [];
  let size = 0;
  const push = (c: Uint8Array) => {
    chunks.push(c);
    size += c.length;
  };
  const obj = (n: number, parts: (string | Uint8Array)[]) => {
    offsets[n] = size;
    push(ascii(`${n} 0 obj\n`));
    for (const p of parts) push(typeof p === 'string' ? ascii(p) : p);
    push(ascii('\nendobj\n'));
  };

  push(ascii('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n'));
  // Objects: 1 catalog, 2 pages, then per page: page, content, image.
  const kids = pages.map((_, i) => `${3 + i * 3} 0 R`).join(' ');
  obj(1, ['<< /Type /Catalog /Pages 2 0 R >>']);
  obj(2, [`<< /Type /Pages /Count ${pages.length} /Kids [${kids}] >>`]);
  pages.forEach((jpeg, i) => {
    const info = jpegInfo(jpeg);
    const w = PAGE_WIDTH;
    const h = Math.round(((PAGE_WIDTH * info.height) / info.width) * 100) / 100;
    const [pageN, contentN, imageN] = [3 + i * 3, 4 + i * 3, 5 + i * 3];
    obj(pageN, [`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] /Resources << /XObject << /Im0 ${imageN} 0 R >> >> /Contents ${contentN} 0 R >>`]);
    const draw = `q ${w} 0 0 ${h} 0 0 cm /Im0 Do Q`;
    obj(contentN, [`<< /Length ${draw.length} >>\nstream\n${draw}\nendstream`]);
    const cs = info.components === 1 ? '/DeviceGray' : info.components === 3 ? '/DeviceRGB' : '/DeviceCMYK';
    const decode = info.components === 4 && info.adobe ? ' /Decode [1 0 1 0 1 0 1 0]' : '';
    obj(imageN, [
      `<< /Type /XObject /Subtype /Image /Width ${info.width} /Height ${info.height} /ColorSpace ${cs} /BitsPerComponent 8 /Filter /DCTDecode${decode} /Length ${jpeg.length} >>\nstream\n`,
      jpeg,
      '\nendstream',
    ]);
  });
  const count = 3 + pages.length * 3;
  const xref = size;
  let table = `xref\n0 ${count}\n0000000000 65535 f \n`;
  for (let n = 1; n < count; n++) table += `${String(offsets[n]).padStart(10, '0')} 00000 n \n`;
  push(ascii(`${table}trailer\n<< /Size ${count} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`));

  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}
