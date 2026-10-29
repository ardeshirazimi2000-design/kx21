import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { ConfBadge, KIND, KindBadge, PRIORITY, Pill, SOURCE, STATUS } from '../components/labels';
import { ContactPicker } from '../components/contacts';
import { UnitSelect } from '../components/pickers';
import { Button, Card, Empty, ErrorBox, Field, JalaliDateInput, Loading, PageHeader, Pager, dateFa, fa } from '../components/ui';
import { get } from '../lib/api';
import { useApi } from '../lib/hooks';

const BOXES = [
  ['all', 'همه نامه‌ها'],
  ['mine', 'ایجادشده توسط من'],
  ['drafts', 'پیش‌نویس‌های من'],
  ['sent', 'ارسال‌شده'],
] as const;

export function LettersPage() {
  const [sp, setSp] = useSearchParams();
  const nav = useNavigate();
  const [page, setPage] = useState(1);
  const [advanced, setAdvanced] = useState(false);
  const f = Object.fromEntries(sp.entries());
  const set = (k: string, v: string) => {
    const n = new URLSearchParams(sp);
    if (v) n.set(k, v);
    else n.delete(k);
    setSp(n, { replace: true });
    setPage(1);
  };
  const qs = new URLSearchParams({ ...f, page: String(page), pageSize: '20' }).toString();
  const r = useApi<{ items: any[]; total: number; page: number; pageSize: number }>(`/letters?${qs}`, [qs]);
  const [code, setCode] = useState('');
  const [lookupError, setLookupError] = useState<Error | null>(null);
  useEffect(() => setLookupError(null), [code]);

  return (
    <>
      <PageHeader
        title="مکاتبات"
        subtitle="جستجوی پیشرفته در نامه‌های وارده، صادره و داخلی"
        actions={
          <Link to="/letters/new" className="btn btn-primary">
            نامه جدید
          </Link>
        }
      />
      <Card>
        <div className="row gap wrap mb">
          <select className="input" style={{ maxWidth: 200 }} value={f.box ?? 'all'} onChange={(e) => set('box', e.target.value === 'all' ? '' : e.target.value)}>
            {BOXES.map(([k, l]) => (
              <option key={k} value={k}>
                {l}
              </option>
            ))}
          </select>
          <select className="input" style={{ maxWidth: 140 }} value={f.kind ?? ''} onChange={(e) => set('kind', e.target.value)}>
            <option value="">همه انواع</option>
            {Object.entries(KIND).map(([k, l]) => (
              <option key={k} value={k}>
                {l}
              </option>
            ))}
          </select>
          <select className="input" style={{ maxWidth: 160 }} value={f.status ?? ''} onChange={(e) => set('status', e.target.value)}>
            <option value="">همه وضعیت‌ها</option>
            {Object.entries(STATUS).map(([k, [l]]) => (
              <option key={k} value={k}>
                {l}
              </option>
            ))}
          </select>
          <input className="input grow" placeholder="جستجو در موضوع، متن، خلاصه و طرف مکاتبه…" defaultValue={f.q ?? ''} onKeyDown={(e) => e.key === 'Enter' && set('q', (e.target as HTMLInputElement).value.trim())} />
          <Button variant="ghost" onClick={() => setAdvanced(!advanced)}>
            {advanced ? 'جستجوی ساده' : 'جستجوی پیشرفته'}
          </Button>
        </div>
        {advanced && (
          <div className="grid grid-4 mb">
            <Field label="شماره نامه (داخلی یا طرف مقابل)">
              <input className="input" defaultValue={f.number ?? ''} onBlur={(e) => set('number', e.target.value.trim())} />
            </Field>
            <Field label="طرف مکاتبه">
              <input className="input" defaultValue={f.party ?? ''} onBlur={(e) => set('party', e.target.value.trim())} />
            </Field>
            <div className="field">
              <span className="field-label">مخاطب بیرونی (با زیرمجموعه‌ها)</span>
              <ContactPicker value={f.contactId ?? ''} onChange={(v) => set('contactId', v)} placeholder="همه مخاطبین" />
            </div>
            <Field label="از تاریخ">
              <JalaliDateInput value={f.from ?? ''} onChange={(v) => set('from', v)} />
            </Field>
            <Field label="تا تاریخ">
              <JalaliDateInput value={f.to ?? ''} onChange={(v) => set('to', v)} />
            </Field>
            <Field label="واحد">
              <UnitSelect value={f.unitId ?? ''} onChange={(v) => set('unitId', v)} emptyLabel="همه واحدها" />
            </Field>
            <Field label="اولویت">
              <select className="input" value={f.priority ?? ''} onChange={(e) => set('priority', e.target.value)}>
                <option value="">همه</option>
                {Object.entries(PRIORITY).map(([k, [l]]) => (
                  <option key={k} value={k}>
                    {l}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="منبع ورود">
              <select className="input" value={f.source ?? ''} onChange={(e) => set('source', e.target.value)}>
                <option value="">همه</option>
                {Object.entries(SOURCE).map(([k, l]) => (
                  <option key={k} value={k}>
                    {l}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="کد رهگیری / بارکد" hint="بارکد را با اسکنر بخوانید و Enter بزنید">
              <input
                className="input ltr"
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
                onKeyDown={async (e) => {
                  if (e.key !== 'Enter' || !code) return;
                  try {
                    const l = await get(`/letters/lookup/${code}`);
                    nav(`/letters/${l.id}`);
                  } catch (err) {
                    setLookupError(err as Error);
                  }
                }}
              />
            </Field>
          </div>
        )}
        <ErrorBox error={lookupError ?? r.error} />
        {r.loading && !r.data ? (
          <Loading />
        ) : !r.data?.items.length ? (
          <Empty>نامه‌ای یافت نشد.</Empty>
        ) : (
          <>
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>شماره</th>
                    <th>نوع</th>
                    <th>موضوع</th>
                    <th>طرف مکاتبه</th>
                    <th>تاریخ</th>
                    <th>واحد</th>
                    <th>وضعیت</th>
                  </tr>
                </thead>
                <tbody>
                  {r.data.items.map((l) => (
                    <tr key={l.id} className="clickable" onClick={() => nav(`/letters/${l.id}`)}>
                      <td className="letter-number">{fa(l.number)}</td>
                      <td>
                        <KindBadge kind={l.kind} />
                      </td>
                      <td>
                        {l.subject}
                        <div className="row gap-sm">
                          {l.priority !== 'normal' && <Pill map={PRIORITY} value={l.priority} />}
                          <ConfBadge level={l.confidentiality} />
                          {Number(l.attachment_count) > 0 && <span className="small muted">📎 {fa(l.attachment_count)}</span>}
                          {l.source !== 'manual' && <span className="small muted">{SOURCE[l.source]}</span>}
                        </div>
                      </td>
                      <td>{l.external_org ?? l.external_party ?? '—'}</td>
                      <td className="small">{dateFa(l.registered_at ?? l.created_at)}</td>
                      <td className="small">{l.owner_unit ?? '—'}</td>
                      <td>
                        <Pill map={STATUS} value={l.status} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pager page={r.data.page} pageSize={r.data.pageSize} total={r.data.total} onPage={setPage} />
          </>
        )}
      </Card>
    </>
  );
}
