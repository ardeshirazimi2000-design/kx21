/**
 * eSCL (AirScan / Mopria scan) client: the driverless scan protocol of network scanners and multifunction printers
 * (HP, Canon, Epson, Brother, Kyocera, Ricoh, Xerox, …). The server speaks to the scanner over HTTP on the local
 * network, so the browser needs no driver or plug-in. A USB scanner is shared the same way through an eSCL bridge
 * (e.g. AirSane on a small Linux box), so one code path serves both.
 *
 *   GET  {root}/ScannerCapabilities   sources, colour modes, resolutions, maximum area
 *   GET  {root}/ScannerStatus         Idle / Processing / Stopped, ADF state
 *   POST {root}/ScanJobs              ScanSettings XML → 201 + Location of the job
 *   GET  {job}/NextDocument           one page (JPEG) at a time; 404 when the job has no more pages
 */

export type EsclSource = 'Platen' | 'Feeder' | 'FeederDuplex';
export type EsclColor = 'RGB24' | 'Grayscale8';

export interface EsclCapabilities {
  makeAndModel: string | null;
  sources: EsclSource[];
  colorModes: EsclColor[];
  resolutions: number[];
  /** Resolutions per source: a feeder often offers fewer than the glass. */
  sourceResolutions: Partial<Record<'Platen' | 'Feeder', number[]>>;
  /** Largest scan area per source, in 1/300 inch. */
  maxArea: Partial<Record<'Platen' | 'Feeder', { width: number; height: number }>>;
  formats: string[];
}

export class EsclError extends Error {
  constructor(
    message: string,
    public status?: number,
  ) {
    super(message);
  }
}

const TIMEOUT_MS = 20_000;
const PAGE_TIMEOUT_MS = 120_000;
const MAX_PAGES = 100;
const MAX_BYTES = 200 * 1024 * 1024;

/** The scanner's eSCL root: http(s) only, no credentials in the URL, no trailing slash. */
export function normalizeRoot(url: string): string {
  const u = new URL(url);
  if (!['http:', 'https:'].includes(u.protocol)) throw new EsclError('نشانی اسکنر باید با http یا https شروع شود');
  if (u.username || u.password) throw new EsclError('نشانی اسکنر نباید نام کاربری یا گذرواژه داشته باشد');
  u.hash = '';
  u.search = '';
  if (!/\/escl\/?$/i.test(u.pathname)) u.pathname = `${u.pathname.replace(/\/$/, '')}/eSCL`;
  return u.toString().replace(/\/$/, '');
}

async function call(url: string, init: RequestInit = {}, timeout = TIMEOUT_MS): Promise<Response> {
  try {
    return await fetch(url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(timeout) });
  } catch (e: any) {
    throw new EsclError(e?.name === 'TimeoutError' ? 'اسکنر پاسخ نداد (پایان مهلت)' : 'اتصال به اسکنر برقرار نشد؛ روشن بودن و نشانی شبکه آن را بررسی کنید');
  }
}

const tags = (xml: string, name: string): string[] =>
  [...xml.matchAll(new RegExp(`<(?:\\w+:)?${name}>([^<]*)</(?:\\w+:)?${name}>`, 'g'))].map((m) => m[1].trim());
const block = (xml: string, name: string): string | null => xml.match(new RegExp(`<(?:\\w+:)?${name}[\\s>][\\s\\S]*?</(?:\\w+:)?${name}>`))?.[0] ?? null;

export function parseCapabilities(xml: string): EsclCapabilities {
  const sources: EsclSource[] = [];
  const colors = new Set<EsclColor>();
  const resolutions = new Set<number>();
  const formats = new Set<string>();
  const maxArea: EsclCapabilities['maxArea'] = {};
  const sourceResolutions: EsclCapabilities['sourceResolutions'] = {};
  const read = (b: string | null, key: 'Platen' | 'Feeder') => {
    if (!b) return;
    for (const c of tags(b, 'ColorMode')) if (c === 'RGB24' || c === 'Grayscale8') colors.add(c);
    const own = [
      ...new Set(
        tags(b, 'XResolution')
          .map(Number)
          .filter((r) => r > 0),
      ),
    ].sort((x, y) => x - y);
    if (own.length) sourceResolutions[key] = own;
    for (const r of own) resolutions.add(r);
    for (const f of [...tags(b, 'DocumentFormat'), ...tags(b, 'DocumentFormatExt')]) formats.add(f);
    const w = Number(tags(b, 'MaxWidth')[0]);
    const h = Number(tags(b, 'MaxHeight')[0]);
    if (w > 0 && h > 0) maxArea[key] = { width: w, height: h };
  };
  const platen = block(xml, 'Platen');
  const adf = block(xml, 'Adf');
  if (platen) (sources.push('Platen'), read(platen, 'Platen'));
  if (adf) {
    sources.push('Feeder');
    read(block(adf, 'AdfSimplexInputCaps') ?? adf, 'Feeder');
    if (block(adf, 'AdfDuplexInputCaps') || /<(?:\w+:)?AdfOption>Duplex</.test(adf)) sources.push('FeederDuplex');
  }
  return {
    makeAndModel: tags(xml, 'MakeAndModel')[0] ?? null,
    sources,
    colorModes: colors.size ? [...colors] : ['RGB24'],
    resolutions: resolutions.size ? [...resolutions].sort((a, b) => a - b) : [300],
    sourceResolutions,
    maxArea,
    formats: [...formats],
  };
}

export async function capabilities(root: string): Promise<EsclCapabilities> {
  const r = await call(`${root}/ScannerCapabilities`);
  if (!r.ok) throw new EsclError(`اسکنر به درخواست مشخصات پاسخ نداد (کد ${r.status})`, r.status);
  return parseCapabilities(await r.text());
}

export async function status(root: string): Promise<{ state: string; adf: string | null }> {
  const r = await call(`${root}/ScannerStatus`);
  if (!r.ok) throw new EsclError(`وضعیت اسکنر خوانده نشد (کد ${r.status})`, r.status);
  const xml = await r.text();
  return { state: tags(xml, 'State')[0] ?? 'Unknown', adf: tags(xml, 'AdfState')[0] ?? null };
}

export interface ScanOptions {
  source: EsclSource;
  colorMode: EsclColor;
  resolution: number;
}

/** A4 in 1/300 inch, clipped to what the scanner can take. */
const A4 = { width: 2480, height: 3508 };

export function scanSettingsXml(o: ScanOptions, area?: { width: number; height: number }): string {
  const width = Math.min(A4.width, area?.width ?? A4.width);
  const height = Math.min(A4.height, area?.height ?? A4.height);
  const source = o.source === 'Platen' ? 'Platen' : 'Feeder';
  return `<?xml version="1.0" encoding="UTF-8"?>
<scan:ScanSettings xmlns:scan="http://schemas.hp.com/imaging/escl/2011/05/03" xmlns:pwg="http://www.pwg.org/schemas/2010/12/sm">
  <pwg:Version>2.0</pwg:Version>
  <pwg:ScanRegions>
    <pwg:ScanRegion>
      <pwg:ContentRegionUnits>escl:ThreeHundredthsOfInches</pwg:ContentRegionUnits>
      <pwg:XOffset>0</pwg:XOffset>
      <pwg:YOffset>0</pwg:YOffset>
      <pwg:Width>${width}</pwg:Width>
      <pwg:Height>${height}</pwg:Height>
    </pwg:ScanRegion>
  </pwg:ScanRegions>
  <pwg:InputSource>${source}</pwg:InputSource>
  <scan:Duplex>${o.source === 'FeederDuplex'}</scan:Duplex>
  <scan:ColorMode>${o.colorMode}</scan:ColorMode>
  <scan:XResolution>${o.resolution}</scan:XResolution>
  <scan:YResolution>${o.resolution}</scan:YResolution>
  <pwg:DocumentFormat>image/jpeg</pwg:DocumentFormat>
  <scan:DocumentFormatExt>image/jpeg</scan:DocumentFormatExt>
</scan:ScanSettings>`;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Runs one scan job and returns its pages as JPEGs (a flatbed gives one page, a feeder every sheet loaded). */
export async function scan(root: string, o: ScanOptions, caps?: EsclCapabilities): Promise<Buffer[]> {
  const area = caps?.maxArea[o.source === 'Platen' ? 'Platen' : 'Feeder'];
  const job = await call(`${root}/ScanJobs`, { method: 'POST', headers: { 'content-type': 'text/xml' }, body: scanSettingsXml(o, area) });
  if (job.status === 409 || job.status === 503) throw new EsclError('اسکنر مشغول است یا کاغذی در سینی نیست', job.status);
  if (job.status !== 201) throw new EsclError(`اسکنر کار اسکن را نپذیرفت (کد ${job.status})`, job.status);
  const location = job.headers.get('location');
  if (!location) throw new EsclError('اسکنر نشانی کار اسکن را برنگرداند');
  // The job must live on the scanner itself, never somewhere the scanner points the server to.
  const jobUrl = new URL(location, `${root}/`);
  if (jobUrl.origin !== new URL(root).origin) throw new EsclError('نشانی کار اسکن معتبر نیست');
  const pages: Buffer[] = [];
  let total = 0;
  let busy = 0;
  while (pages.length < MAX_PAGES) {
    const r = await call(`${jobUrl.toString().replace(/\/$/, '')}/NextDocument`, {}, PAGE_TIMEOUT_MS);
    if (r.status === 404 || r.status === 410) break;
    if (r.status === 503 && busy++ < 30) {
      await sleep(1000);
      continue;
    }
    if (!r.ok) {
      if (pages.length) break;
      throw new EsclError(r.status === 409 ? 'کاغذی در سینی اسکنر نیست' : `دریافت صفحه از اسکنر ممکن نشد (کد ${r.status})`, r.status);
    }
    const buf = Buffer.from(await r.arrayBuffer());
    total += buf.length;
    if (total > MAX_BYTES) throw new EsclError('حجم اسکن از حد مجاز بیشتر است');
    pages.push(buf);
    busy = 0;
    // A flatbed has a single page; some scanners keep answering it.
    if (o.source === 'Platen') break;
  }
  await call(jobUrl.toString(), { method: 'DELETE' }).catch(() => undefined);
  if (!pages.length) throw new EsclError('اسکنر صفحه‌ای برنگرداند');
  return pages;
}
