import { useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import { blobUrl } from '../lib/api';
import { AuthImage } from './signature';
import { dateFa, fa } from './ui';

export interface LetterTemplate {
  id: string;
  name: string;
  description?: string | null;
  kinds: string[];
  unit_id: string | null;
  unit_name?: string | null;
  page_size: 'A4' | 'A5';
  header_text: string | null;
  org_name: string | null;
  org_subtitle: string | null;
  footer_text: string | null;
  show_logo: boolean;
  has_logo: boolean;
  has_background: boolean;
  margin_top: number;
  margin_bottom: number;
  margin_side: number;
  font_size: number;
  show_qr: boolean;
  body_html: string | null;
  is_default: boolean;
  is_active: boolean;
  updated_at?: string;
}

export interface PaperSignature {
  key: string;
  name: string;
  position?: string | null;
  imagePath?: string | null;
}

export interface PaperLetter {
  kind: string;
  number?: string | null;
  date?: string | null;
  hasAttachments?: boolean;
  subject: string;
  /** Outgoing: addressee lines; internal: «به: …» */
  to: string[];
  cc?: string[];
  signatures: PaperSignature[];
  trackingCode?: string | null;
  qrSvg?: string | null;
  /** Shown faintly across the page until the letter is final. */
  watermark?: string | null;
}

const PAGE = { A4: { w: 210, h: 297 }, A5: { w: 148, h: 210 } } as const;

/** Object URL for an authenticated image, revoked on unmount. */
export function useBlobUrl(path: string | null) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!path) return setUrl(null);
    let u: string | null = null;
    let live = true;
    blobUrl(path)
      .then((x) => (live ? setUrl((u = x)) : URL.revokeObjectURL(x)))
      .catch(() => setUrl(null));
    return () => {
      live = false;
      if (u) URL.revokeObjectURL(u);
    };
  }, [path]);
  return url;
}

/**
 * A letter laid out on its letterhead, as typed and as printed: header (or a full-page scanned letterhead),
 * number/date/attachment box, addressee, subject, body, signatures, copies and footer with the QR code.
 */
export function LetterPaper({
  template,
  letter,
  children,
  editing,
}: {
  template: LetterTemplate | null;
  letter: PaperLetter;
  children: ReactNode;
  editing?: boolean;
}) {
  const t = template;
  const size = PAGE[t?.page_size ?? 'A4'];
  const background = useBlobUrl(t?.has_background ? `/letter-templates/${t.id}/background?v=${t.updated_at ?? ''}` : null);
  const logo = useBlobUrl(t?.show_logo && t.has_logo ? `/letter-templates/${t.id}/logo?v=${t.updated_at ?? ''}` : null);
  const style: CSSProperties = {
    width: `${size.w}mm`,
    minHeight: `${size.h}mm`,
    padding: `${t?.margin_top ?? 15}mm ${t?.margin_side ?? 18}mm ${t?.margin_bottom ?? 15}mm`,
    fontSize: `${t?.font_size ?? 13}pt`,
    backgroundImage: background ? `url(${background})` : undefined,
  };
  const drawnHeader = !t?.has_background;
  return (
    <div className={`paper paper-${(t?.page_size ?? 'A4').toLowerCase()} ${editing ? 'paper-editing' : ''}`} style={style}>
      {letter.watermark && <div className="paper-watermark">{letter.watermark}</div>}
      {drawnHeader ? (
        <header className="paper-head">
          <div className="paper-org">
            {t?.show_logo !== false && (logo ? <img src={logo} alt="" /> : <img src="/iran-chamber-logo.png" className="paper-default-logo" alt="" />)}
            {t?.org_name && <strong>{t.org_name}</strong>}
            {t?.org_subtitle && <span>{t.org_subtitle}</span>}
          </div>
          <div className="paper-bismillah">{t?.header_text}</div>
          <NumberBox letter={letter} />
        </header>
      ) : (
        <div className="paper-head paper-head-over">
          <NumberBox letter={letter} />
        </div>
      )}
      <div className="paper-to">
        {letter.to.map((x, i) => (
          <div key={i}>{x}</div>
        ))}
      </div>
      <div className="paper-subject">
        <span>موضوع:</span> {letter.subject || '…'}
      </div>
      <div className="paper-body">{children}</div>
      <div className="paper-signatures">
        {letter.signatures.map((s) => (
          <div key={s.key} className="paper-signature">
            {s.imagePath ? <AuthImage path={s.imagePath} alt={`امضای ${s.name}`} height={70} /> : <div className="paper-signature-space" />}
            <strong>{s.name}</strong>
            {s.position && <span>{s.position}</span>}
          </div>
        ))}
      </div>
      {!!letter.cc?.length && (
        <div className="paper-cc">
          <strong>رونوشت:</strong>
          {letter.cc.map((x, i) => (
            <div key={i}>{x}</div>
          ))}
        </div>
      )}
      <footer className="paper-foot">
        <div className="paper-foot-text">{t?.footer_text}</div>
        {t?.show_qr !== false && letter.qrSvg && (
          <div className="paper-qr">
            <div dangerouslySetInnerHTML={{ __html: letter.qrSvg }} />
            <span className="mono">{letter.trackingCode}</span>
          </div>
        )}
      </footer>
    </div>
  );
}

function NumberBox({ letter }: { letter: PaperLetter }) {
  return (
    <dl className="paper-number">
      <dt>شماره:</dt>
      <dd className="letter-number">{letter.number ? fa(letter.number) : '……'}</dd>
      <dt>تاریخ:</dt>
      <dd>{letter.date ? dateFa(letter.date) : '……'}</dd>
      <dt>پیوست:</dt>
      <dd>{letter.hasAttachments ? 'دارد' : 'ندارد'}</dd>
    </dl>
  );
}

/** Letter body as stored: sanitised HTML from the editor, or plain text. */
export function LetterBody({ body, format }: { body: string | null; format: string }) {
  if (!body) return null;
  if (format === 'html') return <div className="letter-html" dangerouslySetInnerHTML={{ __html: body }} />;
  return <div className="letter-text">{body}</div>;
}

/** PaperLetter from the letter API response. */
export function paperLetter(l: any, opts: { qrSvg?: string | null; draftSigner?: { name: string; position?: string | null } | null } = {}): PaperLetter {
  const signed = (l.signatures ?? []).filter((s: any) => s.valid && s.intact);
  const signatures: PaperSignature[] = signed.length
    ? signed.map((s: any) => ({
        key: s.id,
        name: s.full_name,
        position: s.position_title,
        imagePath: s.has_image ? `/letters/${l.id}/signatures/${s.id}/image` : null,
      }))
    : l.signatory_name
      ? [{ key: 'signatory', name: l.signatory_name, position: l.signatory_position }]
      : opts.draftSigner
        ? [{ key: 'signatory', ...opts.draftSigner }]
        : [];
  const to =
    l.kind === 'internal'
      ? (l.recipients ?? []).filter((r: any) => r.kind === 'to').map((r: any) => recipientLabel(r))
      : [l.external_party, l.external_org].filter(Boolean);
  const cc = l.kind === 'internal' ? (l.recipients ?? []).filter((r: any) => r.kind === 'cc').map((r: any) => recipientLabel(r)) : [];
  const final = !!l.number && signed.length > 0;
  return {
    kind: l.kind,
    number: l.number,
    date: l.registered_at,
    hasAttachments: (l.attachments ?? []).length > 0,
    subject: l.subject,
    to: l.kind === 'internal' && to.length ? [`به: ${to.join('، ')}`] : to,
    cc,
    signatures,
    trackingCode: l.number ? l.tracking_code : null,
    qrSvg: l.number ? opts.qrSvg : null,
    watermark: l.status === 'cancelled' ? 'ابطال‌شده' : final ? null : 'پیش‌نویس',
  };
}

const recipientLabel = (r: any) =>
  r.user_name ?? r.label ?? (r.position_title ? `${r.position_title}${r.position_unit ? ` ${r.position_unit}` : ''}` : r.unit_name);
