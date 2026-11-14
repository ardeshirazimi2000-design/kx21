import { useEffect, useRef, useState, type DragEvent } from 'react';
import { jpegsToPdf } from '@kx/shared';
import { get, postForBlob } from '../lib/api';
import { useAction } from '../lib/hooks';
import { Icon } from './icons';
import { Button, ErrorBox, Field, Modal, fa } from './ui';

/** A file on its way to a letter, and how it was obtained (scans are recorded as such on the attachment). */
export interface PickedFile {
  file: File;
  source: 'upload' | 'scan';
}

export const ACCEPT = '.pdf,.doc,.docx,.xls,.xlsx,.png,.jpg,.jpeg,.tif,.tiff,.zip,.txt';

const stamp = () => {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};

/**
 * Every way a paper reaches a letter: a file from the computer, a photo from the phone's camera, a multi-page scan
 * with the camera (turned into one PDF), or a network scanner. Dropping files on the box works too.
 */
export function AttachmentPicker({ onAdd, disabled }: { onAdd: (files: PickedFile[]) => unknown; disabled?: boolean }) {
  const [modal, setModal] = useState<null | 'camera' | 'scanner'>(null);
  const [drag, setDrag] = useState(false);
  const [scanners, setScanners] = useState<{ id: string; name: string; location: string | null }[]>([]);
  useEffect(() => {
    void get<any[]>('/scanners').then(
      (rows) => setScanners(rows.filter((s) => s.is_active)),
      () => setScanners([]),
    );
  }, []);
  const add = (list: FileList | null, source: PickedFile['source'] = 'upload') => {
    if (!list?.length) return;
    void onAdd([...list].map((file) => ({ file, source })));
  };
  const drop = (e: DragEvent) => {
    e.preventDefault();
    setDrag(false);
    if (!disabled) add(e.dataTransfer.files);
  };

  return (
    <div
      className={`capture ${drag ? 'capture-drag' : ''}`}
      onDragOver={(e) => (e.preventDefault(), setDrag(true))}
      onDragLeave={() => setDrag(false)}
      onDrop={drop}
    >
      <div className="capture-actions">
        <label className={`capture-btn ${disabled ? 'disabled' : ''}`}>
          <Icon name="paperclip" />
          <span>
            <strong>انتخاب فایل</strong>
            <small>از رایانه یا گوشی</small>
          </span>
          <input type="file" multiple hidden disabled={disabled} accept={ACCEPT} onChange={(e) => (add(e.target.files), (e.target.value = ''))} />
        </label>
        <label className={`capture-btn ${disabled ? 'disabled' : ''}`}>
          <Icon name="camera" />
          <span>
            <strong>عکس با دوربین</strong>
            <small>دوربین گوشی یا تبلت</small>
          </span>
          <input
            type="file"
            hidden
            disabled={disabled}
            accept="image/*"
            capture="environment"
            onChange={(e) => (add(e.target.files, 'scan'), (e.target.value = ''))}
          />
        </label>
        <button type="button" className="capture-btn" disabled={disabled} onClick={() => setModal('camera')}>
          <Icon name="copy" />
          <span>
            <strong>اسکن چندصفحه‌ای</strong>
            <small>با دوربین، خروجی PDF</small>
          </span>
        </button>
        {scanners.length > 0 && (
          <button type="button" className="capture-btn" disabled={disabled} onClick={() => setModal('scanner')}>
            <Icon name="scanner" />
            <span>
              <strong>اسکنر</strong>
              <small>{scanners.length === 1 ? scanners[0].name : `${fa(scanners.length)} اسکنر شبکه`}</small>
            </span>
          </button>
        )}
      </div>
      <p className="capture-hint" id="capture-limits">
        فایل‌ها را می‌توانید اینجا رها کنید. PDF، Word، Excel، تصویر (JPG، PNG، TIFF)، ZIP و متن؛ هر فایل حداکثر ۵۰ مگابایت.
      </p>
      {modal === 'camera' && <CameraScanModal onClose={() => setModal(null)} onDone={(f) => (setModal(null), void onAdd([{ file: f, source: 'scan' }]))} />}
      {modal === 'scanner' && (
        <ScannerModal scanners={scanners} onClose={() => setModal(null)} onDone={(f) => (setModal(null), void onAdd([{ file: f, source: 'scan' }]))} />
      )}
    </div>
  );
}

// ─────────────── Camera scan ───────────────

type Mode = 'doc' | 'gray' | 'color';
interface Page {
  id: number;
  /** The picture as taken, scaled down; filters and rotation are applied when the PDF is made. */
  source: HTMLCanvasElement;
  rotation: 0 | 90 | 180 | 270;
  preview: string;
}

const MAX_SIDE = 2200;

function toCanvas(img: CanvasImageSource, w: number, h: number): HTMLCanvasElement {
  const k = Math.min(1, MAX_SIDE / Math.max(w, h));
  const c = document.createElement('canvas');
  c.width = Math.round(w * k);
  c.height = Math.round(h * k);
  c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height);
  return c;
}

/**
 * The page as it goes into the PDF. «سند» whitens the paper and darkens the ink: luminance is stretched between the
 * ink level and the paper level read from the picture's own histogram, so shadows and a yellowish light fade out.
 */
function render(p: Page, mode: Mode, maxSide = MAX_SIDE): HTMLCanvasElement {
  const turned = p.rotation === 90 || p.rotation === 270;
  const k = Math.min(1, maxSide / Math.max(p.source.width, p.source.height));
  const sw = Math.round(p.source.width * k);
  const sh = Math.round(p.source.height * k);
  const c = document.createElement('canvas');
  c.width = turned ? sh : sw;
  c.height = turned ? sw : sh;
  const g = c.getContext('2d', { willReadFrequently: true })!;
  g.translate(c.width / 2, c.height / 2);
  g.rotate((p.rotation * Math.PI) / 180);
  g.drawImage(p.source, -sw / 2, -sh / 2, sw, sh);
  if (mode === 'color') return c;
  const img = g.getImageData(0, 0, c.width, c.height);
  const d = img.data;
  const hist = new Uint32Array(256);
  for (let i = 0; i < d.length; i += 4) hist[(d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29) >> 8]++;
  const n = d.length / 4;
  const at = (q: number) => {
    let acc = 0;
    for (let v = 0; v < 256; v++) if ((acc += hist[v]) >= n * q) return v;
    return 255;
  };
  const lo = mode === 'doc' ? at(0.02) : 0;
  const hi = mode === 'doc' ? Math.max(lo + 40, at(0.6)) : 255;
  const lut = new Uint8ClampedArray(256);
  for (let v = 0; v < 256; v++) {
    const t = Math.min(1, Math.max(0, (v - lo) / (hi - lo)));
    lut[v] = mode === 'doc' ? Math.round(255 * Math.pow(t, 1.6)) : v;
  }
  for (let i = 0; i < d.length; i += 4) {
    const y = lut[(d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29) >> 8];
    d[i] = d[i + 1] = d[i + 2] = y;
  }
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.putImageData(img, 0, 0);
  return c;
}

const jpeg = (c: HTMLCanvasElement, quality = 0.82) =>
  new Promise<Uint8Array>((resolve, reject) =>
    c.toBlob((b) => (b ? b.arrayBuffer().then((a) => resolve(new Uint8Array(a)), reject) : reject(new Error('تبدیل تصویر ممکن نشد'))), 'image/jpeg', quality),
  );

function CameraScanModal({ onClose, onDone }: { onClose: () => void; onDone: (f: File) => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [camError, setCamError] = useState<string | null>(null);
  const [pages, setPages] = useState<Page[]>([]);
  const [mode, setMode] = useState<Mode>('doc');
  const [flash, setFlash] = useState(false);
  const act = useAction();
  const nextId = useRef(1);

  useEffect(() => {
    let live: MediaStream | null = null;
    let cancelled = false;
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      setCamError('دوربین زنده فقط روی نشانی امن (HTTPS) در دسترس است. از دکمه «افزودن عکس» استفاده کنید تا دوربین گوشی باز شود.');
      return;
    }
    navigator.mediaDevices
      .getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 2560 }, height: { ideal: 1440 } }, audio: false })
      .then((s) => {
        if (cancelled) return s.getTracks().forEach((t) => t.stop());
        live = s;
        setStream(s);
      })
      .catch((e) =>
        setCamError(
          e?.name === 'NotAllowedError'
            ? 'اجازه استفاده از دوربین داده نشد. در تنظیمات مرورگر اجازه دوربین را برای این سامانه فعال کنید، یا از «افزودن عکس» استفاده کنید.'
            : 'دوربینی پیدا نشد. از «افزودن عکس» استفاده کنید.',
        ),
      );
    return () => {
      cancelled = true;
      live?.getTracks().forEach((t) => t.stop());
    };
  }, []);
  useEffect(() => {
    if (video.current && stream) video.current.srcObject = stream;
  }, [stream]);

  const pushPage = (source: HTMLCanvasElement) => {
    const page: Page = { id: nextId.current++, source, rotation: 0, preview: '' };
    page.preview = render(page, mode, 360).toDataURL('image/jpeg', 0.7);
    setPages((ps) => [...ps, page]);
  };
  const shoot = () => {
    const v = video.current;
    if (!v || !v.videoWidth) return;
    pushPage(toCanvas(v, v.videoWidth, v.videoHeight));
    setFlash(true);
    setTimeout(() => setFlash(false), 180);
  };
  const addPhotos = async (files: FileList | null) => {
    for (const f of [...(files ?? [])]) {
      const bmp = await createImageBitmap(f, { imageOrientation: 'from-image' } as ImageBitmapOptions);
      pushPage(toCanvas(bmp, bmp.width, bmp.height));
      bmp.close();
    }
  };
  const refresh = (ps: Page[], m: Mode) => ps.map((p) => ({ ...p, preview: render(p, m, 360).toDataURL('image/jpeg', 0.7) }));
  const changeMode = (m: Mode) => (setMode(m), setPages((ps) => refresh(ps, m)));
  const rotate = (id: number) =>
    setPages((ps) =>
      refresh(
        ps.map((p) => (p.id === id ? { ...p, rotation: ((p.rotation + 90) % 360) as Page['rotation'] } : p)),
        mode,
      ),
    );
  const move = (i: number, d: -1 | 1) =>
    setPages((ps) => {
      const j = i + d;
      if (j < 0 || j >= ps.length) return ps;
      const next = [...ps];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });

  const finish = () =>
    act.run(async () => {
      const jpegs: Uint8Array[] = [];
      for (const p of pages) jpegs.push(await jpeg(render(p, mode)));
      const pdf = jpegsToPdf(jpegs);
      onDone(new File([pdf as BlobPart], `اسکن-${stamp()}.pdf`, { type: 'application/pdf' }));
    });

  return (
    <Modal
      title="اسکن با دوربین"
      onClose={onClose}
      wide
      footer={
        <>
          <Button busy={act.busy} disabled={!pages.length} onClick={finish}>
            ساخت PDF و پیوست ({fa(pages.length)} صفحه)
          </Button>
          <Button variant="ghost" onClick={onClose}>
            انصراف
          </Button>
        </>
      }
    >
      <ErrorBox error={act.error} />
      <div className="scan-stage">
        {stream ? (
          <div className={`scan-video ${flash ? 'flash' : ''}`}>
            <video ref={video} autoPlay playsInline muted />
            <div className="scan-frame" aria-hidden />
          </div>
        ) : (
          <div className="scan-video scan-video-empty">{camError ?? 'در حال روشن کردن دوربین…'}</div>
        )}
        <div className="scan-controls">
          <button type="button" className="shutter" onClick={shoot} disabled={!stream} aria-label="گرفتن عکس صفحه">
            <span />
          </button>
          <label className="btn btn-secondary btn-sm">
            افزودن عکس
            <input
              type="file"
              accept="image/*"
              capture="environment"
              multiple
              hidden
              onChange={(e) => void addPhotos(e.target.files).then(() => (e.target.value = ''))}
            />
          </label>
          <div className="seg" role="radiogroup" aria-label="حالت تصویر">
            {(
              [
                ['doc', 'سند'],
                ['gray', 'خاکستری'],
                ['color', 'رنگی'],
              ] as const
            ).map(([k, label]) => (
              <button key={k} type="button" role="radio" aria-checked={mode === k} className={mode === k ? 'on' : ''} onClick={() => changeMode(k)}>
                {label}
              </button>
            ))}
          </div>
        </div>
      </div>
      <p className="small muted">
        کاغذ را روی سطحی تیره و در نور کافی بگذارید و دوربین را موازی کاغذ نگه دارید. هر صفحه را جدا بگیرید؛ همه صفحه‌ها یک فایل PDF می‌شوند.
      </p>
      {pages.length > 0 && (
        <ol className="scan-pages">
          {pages.map((p, i) => (
            <li key={p.id}>
              <img src={p.preview} alt={`صفحه ${fa(i + 1)}`} />
              <span className="scan-page-no">{fa(i + 1)}</span>
              <div className="scan-page-tools">
                <button type="button" onClick={() => move(i, -1)} disabled={i === 0} aria-label="جابه‌جایی به قبل">
                  ›
                </button>
                <button type="button" onClick={() => rotate(p.id)} aria-label="چرخش">
                  <Icon name="rotate" size={14} />
                </button>
                <button type="button" onClick={() => setPages(pages.filter((x) => x.id !== p.id))} aria-label="حذف صفحه">
                  <Icon name="x" size={14} />
                </button>
                <button type="button" onClick={() => move(i, 1)} disabled={i === pages.length - 1} aria-label="جابه‌جایی به بعد">
                  ‹
                </button>
              </div>
            </li>
          ))}
        </ol>
      )}
    </Modal>
  );
}

// ─────────────── Network scanner ───────────────

const SOURCE_LABEL: Record<string, string> = { Platen: 'شیشه اسکنر (تک‌صفحه)', Feeder: 'سینی کاغذ (چندصفحه)', FeederDuplex: 'سینی کاغذ، دورو' };

function ScannerModal({
  scanners,
  onClose,
  onDone,
}: {
  scanners: { id: string; name: string; location: string | null }[];
  onClose: () => void;
  onDone: (f: File) => void;
}) {
  const [id, setId] = useState(scanners[0]?.id ?? '');
  const [caps, setCaps] = useState<any>(null);
  const [capsError, setCapsError] = useState<Error | null>(null);
  const [opts, setOpts] = useState({ source: 'Platen', colorMode: 'Grayscale8', resolution: 300 });
  const act = useAction();
  useEffect(() => {
    if (!id) return;
    setCaps(null);
    setCapsError(null);
    void get(`/scanners/${id}/capabilities`).then(
      (c) => {
        setCaps(c);
        setOpts((o) => ({
          source: c.sources.includes(o.source) ? o.source : (c.sources[0] ?? 'Platen'),
          colorMode: c.colorModes.includes(o.colorMode) ? o.colorMode : (c.colorModes[0] ?? 'RGB24'),
          resolution: c.resolutions.includes(300) ? 300 : (c.resolutions[c.resolutions.length - 1] ?? 300),
        }));
      },
      (e) => setCapsError(e),
    );
  }, [id]);
  const scan = () =>
    act.run(async () => {
      const { blob } = await postForBlob(`/scanners/${id}/scan`, opts);
      const name = scanners.find((s) => s.id === id)?.name ?? 'اسکنر';
      onDone(new File([blob], `اسکن-${name}-${stamp()}.pdf`, { type: 'application/pdf' }));
    });
  return (
    <Modal
      title="اسکن از اسکنر"
      onClose={onClose}
      footer={
        <>
          <Button busy={act.busy} disabled={!id || !!capsError} onClick={scan}>
            {act.busy ? 'در حال اسکن…' : 'شروع اسکن'}
          </Button>
          <Button variant="ghost" onClick={onClose} disabled={act.busy}>
            انصراف
          </Button>
        </>
      }
    >
      <ErrorBox error={act.error ?? capsError} />
      <Field label="اسکنر">
        <select className="input" value={id} onChange={(e) => setId(e.target.value)} disabled={act.busy}>
          {scanners.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
              {s.location ? ` — ${s.location}` : ''}
            </option>
          ))}
        </select>
      </Field>
      {caps && (
        <>
          <p className="small muted">
            {caps.makeAndModel ?? 'اسکنر شبکه'}
            {caps.state ? ` — ${caps.state === 'Idle' ? 'آماده' : caps.state === 'Processing' ? 'مشغول' : caps.state}` : ''}
            {caps.adfState === 'ScannerAdfEmpty' ? ' — سینی کاغذ خالی است' : ''}
          </p>
          <div className="grid grid-3">
            <Field label="منبع کاغذ">
              <select className="input" value={opts.source} onChange={(e) => setOpts({ ...opts, source: e.target.value })}>
                {caps.sources.map((s: string) => (
                  <option key={s} value={s}>
                    {SOURCE_LABEL[s] ?? s}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="رنگ">
              <select className="input" value={opts.colorMode} onChange={(e) => setOpts({ ...opts, colorMode: e.target.value })}>
                {caps.colorModes.map((c: string) => (
                  <option key={c} value={c}>
                    {c === 'RGB24' ? 'رنگی' : 'سیاه‌وسفید (خاکستری)'}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="کیفیت (dpi)">
              <select className="input" value={opts.resolution} onChange={(e) => setOpts({ ...opts, resolution: Number(e.target.value) })}>
                {caps.resolutions.map((r: number) => (
                  <option key={r} value={r}>
                    {fa(r)}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <p className="small muted">کاغذها را در اسکنر بگذارید و «شروع اسکن» را بزنید؛ همه صفحه‌ها یک فایل PDF می‌شوند و به نامه پیوست می‌شوند.</p>
        </>
      )}
      {!caps && !capsError && <p className="small muted">در حال خواندن مشخصات اسکنر…</p>}
    </Modal>
  );
}

/** Chips of the files chosen for a letter that is not saved yet. */
export function PickedList({ files, onRemove }: { files: PickedFile[]; onRemove: (i: number) => void }) {
  if (!files.length) return null;
  const size = (b: number) => (b > 1024 * 1024 ? `${fa((b / 1024 / 1024).toFixed(1))} مگابایت` : `${fa(Math.ceil(b / 1024))} کیلوبایت`);
  return (
    <ul className="picked">
      {files.map((f, i) => (
        <li key={`${f.file.name}-${i}`}>
          <Icon name={f.source === 'scan' ? 'scanner' : 'paperclip'} size={16} />
          <span className="picked-name">{f.file.name}</span>
          <span className="small muted">{size(f.file.size)}</span>
          <button type="button" className="icon-btn" onClick={() => onRemove(i)} aria-label={`حذف ${f.file.name}`}>
            ×
          </button>
        </li>
      ))}
    </ul>
  );
}
