import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { LetterBody, LetterPaper, paperLetter, type LetterTemplate } from '../components/letterPaper';
import { Button, ErrorBox, Loading } from '../components/ui';
import { fetchText, get } from '../lib/api';
import { useApi } from '../lib/hooks';

/** The letter alone on its letterhead, for printing or saving as PDF (outside the app shell). */
export function LetterPrintPage() {
  const { id } = useParams();
  const r = useApi<any>(`/letters/${id}`, [id]);
  const [template, setTemplate] = useState<LetterTemplate | null | undefined>(undefined);
  const [qr, setQr] = useState<string | null>(null);
  const l = r.data;

  useEffect(() => {
    if (!l) return;
    if (l.template_id) void get<LetterTemplate>(`/letter-templates/${l.template_id}`).then(setTemplate, () => setTemplate(null));
    else if (l.kind === 'incoming') setTemplate(null);
    else
      void get<LetterTemplate[]>('/letter-templates').then(
        (ts) => setTemplate(ts.find((t) => t.is_default && t.kinds.includes(l.kind)) ?? null),
        () => setTemplate(null),
      );
    if (l.number) void fetchText(`/letters/${l.id}/qr.svg`).then(setQr, () => setQr(null));
  }, [l]);

  if (r.error) return <ErrorBox error={r.error} />;
  if (!l || template === undefined) return <Loading />;
  const size = template?.page_size ?? 'A4';
  const fileName = `نامه-${(l.number ?? l.tracking_code).replace(/\//g, '-')}.pdf`;

  // The browser's own print engine gives a vector PDF with exact Persian shaping; the page title names the file.
  const print = () => {
    const title = document.title;
    document.title = fileName.replace(/\.pdf$/, '');
    window.addEventListener('afterprint', () => (document.title = title), { once: true });
    window.print();
  };

  return (
    <div className="print-letter">
      <style>{`@page { size: ${size}; margin: 0; } @media print { body { background: #fff; } }`}</style>
      <div className="print-bar no-print">
        <Link to={`/letters/${l.id}`} className="btn btn-ghost btn-sm">
          بازگشت به نامه
        </Link>
        <span className="grow" />
        {!l.number || !l.signatures.length ? <span className="small muted">نامه هنوز امضا و شماره نشده است؛ نسخه چاپی «پیش‌نویس» دارد.</span> : null}
        <span className="small muted">برای فایل PDF، در پنجره چاپ مقصد را «Save as PDF» انتخاب کنید.</span>
        <Button size="sm" onClick={print}>
          چاپ / ذخیره PDF
        </Button>
      </div>
      <div className="paper-wrap">
        <LetterPaper template={template} letter={paperLetter(l, { qrSvg: qr })}>
          <LetterBody body={l.body} format={l.body_format} />
        </LetterPaper>
      </div>
    </div>
  );
}
