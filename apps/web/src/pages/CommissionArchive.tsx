import { toGregorian, toJalali } from '@kx/shared';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { DOC_KINDS, DocKind, UploadFiles, ViewButton } from '../components/docs';
import { Button, Card, dateFa, Empty, ErrorBox, fa, Field, JalaliDateInput, Loading, Pager, Stat } from '../components/ui';
import { download } from '../lib/api';
import { useApi } from '../lib/hooks';

// ─────────────────────────────── Document archive ───────────────────────────────

/** Searchable archive of every slide deck, PDF, photo and attachment of the commission's meetings. */
export function CommissionArchive({ commission }: { commission: any }) {
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState('');
  const [page, setPage] = useState(1);
  const params = new URLSearchParams({ commissionId: commission.id, page: String(page), pageSize: '20' });
  if (query) params.set('q', query);
  if (kind) params.set('kind', kind);
  const { data, error, reload } = useApi<any>(`/documents/archive?${params}`, [query, kind, page]);
  const canUpload = commission.capabilities.includes('meeting.manage');
  const counts: Record<string, number> = Object.fromEntries((data?.kinds ?? []).map((k: any) => [k.kind, Number(k.count)]));
  const total = Object.values(counts).reduce((a, b) => a + b, 0);

  return (
    <>
      <Card>
        <form
          className="row gap-sm wrap"
          onSubmit={(e) => {
            e.preventDefault();
            setPage(1);
            setQuery(q.trim());
          }}
        >
          <input className="input" style={{ maxWidth: 320 }} placeholder="جست‌وجو در نام فایل، عنوان جلسه یا دستور جلسه" value={q} onChange={(e) => setQ(e.target.value)} />
          <Button type="submit" variant="secondary">
            جست‌وجو
          </Button>
          <div className="row gap-sm wrap" role="group" aria-label="نوع سند">
            <Button type="button" size="sm" variant={kind === '' ? 'primary' : 'ghost'} onClick={() => (setKind(''), setPage(1))}>
              همه ({fa(total)})
            </Button>
            {Object.entries(DOC_KINDS)
              .filter(([k]) => counts[k])
              .map(([k, v]) => (
                <Button key={k} type="button" size="sm" variant={kind === k ? 'primary' : 'ghost'} onClick={() => (setKind(k), setPage(1))}>
                  {v.label} ({fa(counts[k])})
                </Button>
              ))}
          </div>
        </form>
        {canUpload && (
          <div className="mt">
            <p className="muted small">فایل‌های عمومی کمیسیون (برنامه سالانه، گزارش‌ها، ارائه‌ها) را اینجا بارگذاری کنید. فایل‌های هر جلسه را از صفحه همان جلسه، زبانه «مستندات» اضافه کنید.</p>
            <UploadFiles target={{ commissionId: commission.id }} onDone={() => void reload()} />
          </div>
        )}
      </Card>
      <ErrorBox error={error} />
      {!data ? (
        <Loading />
      ) : data.items.length === 0 ? (
        <Empty>سندی یافت نشد.</Empty>
      ) : (
        <Card>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>نوع</th>
                  <th>فایل</th>
                  <th>جلسه / موضوع</th>
                  <th>بارگذاری</th>
                  <th>حجم</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {data.items.map((d: any) => (
                  <tr key={d.id}>
                    <td>
                      <DocKind kind={d.kind} />
                    </td>
                    <td>
                      <div>{d.title ?? d.file_name}</div>
                      {d.title && <div className="muted small">{d.file_name}</div>}
                    </td>
                    <td className="small">
                      {d.meeting_id ? (
                        <Link to={`/meetings/${d.meeting_id}`}>
                          جلسه {fa(d.meeting_number)} — {dateFa(d.meeting_date)}
                        </Link>
                      ) : d.resolution_number ? (
                        <>مصوبه {fa(d.resolution_number)}</>
                      ) : (
                        <span className="muted">سند کمیسیون</span>
                      )}
                      {d.agenda_title && <div className="muted">{d.agenda_title}</div>}
                    </td>
                    <td className="small">
                      {d.owner_name}
                      <div className="muted">{dateFa(d.created_at)}</div>
                    </td>
                    <td className="small">{fa(d.size_bytes >= 1048576 ? `${(d.size_bytes / 1048576).toFixed(1)} MB` : `${Math.ceil(d.size_bytes / 1024)} KB`)}</td>
                    <td>
                      <ViewButton d={d} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pager page={data.page} pageSize={data.pageSize} total={data.total} onPage={setPage} />
        </Card>
      )}
    </>
  );
}

// ─────────────────────────────── Periodic activity report ───────────────────────────────

const iso = ([y, m, d]: [number, number, number]) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
const fromJalali = (jy: number, jm: number, jd: number) => iso(toGregorian(jy, jm, jd));

/** Jalali period presets: current/previous season, half year, year, and the whole term. */
function presets(termStart?: string) {
  const now = new Date();
  const [jy, jm] = toJalali(now.getFullYear(), now.getMonth() + 1, now.getDate());
  const today = iso([now.getFullYear(), now.getMonth() + 1, now.getDate()]);
  const season = Math.floor((jm - 1) / 3); // 0..3
  const prevSeason = season === 0 ? { y: jy - 1, s: 3 } : { y: jy, s: season - 1 };
  const seasonEnd = (y: number, s: number) => (s === 3 ? fromJalali(y + 1, 1, 1) : fromJalali(y, s * 3 + 4, 1));
  const dayBefore = (d: string) => new Date(new Date(`${d}T12:00:00Z`).getTime() - 864e5).toISOString().slice(0, 10);
  const SEASONS = ['بهار', 'تابستان', 'پاییز', 'زمستان'];
  const list = [
    { id: 'season', label: `${SEASONS[season]} ${fa(jy)}`, from: fromJalali(jy, season * 3 + 1, 1), to: today },
    { id: 'prev-season', label: `${SEASONS[prevSeason.s]} ${fa(prevSeason.y)}`, from: fromJalali(prevSeason.y, prevSeason.s * 3 + 1, 1), to: dayBefore(seasonEnd(prevSeason.y, prevSeason.s)) },
    { id: 'half', label: jm <= 6 ? `نیمه اول ${fa(jy)}` : `نیمه دوم ${fa(jy)}`, from: fromJalali(jy, jm <= 6 ? 1 : 7, 1), to: today },
    { id: 'year', label: `سال ${fa(jy)}`, from: fromJalali(jy, 1, 1), to: today },
    { id: 'last-year', label: `سال ${fa(jy - 1)}`, from: fromJalali(jy - 1, 1, 1), to: dayBefore(fromJalali(jy, 1, 1)) },
  ];
  if (termStart) list.push({ id: 'term', label: 'کل دوره فعالیت', from: termStart.slice(0, 10), to: today });
  return list;
}

export function ActivityReport({ commission }: { commission: any }) {
  const options = presets(commission.term?.start_date);
  const [preset, setPreset] = useState(options[0].id);
  const [custom, setCustom] = useState({ from: options[0].from, to: options[0].to });
  const range = preset === 'custom' ? custom : options.find((o) => o.id === preset)!;
  const qs = `commissionId=${commission.id}&from=${range.from}&to=${range.to}`;
  const { data, error } = useApi<any>(range.from && range.to ? `/reports/commission-activity?${qs}` : null, [qs]);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<Error | null>(null);
  const get = async (format: 'docx' | 'pptx') => {
    setBusy(format);
    setErr(null);
    try {
      await download(`/reports/commission-activity?${qs}&format=${format}`, `activity.${format}`);
    } catch (e) {
      setErr(e as Error);
    } finally {
      setBusy(null);
    }
  };
  const s = data?.summary;
  return (
    <>
      <Card title="بازه گزارش">
        <div className="row gap-sm wrap mb" role="group" aria-label="بازه">
          {options.map((o) => (
            <Button key={o.id} size="sm" variant={preset === o.id ? 'primary' : 'ghost'} onClick={() => setPreset(o.id)}>
              {o.label}
            </Button>
          ))}
          <Button size="sm" variant={preset === 'custom' ? 'primary' : 'ghost'} onClick={() => setPreset('custom')}>
            بازه دلخواه
          </Button>
        </div>
        {preset === 'custom' && (
          <div className="grid grid-2">
            <Field label="از تاریخ">
              <JalaliDateInput value={custom.from} onChange={(from) => setCustom((c) => ({ ...c, from }))} />
            </Field>
            <Field label="تا تاریخ">
              <JalaliDateInput value={custom.to} onChange={(to) => setCustom((c) => ({ ...c, to }))} />
            </Field>
          </div>
        )}
        <p className="muted small">
          از {dateFa(range.from)} تا {dateFa(range.to)}.{' '}
          گزارش شامل خلاصه عملکرد، فهرست جلسات، موضوعات و تصمیمات، حضور و غیاب اعضا و وضعیت پیگیری مصوبات است.
        </p>
      </Card>
      <ErrorBox error={error ?? err} />
      {!data ? (
        !error && <Loading />
      ) : (
        <>
          <div className="grid grid-3 mb mt">
            <Stat label="جلسات برگزارشده" value={fa(s.held)} hint={s.cancelled ? `${fa(s.cancelled)} جلسه لغو شد` : undefined} />
            <Stat label="میانگین حضور" value={`${fa(s.attendanceRate)}٪`} />
            <Stat label="موضوعات بررسی‌شده" value={fa(s.agendaItems)} />
            <Stat label="مصوبات دوره" value={fa(s.resolutions)} />
            <Stat label="انجام‌شده" value={fa(s.done)} tone="success" />
            <Stat label="معوق" value={fa(s.overdue)} tone={s.overdue ? 'danger' : undefined} />
          </div>
          <Card title="دریافت فایل گزارش">
            <div className="row gap wrap">
              <Button busy={busy === 'docx'} onClick={() => get('docx')}>
                گزارش کامل (Word)
              </Button>
              <Button busy={busy === 'pptx'} variant="secondary" onClick={() => get('pptx')}>
                فایل ارائه (PowerPoint)
              </Button>
            </div>
            <p className="muted small mt">
              فایل Word برای ارسال رسمی و بایگانی است. فایل PowerPoint با نمودار وضعیت مصوبات و درصد حضور برای ارائه در جلسه هیئت‌رئیسه یا مجمع آماده شده است.
            </p>
          </Card>
        </>
      )}
    </>
  );
}
