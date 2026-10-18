import { useEffect, useRef, useState } from 'react';
import { api, del, post } from '../lib/api';
import { useApi, useSocket } from '../lib/hooks';
import { Badge, Button, Card, ErrorBox, fa } from './ui';

/**
 * Live presentation of a meeting document (ارائه مستقیم): the chair/secretary picks a PDF, image or
 * PowerPoint/Word file from the meeting's documents and turns the pages; everyone's view follows.
 */

const PRESENTABLE = [
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/webp',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.openxmlformats-officedocument.presentationml.slideshow',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/msword',
];

type Link = { url: string; type: 'pages' | 'pdf' | 'image'; pages: number | null };
type PdfDoc = { numPages: number; getPage: (n: number) => Promise<any>; destroy: () => Promise<void> };

/** Loads PDF.js only when a presentation is shown (keeps the main bundle small). */
async function loadPdf(url: string): Promise<PdfDoc> {
  const pdfjs = await import('pdfjs-dist');
  const worker = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default;
  pdfjs.GlobalWorkerOptions.workerSrc = worker;
  return pdfjs.getDocument({ url, isEvalSupported: false }).promise as unknown as Promise<PdfDoc>;
}

/**
 * Shows one page: a page image rendered on the server (`pages`, the usual case), a picture, or — when the
 * server cannot render pages — the PDF drawn in the browser with PDF.js.
 */
function Slide({ link, page, onPages }: { link: Link; page: number; onPages: (n: number) => void }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const [doc, setDoc] = useState<PdfDoc | null>(null);
  const [err, setErr] = useState<Error | null>(null);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    if (link.type !== 'pdf') {
      onPages(link.pages ?? 1);
      return;
    }
    let alive = true;
    let loaded: PdfDoc | null = null;
    setDoc(null);
    loadPdf(link.url).then(
      (d) => {
        loaded = d;
        if (!alive) return void d.destroy();
        setDoc(d);
        onPages(d.numPages);
      },
      (e) => alive && setErr(e),
    );
    return () => {
      alive = false;
      void loaded?.destroy();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [link.url]);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    if (!doc || !canvas.current || !width) return;
    let task: any;
    let cancelled = false;
    void doc.getPage(Math.min(Math.max(page, 1), doc.numPages)).then((p) => {
      if (cancelled) return;
      const base = p.getViewport({ scale: 1 });
      const fit = document.fullscreenElement ? Math.min(width / base.width, (window.innerHeight - 70) / base.height) : width / base.width;
      const ratio = window.devicePixelRatio || 1;
      const vp = p.getViewport({ scale: fit * ratio });
      const c = canvas.current!;
      c.width = vp.width;
      c.height = vp.height;
      c.style.width = `${vp.width / ratio}px`;
      c.style.height = `${vp.height / ratio}px`;
      task = p.render({ canvasContext: c.getContext('2d')!, viewport: vp });
      task.promise.catch(() => {});
    });
    return () => {
      cancelled = true;
      task?.cancel?.();
    };
  }, [doc, page, width]);

  // Preload the next slide so turning the page is instant.
  useEffect(() => {
    if (link.type === 'pages' && link.pages && page < link.pages) new Image().src = `${link.url}${page + 1}`;
  }, [link, page]);

  return (
    <div ref={box} className="pres-stage">
      <ErrorBox error={err} />
      {link.type === 'pages' ? (
        <img src={`${link.url}${Math.min(Math.max(page, 1), link.pages ?? 1)}`} alt={`صفحه ${fa(page)}`} />
      ) : link.type === 'image' ? (
        <img src={link.url} alt="" />
      ) : (
        <canvas ref={canvas} />
      )}
      {link.type === 'pdf' && !doc && !err && <p className="muted">در حال بارگذاری…</p>}
    </div>
  );
}

export function PresentationCard({ meetingId }: { meetingId: string }) {
  const { data, reload } = useApi<{ presentation: any; canPresent: boolean }>(`/meetings/${meetingId}/presentation`);
  const docs = useApi<any[]>(data?.canPresent ? `/documents?meetingId=${meetingId}` : null);
  const [pres, setPres] = useState<any | null | undefined>(undefined);
  const [link, setLink] = useState<(Link & { docId: string }) | null>(null);
  const [pages, setPages] = useState(1);
  const [follow, setFollow] = useState(true);
  const [ownPage, setOwnPage] = useState(1);
  const [pick, setPick] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<Error | null>(null);
  const card = useRef<HTMLDivElement>(null);

  useSocket({ 'presentation.updated': (p) => p.meetingId === meetingId && setPres(p.presentation), reconnect: () => void reload() }, meetingId);
  const current = pres === undefined ? data?.presentation : pres;
  const presenter = !!data?.canPresent;
  const page = presenter || follow ? (current?.page ?? 1) : ownPage;

  // Fetch a (long-lived) link whenever the presented document changes.
  useEffect(() => {
    if (!current?.documentId || link?.docId === current.documentId) return;
    let alive = true;
    setLink(null);
    post<Link>(`/documents/${current.documentId}/present-link`).then(
      (l) => alive && setLink({ ...l, docId: current.documentId }),
      (e) => alive && setErr(e),
    );
    return () => {
      alive = false;
    };
  }, [current?.documentId, link?.docId]);

  const go = async (documentId: string, p: number) => {
    setBusy(true);
    setErr(null);
    try {
      const r = await api<any>(`/meetings/${meetingId}/presentation`, { method: 'PUT', json: { documentId, page: p } });
      setPres(r.presentation);
    } catch (e) {
      setErr(e as Error);
    } finally {
      setBusy(false);
    }
  };
  const turn = (delta: number) => {
    if (!current) return;
    const next = Math.min(Math.max(page + delta, 1), pages);
    if (next === page) return;
    if (presenter) void go(current.documentId, next);
    else {
      setFollow(false);
      setOwnPage(next);
    }
  };

  // Keyboard: → ↓ PageDown Space = next; ← ↑ PageUp = previous (as in PowerPoint).
  useEffect(() => {
    if (!current) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest('input, textarea, select, [contenteditable]')) return;
      if (['ArrowRight', 'ArrowDown', 'PageDown', ' '].includes(e.key)) {
        e.preventDefault();
        turn(1);
      } else if (['ArrowLeft', 'ArrowUp', 'PageUp'].includes(e.key)) {
        e.preventDefault();
        turn(-1);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  if (!data) return null;
  const presentable = (docs.data ?? []).filter((d) => PRESENTABLE.includes(d.mime_type));
  if (!current && !presenter) return null;

  if (!current) {
    return (
      <Card title="📽️ ارائه مستقیم فایل" className="mb">
        <ErrorBox error={err} />
        <p className="muted small" style={{ marginTop: 0 }}>
          یکی از فایل‌های «مستندات» جلسه (PDF، پاورپوینت، Word یا عکس) را انتخاب کنید تا برای همه حاضران — در سالن یا در وبینار — نمایش داده شود و صفحه‌ها همراه با شما ورق بخورد.
        </p>
        {presentable.length === 0 ? (
          <p className="muted small">ابتدا فایل ارائه را در زبانه «مستندات» بارگذاری کنید.</p>
        ) : (
          <div className="row gap-sm wrap">
            <select className="input grow" value={pick} onChange={(e) => setPick(e.target.value)} aria-label="فایل ارائه">
              <option value="">انتخاب فایل…</option>
              {presentable.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.title ?? d.file_name}
                </option>
              ))}
            </select>
            <Button busy={busy} disabled={!pick} onClick={() => void go(pick, 1)}>
              شروع ارائه
            </Button>
          </div>
        )}
        {busy && <p className="muted small">آماده‌سازی فایل (تبدیل پاورپوینت ممکن است چند ثانیه طول بکشد)…</p>}
      </Card>
    );
  }

  const fullscreen = () => (document.fullscreenElement ? document.exitFullscreen() : card.current?.requestFullscreen());
  return (
    <div ref={card} className="card mb pres-card">
      <div className="row wrap gap-sm pres-bar">
        <strong>📽️ {current.document?.title ?? current.document?.file_name}</strong>
        <span className="muted small">ارائه‌دهنده: {current.presenterName}</span>
        <span className="grow" />
        <Button size="sm" variant="ghost" onClick={() => turn(-1)} disabled={page <= 1 || busy} aria-label="صفحه قبل">
          ‹ قبلی
        </Button>
        <Badge>
          {fa(page)} / {fa(pages)}
        </Badge>
        <Button size="sm" variant="ghost" onClick={() => turn(1)} disabled={page >= pages || busy} aria-label="صفحه بعد">
          بعدی ›
        </Button>
        {!presenter && (
          <label className="check small" style={{ margin: 0 }}>
            <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} /> همراه با ارائه‌دهنده
          </label>
        )}
        <Button size="sm" variant="secondary" onClick={() => void fullscreen()}>
          تمام‌صفحه
        </Button>
        {presenter && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() =>
              del(`/meetings/${meetingId}/presentation`).then(
                () => setPres(null),
                (e) => setErr(e),
              )
            }
          >
            <span style={{ color: 'var(--danger)' }}>پایان ارائه</span>
          </Button>
        )}
      </div>
      <ErrorBox error={err} />
      {link ? <Slide link={link} page={page} onPages={setPages} /> : <p className="muted">در حال آماده‌سازی…</p>}
      {presenter && <p className="muted small pres-hint">با کلیدهای جهت‌نما یا Page Down / Page Up هم صفحه عوض می‌شود.</p>}
    </div>
  );
}
