import { useParams } from 'react-router-dom';
import { KIND } from '../components/labels';
import { Badge, Card, ErrorBox, Loading, dateFa, dateTimeFa, fa } from '../components/ui';
import { useApi } from '../lib/hooks';

/** Public page behind the QR code printed on letters. */
export function VerifyPage() {
  const { code } = useParams();
  const r = useApi<any>(`/verify/${code}`, [code]);
  return (
    <div className="verify">
      <div className="login-brand" style={{ color: 'inherit' }}>
        <img src="/iran-chamber-logo.png" width={72} height={72} alt="لوگوی اتاق ایران" />
        <h1>صحت‌سنجی نامه</h1>
        <p className="muted">اتاق بازرگانی، صنایع، معادن و کشاورزی ایران</p>
      </div>
      {r.loading ? (
        <Loading />
      ) : r.error ? (
        <ErrorBox error={r.error} />
      ) : (
        <Card>
          <div className="alert alert-success">این نامه در دبیرخانه ثبت شده و معتبر است.</div>
          <dl className="kv">
            <dt>شماره</dt>
            <dd className="letter-number">{fa(r.data.number)}</dd>
            <dt>نوع</dt>
            <dd>{KIND[r.data.kind]}</dd>
            <dt>تاریخ ثبت</dt>
            <dd>{dateFa(r.data.registeredAt)}</dd>
            {r.data.subject && (
              <>
                <dt>موضوع</dt>
                <dd>{r.data.subject}</dd>
              </>
            )}
            {r.data.party && (
              <>
                <dt>گیرنده</dt>
                <dd>{r.data.party}</dd>
              </>
            )}
            {r.data.sentAt && (
              <>
                <dt>تاریخ ارسال</dt>
                <dd>{dateFa(r.data.sentAt)}</dd>
              </>
            )}
          </dl>
          {r.data.signatures.length > 0 && (
            <>
              <h3 className="mt">امضاها</h3>
              <ul className="list">
                {r.data.signatures.map((s: any, i: number) => (
                  <li key={i} className="row gap-sm wrap">
                    <strong>{s.signer}</strong>
                    <span className="muted">{s.position}</span>
                    <span className="small muted">{dateTimeFa(s.signedAt)}</span>
                    {s.valid && s.intact ? <Badge tone="success">معتبر</Badge> : <Badge tone="danger">نامعتبر یا تغییر یافته</Badge>}
                  </li>
                ))}
              </ul>
            </>
          )}
        </Card>
      )}
    </div>
  );
}
