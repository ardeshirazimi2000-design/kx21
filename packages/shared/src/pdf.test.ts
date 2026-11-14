import { describe, expect, it } from 'vitest';
import { jpegInfo, jpegsToPdf } from './pdf.js';

/** Smallest JPEG-shaped bytes the parser needs: SOI, an APP0, a SOF0 frame header and EOI. */
const fakeJpeg = (w: number, h: number, comps = 3) =>
  new Uint8Array([
    0xff,
    0xd8,
    0xff,
    0xe0,
    0x00,
    0x04,
    0x4a,
    0x46,
    0xff,
    0xc0,
    0x00,
    0x11,
    0x08,
    h >> 8,
    h & 0xff,
    w >> 8,
    w & 0xff,
    comps,
    ...new Array(9).fill(0),
    0xff,
    0xd9,
  ]);

const text = (b: Uint8Array) => Array.from(b, (c) => String.fromCharCode(c)).join('');

describe('jpegs → pdf', () => {
  it('reads the frame size and colour components', () => {
    expect(jpegInfo(fakeJpeg(2480, 3508))).toMatchObject({ width: 2480, height: 3508, components: 3 });
    expect(jpegInfo(fakeJpeg(100, 50, 1)).components).toBe(1);
    expect(() => jpegInfo(new Uint8Array([0x89, 0x50]))).toThrow();
  });

  it('writes one A4-wide page per picture with a valid cross-reference table', () => {
    const pdf = text(jpegsToPdf([fakeJpeg(2480, 3508), fakeJpeg(1000, 500, 1)]));
    expect(pdf.startsWith('%PDF-1.4')).toBe(true);
    expect(pdf).toContain('/Count 2');
    expect(pdf).toContain('/MediaBox [0 0 595.28 842.03]');
    expect(pdf).toContain('/ColorSpace /DeviceGray');
    // Every xref offset points at its object.
    const xref = Number(pdf.match(/startxref\n(\d+)/)![1]);
    const rows = pdf
      .slice(xref)
      .split('\n')
      .slice(3, 3 + 8);
    rows.forEach((r, i) => expect(pdf.slice(Number(r.slice(0, 10)), Number(r.slice(0, 10)) + `${i + 1} 0 obj`.length)).toBe(`${i + 1} 0 obj`));
  });
});
