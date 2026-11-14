import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Icon } from '../components/icons';
import { useOrg, type Unit } from '../components/pickers';
import { Empty, ErrorBox, Loading, PageHeader, fa } from '../components/ui';
import { useAuth } from '../lib/auth';

export const UNIT_KIND: Record<string, string> = {
  presidency: 'ریاست',
  deputy: 'معاونت',
  department: 'اداره کل / مدیریت',
  office: 'اداره',
  secretariat: 'دبیرخانه',
  committee: 'کمیته',
};

const norm = (s: string) => s.replace(/ي/g, 'ی').replace(/ك/g, 'ک').replace(/‌/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
const initials = (name: string) =>
  name
    .replace(/^(دکتر|مهندس)\s+/, '')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0])
    .join('‌');

const internalLetter = (to: string, label: string) => `/letters/new?kind=internal&to=${to}&toLabel=${encodeURIComponent(label)}`;

/**
 * The organisation chart for everyone: units top-down with their manager and staff, collapsible, searchable and
 * printable. A person or unit opens a new internal letter addressed to them. On a phone the chart becomes an outline.
 */
export function OrgChartPage() {
  const org = useOrg();
  const { can } = useAuth();
  const [q, setQ] = useState('');
  const [staff, setStaff] = useState(true);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [zoom, setZoom] = useState(1);
  const [narrow, setNarrow] = useState(() => window.matchMedia?.('(max-width: 720px)').matches ?? false);
  const scroller = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const m = window.matchMedia?.('(max-width: 720px)');
    if (!m) return;
    const h = () => setNarrow(m.matches);
    m.addEventListener('change', h);
    return () => m.removeEventListener('change', h);
  }, []);

  const active = org.units.filter((u) => u.is_active);
  const children = (parent: string | null) => active.filter((u) => u.parent_id === parent);
  const positionsOf = (id: string) =>
    org.positions.filter((p) => p.unit_id === id).sort((a, b) => Number(b.is_manager) - Number(a.is_manager) || a.title.localeCompare(b.title, 'fa'));

  // Units whose name, positions or people match the search, and their ancestors (kept open).
  const { hits, open } = useMemo(() => {
    const nq = norm(q);
    const hits = new Set<string>();
    const open = new Set<string>();
    if (!nq) return { hits, open };
    for (const u of org.units) {
      const text = [u.name, ...org.positions.filter((p) => p.unit_id === u.id).flatMap((p) => [p.title, ...(p.holders ?? []).map((h) => h.full_name)])].join(
        ' ',
      );
      if (norm(text).includes(nq)) {
        hits.add(u.id);
        for (let p = u.parent_id; p; p = org.units.find((x) => x.id === p)?.parent_id ?? null) open.add(p);
      }
    }
    return { hits, open };
  }, [q, org.units, org.positions]);

  const toggle = (id: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const descendants = (id: string): number => children(id).reduce((n, c) => n + 1 + descendants(c.id), 0);
  const people = new Set(org.positions.flatMap((p) => (p.holders ?? []).map((h) => h.id))).size;

  if (org.error) return <ErrorBox error={org.error} />;
  if (org.loading && !org.data) return <Loading />;
  const nq = norm(q);
  const isHit = (s: string) => !!nq && norm(s).includes(nq);

  const box = (u: Unit) => {
    const pos = positionsOf(u.id);
    const manager = pos.find((p) => p.is_manager);
    const others = pos.filter((p) => p !== manager);
    const kids = children(u.id);
    const shut = collapsed.has(u.id) && !open.has(u.id);
    return (
      <div className={`oc-box ${hits.has(u.id) ? 'hit' : ''} ${nq && !hits.has(u.id) ? 'dim' : ''}`}>
        <div className="oc-head">
          <span className="oc-kind">{UNIT_KIND[u.kind] ?? ''}</span>
          <strong className={isHit(u.name) ? 'mark' : ''}>{u.name}</strong>
        </div>
        {manager ? (
          <div className="oc-manager">
            <span className="oc-avatar" aria-hidden>
              {manager.holders?.[0] ? initials(manager.holders[0].full_name) : '—'}
            </span>
            <span className="oc-person">
              {manager.holders?.length ? (
                manager.holders.map((h) => <Person key={h.id} id={h.id} name={h.full_name} hit={isHit(h.full_name)} canWrite={can('letter.create')} />)
              ) : (
                <span className="muted">خالی</span>
              )}
              <span className={`oc-title ${isHit(manager.title) ? 'mark' : ''}`}>{manager.title}</span>
            </span>
          </div>
        ) : (
          <div className="oc-manager oc-vacant">بدون سمت مدیر</div>
        )}
        {staff && others.length > 0 && (
          <ul className="oc-staff">
            {others.map((p) => (
              <li key={p.id}>
                <span className={`oc-title ${isHit(p.title) ? 'mark' : ''}`}>{p.title}</span>
                <span className="oc-holders">
                  {p.holders?.length ? (
                    p.holders.map((h) => <Person key={h.id} id={h.id} name={h.full_name} hit={isHit(h.full_name)} canWrite={can('letter.create')} />)
                  ) : (
                    <span className="muted">خالی</span>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
        <div className="oc-foot">
          {can('letter.create') && manager && (
            <Link className="oc-link" to={internalLetter(`unit:${u.id}`, u.name)} title={`نامه داخلی به ${u.name}`}>
              <Icon name="pen" size={14} /> نامه به واحد
            </Link>
          )}
          {kids.length > 0 && (
            <button type="button" className="oc-toggle" onClick={() => toggle(u.id)} aria-expanded={!shut}>
              {shut ? `${fa(descendants(u.id))} زیرواحد` : 'بستن زیرواحدها'}
            </button>
          )}
        </div>
      </div>
    );
  };

  const branch = (parent: string | null) => {
    const list = children(parent);
    if (!list.length) return null;
    return (
      <ul>
        {list.map((u) => (
          <li key={u.id}>
            {box(u)}
            {!(collapsed.has(u.id) && !open.has(u.id)) && branch(u.id)}
          </li>
        ))}
      </ul>
    );
  };

  return (
    <>
      <PageHeader title="نمودار سازمانی" subtitle={`${fa(active.length)} واحد، ${fa(org.positions.length)} سمت و ${fa(people)} نفر`} />
      <div className="oc-toolbar no-print">
        <label className="oc-search">
          <Icon name="search" size={16} />
          <input
            className="input"
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="جستجوی نام، سمت یا واحد"
            aria-label="جستجو در نمودار سازمانی"
          />
          {nq && <span className="small muted">{fa(hits.size)} واحد</span>}
        </label>
        <label className="check">
          <input type="checkbox" checked={staff} onChange={(e) => setStaff(e.target.checked)} />
          نمایش کارکنان
        </label>
        <span className="grow" />
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => setCollapsed(new Set())}>
          باز کردن همه
        </button>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => setCollapsed(new Set(active.filter((u) => u.parent_id).map((u) => u.id)))}>
          فقط سطح اول
        </button>
        {!narrow && (
          <div className="seg" role="group" aria-label="بزرگنمایی">
            <button type="button" onClick={() => setZoom((z) => Math.max(0.5, +(z - 0.1).toFixed(2)))} aria-label="کوچک‌نمایی">
              <Icon name="zoomOut" size={16} />
            </button>
            <button type="button" onClick={() => setZoom(1)} aria-label="اندازه واقعی">
              {fa(Math.round(zoom * 100))}٪
            </button>
            <button type="button" onClick={() => setZoom((z) => Math.min(1.5, +(z + 0.1).toFixed(2)))} aria-label="بزرگ‌نمایی">
              <Icon name="zoomIn" size={16} />
            </button>
          </div>
        )}
        <button type="button" className="btn btn-secondary btn-sm" onClick={() => window.print()}>
          <Icon name="printer" size={16} /> چاپ
        </button>
      </div>
      {!active.length ? (
        <Empty>واحدی تعریف نشده است.</Empty>
      ) : (
        <div className={`oc-canvas ${narrow ? 'oc-outline' : ''}`} ref={scroller}>
          <div className="oc-chart" style={narrow ? undefined : { zoom }}>
            {branch(null)}
          </div>
        </div>
      )}
    </>
  );
}

function Person({ id, name, hit, canWrite }: { id: string; name: string; hit: boolean; canWrite: boolean }) {
  if (!canWrite) return <span className={`oc-name ${hit ? 'mark' : ''}`}>{name}</span>;
  return (
    <Link className={`oc-name ${hit ? 'mark' : ''}`} to={internalLetter(`user:${id}`, name)} title={`نامه داخلی به ${name}`}>
      {name}
    </Link>
  );
}
