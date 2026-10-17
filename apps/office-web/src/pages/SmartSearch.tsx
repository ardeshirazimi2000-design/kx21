import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ConfBadge, KIND, KindBadge, Pill, STATUS } from '../components/labels';
import { Badge, Button, Card, Empty, ErrorBox, Field, JalaliDateInput, Loading, PageHeader, Pager, dateFa, fa } from '../components/ui';
import { post } from '../lib/api';
import { useAction, useApi } from '../lib/hooks';

interface Hit {
  id: string;
  kind: string;
  number: string | null;
  subject: string;
  status: string;
  confidentiality: number;
  registered_at: string | null;
  created_at: string;
  external_org: string | null;
  external_party: string | null;
  owner_unit: string | null;
  relevance: number;
  matched: string[];
  snippet: { text: string; hit: boolean }[];
}
interface Result {
  items: Hit[];
  total: number;
  page: number;
  pageSize: number;
  keywords: string[];
  expanded: string[];
  ai: { enabled: boolean; expanded: boolean; reranked: boolean; canSummarize: boolean };
}

const REASON: Record<string, string> = { thread: 'پیرو / عطف', meeting: 'همان جلسه یا مصوبه', subject: 'موضوع مشابه' };

/** «جستجوی هوشمند»: letters on a topic ranked by relevance, related keywords, related letters and an AI summary. */
export function SmartSearchPage() {
  const [sp, setSp] = useSearchParams();
  const q = sp.get('q') ?? '';
  const [text, setText] = useState(q);
  const [kind, setKind] = useState(sp.get('kind') ?? '');
  const [from, setFrom] = useState(sp.get('from') ?? '');
  const [to, setTo] = useState(sp.get('to') ?? '');
  const [page, setPage] = useState(1);
  useEffect(() => setText(q), [q]);
  useEffect(() => setPage(1), [q, kind, from, to]);
  const qs =
    q.trim().length >= 2 ? `q=${encodeURIComponent(q)}&page=${page}${kind ? `&kind=${kind}` : ''}${from ? `&from=${from}` : ''}${to ? `&to=${to}` : ''}` : null;
  const r = useApi<Result>(qs ? `/search?${qs}` : null, [qs]);

  const run = (value = text) => {
    const v = value.trim();
    const next = new URLSearchParams();
    if (v) next.set('q', v);
    if (kind) next.set('kind', kind);
    if (from) next.set('from', from);
    if (to) next.set('to', to);
    setSp(next);
  };

  return (
    <>
      <PageHeader title="جستجوی هوشمند" subtitle="نامه‌های مربوط به یک موضوع، به ترتیب ارتباط، همراه با کلیدواژه‌ها و نامه‌های وابسته" />
      <Card>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            run();
          }}
        >
          <div className="row gap wrap" style={{ alignItems: 'flex-end' }}>
            <div className="grow" style={{ minWidth: 260 }}>
              <Field label="موضوع">
                <input
                  className="input smart-q"
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  placeholder="مثلاً: مشوق‌های صادرات فرش دستباف"
                  autoFocus
                />
              </Field>
            </div>
            <Field label="نوع نامه">
              <select className="input" value={kind} onChange={(e) => setKind(e.target.value)}>
                <option value="">همه</option>
                {Object.entries(KIND).map(([k, l]) => (
                  <option key={k} value={k}>
                    {l}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="از تاریخ">
              <JalaliDateInput value={from} onChange={setFrom} />
            </Field>
            <Field label="تا تاریخ">
              <JalaliDateInput value={to} onChange={setTo} />
            </Field>
            <Button type="submit">جستجو</Button>
          </div>
        </form>
      </Card>

      {!qs ? (
        <Card className="mt">
          <Empty>موضوعی بنویسید؛ نامه‌هایی که بیشترین ارتباط را با آن دارند نمایش داده می‌شوند، حتی اگر همه واژه‌ها یا عین عبارت در آنها نیامده باشد.</Empty>
        </Card>
      ) : (
        <Results r={r} q={q} onRefine={(k) => run(`${q} ${k}`)} onPage={setPage} />
      )}
    </>
  );
}

function Results({ r, q, onRefine, onPage }: { r: ReturnType<typeof useApi<Result>>; q: string; onRefine: (k: string) => void; onPage: (p: number) => void }) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState<string | null>(null);
  const summary = useAction();
  const [answer, setAnswer] = useState<{ summary: string; letters: { ref: number; id: string; number: string | null; subject: string }[] } | null>(null);
  const data = r.data;
  // A fresh result set preselects its five most relevant unclassified letters for the summary.
  useEffect(() => {
    setAnswer(null);
    setSelected(
      new Set(
        (data?.items ?? [])
          .filter((x) => x.confidentiality === 0)
          .slice(0, 5)
          .map((x) => x.id),
      ),
    );
  }, [data]);
  if (r.error) return <ErrorBox error={r.error} />;
  if (!data) return <Loading />;

  return (
    <div className="smart-layout mt">
      <div>
        <div className="row between wrap mb">
          <span className="muted">{data.total ? `${fa(data.total)} نامه مرتبط${data.total >= 100 ? ' (۱۰۰ نامه نخست)' : ''}` : 'نامه مرتبطی یافت نشد.'}</span>
          {data.ai.enabled && (
            <span className="row gap-sm">
              {data.ai.expanded && <Badge tone="accent">موضوع با هوش مصنوعی گسترش یافت</Badge>}
              {data.ai.reranked && <Badge tone="accent">رتبه‌بندی معنایی</Badge>}
            </span>
          )}
        </div>
        {data.items.map((h) => (
          <Card key={h.id} className="smart-hit">
            <div className="row between gap wrap">
              <div className="row gap-sm wrap">
                {data.ai.canSummarize && h.confidentiality === 0 && (
                  <input
                    type="checkbox"
                    aria-label="برای خلاصه هوشمند"
                    checked={selected.has(h.id)}
                    onChange={() =>
                      setSelected((s) => {
                        const n = new Set(s);
                        if (n.has(h.id)) n.delete(h.id);
                        else if (n.size < 12) n.add(h.id);
                        return n;
                      })
                    }
                  />
                )}
                <KindBadge kind={h.kind} />
                <Link to={`/letters/${h.id}`} className="smart-title">
                  {h.subject}
                </Link>
              </div>
              <div className="smart-relevance" title={`میزان ارتباط ${fa(h.relevance)}٪`}>
                <span style={{ width: `${h.relevance}%` }} />
              </div>
            </div>
            <div className="small muted row gap-sm wrap">
              <span className="letter-number">{h.number ? fa(h.number) : 'پیش‌نویس'}</span>
              <span>{dateFa(h.registered_at ?? h.created_at)}</span>
              {(h.external_org || h.external_party) && <span>{[h.external_org, h.external_party].filter(Boolean).join(' — ')}</span>}
              {h.owner_unit && <span>{h.owner_unit}</span>}
              <Pill map={STATUS} value={h.status} />
              <ConfBadge level={h.confidentiality} />
            </div>
            {h.snippet.length > 0 && (
              <p className="smart-snippet">{h.snippet.map((s, i) => (s.hit ? <mark key={i}>{s.text}</mark> : <span key={i}>{s.text}</span>))}</p>
            )}
            <div className="row between wrap gap-sm">
              <span className="row gap-sm wrap">
                {h.matched.map((m) => (
                  <span key={m} className="chip">
                    {m}
                  </span>
                ))}
              </span>
              <Button size="sm" variant="ghost" onClick={() => setOpen(open === h.id ? null : h.id)}>
                {open === h.id ? 'بستن نامه‌های مرتبط' : 'نامه‌های مرتبط'}
              </Button>
            </div>
            {open === h.id && <RelatedLetters letterId={h.id} />}
          </Card>
        ))}
        {data.total > data.pageSize && <Pager page={data.page} pageSize={data.pageSize} total={Math.min(data.total, 100)} onPage={onPage} />}
      </div>

      <aside>
        {data.keywords.length > 0 && (
          <Card title="کلیدواژه‌های مرتبط">
            <p className="small muted">برای محدودتر کردن نتایج، روی یک کلیدواژه بزنید.</p>
            <div className="row gap-sm wrap">
              {data.keywords.map((k) => (
                <button key={k} type="button" className="chip chip-btn" onClick={() => onRefine(k)}>
                  {k}
                </button>
              ))}
            </div>
          </Card>
        )}
        {data.expanded.length > 0 && (
          <Card title="واژه‌های هم‌معنی (هوش مصنوعی)" className="mt">
            <div className="row gap-sm wrap">
              {data.expanded.map((k) => (
                <span key={k} className="chip">
                  {k}
                </span>
              ))}
            </div>
          </Card>
        )}
        {data.ai.canSummarize && data.items.length > 0 && (
          <Card title="خلاصه هوشمند" className="mt">
            <p className="small muted">نامه‌های علامت‌خورده (حداکثر ۱۲، بدون نامه‌های طبقه‌بندی‌شده) خلاصه می‌شوند.</p>
            <Button
              size="sm"
              busy={summary.busy}
              disabled={!selected.size}
              onClick={() => void summary.run(async () => setAnswer(await post('/search/summary', { q, letterIds: [...selected] })))}
            >
              خلاصه {fa(selected.size)} نامه
            </Button>
            <ErrorBox error={summary.error} />
            {answer && (
              <div className="mt">
                <p className="smart-summary">{answer.summary}</p>
                <ol className="small">
                  {answer.letters.map((l) => (
                    <li key={l.id}>
                      <Link to={`/letters/${l.id}`}>{l.number ? fa(l.number) : l.subject}</Link>
                    </li>
                  ))}
                </ol>
                <p className="small muted">این خلاصه را هوش مصنوعی نوشته است؛ پیش از استناد، نامه‌ها را ببینید.</p>
              </div>
            )}
          </Card>
        )}
      </aside>
    </div>
  );
}

/** Letters linked to one letter (reply chain, same meeting) and letters on the same subject. */
export function RelatedLetters({ letterId }: { letterId: string }) {
  const r = useApi<any[]>(`/letters/${letterId}/related`, [letterId]);
  if (r.error) return <ErrorBox error={r.error} />;
  if (!r.data) return <Loading />;
  if (!r.data.length) return <Empty>نامه مرتبطی یافت نشد.</Empty>;
  return (
    <ul className="list related-list">
      {r.data.map((l) => (
        <li key={l.id} className="row between gap wrap">
          <span className="row gap-sm wrap">
            <KindBadge kind={l.kind} />
            <Link to={`/letters/${l.id}`}>{l.subject}</Link>
            <span className="small muted letter-number">{l.number ? fa(l.number) : 'پیش‌نویس'}</span>
            <span className="small muted">{dateFa(l.registered_at ?? l.created_at)}</span>
          </span>
          <span className="row gap-sm">
            {l.reasons.map((x: string) => (
              <Badge key={x} tone={x === 'subject' ? 'info' : 'accent'}>
                {REASON[x] ?? x}
                {x === 'subject' && l.similarity !== null ? ` ${fa(l.similarity)}٪` : ''}
              </Badge>
            ))}
          </span>
        </li>
      ))}
    </ul>
  );
}
