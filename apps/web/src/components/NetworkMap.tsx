import { useMemo, useState, type KeyboardEvent } from 'react';
import { fa } from './ui';

/**
 * Network maps drawn as SVG: a radial layout with the hub in the middle, the first ring around it and
 * the outer ring linked to the first. Every node is clickable (and reachable with the keyboard).
 */

const W = 900;
const H = 640;
const CX = W / 2;
const CY = H / 2;

const polar = (r: number, a: number) => ({ x: CX + r * Math.cos(a), y: CY + r * Math.sin(a) });
const TOP = -Math.PI / 2;

/** Splits a label into at most two lines of about `max` characters. */
function lines(text: string, max = 16): string[] {
  const words = text.split(/\s+/);
  const out: string[] = [''];
  for (const w of words) {
    const cur = out[out.length - 1];
    if (cur && (cur + ' ' + w).length > max) {
      if (out.length === 2) {
        out[1] = `${out[1]}…`;
        break;
      }
      out.push(w);
    } else out[out.length - 1] = cur ? `${cur} ${w}` : w;
  }
  return out;
}

function Label({ x, y, text, max, bold, small, center }: { x: number; y: number; text: string; max?: number; bold?: boolean; small?: boolean; center?: boolean }) {
  const ls = lines(text, max);
  const gap = small ? 13 : 15;
  // Centered labels sit in the middle of their node whether they take one line or two.
  const y0 = center ? y + (small ? 4 : 5) - ((ls.length - 1) * gap) / 2 : y;
  return (
    <text x={x} y={y0} textAnchor="middle" className={`nm-label ${bold ? 'nm-bold' : ''} ${small ? 'nm-small' : ''}`}>
      {ls.map((l, i) => (
        <tspan key={i} x={x} dy={i === 0 ? 0 : gap}>
          {l}
        </tspan>
      ))}
    </text>
  );
}

const onKey = (fn: () => void) => (e: KeyboardEvent) => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    fn();
  }
};

/** Circular mean of angles (radians). */
const meanAngle = (as: number[]) => Math.atan2(as.reduce((s, a) => s + Math.sin(a), 0), as.reduce((s, a) => s + Math.cos(a), 0));

/** Orders items around a ring by the angle of what they connect to, to limit crossing lines. */
function ringOrder<T extends { id: string }>(items: T[], anchors: (item: T) => number[]): Map<string, number> {
  const scored = items.map((it) => {
    const as = anchors(it);
    const m = as.length ? meanAngle(as) : 0;
    return { id: it.id, m: (m - TOP + 4 * Math.PI) % (2 * Math.PI) };
  });
  scored.sort((a, b) => a.m - b.m);
  const step = (2 * Math.PI) / Math.max(1, scored.length);
  const offset = scored.length ? scored[0].m : 0;
  return new Map(scored.map((s, i) => [s.id, TOP + offset + i * step]));
}

// ─────────────────────────────── All networks ───────────────────────────────

export interface NetworksMapData {
  networks: { id: string; name: string; status: string; shared_count: number; proposal_count: number }[];
  chambers: { id: string; name: string; province: string; mine: boolean }[];
  links: { network_id: string; chamber_id: string; commissions: number }[];
}

/** اتاق ایران in the middle, networks around it, and the provincial chambers taking part in each. */
export function NetworksMap({ data, onNetwork, onChamber }: { data: NetworksMapData; onNetwork: (id: string) => void; onChamber?: (id: string) => void }) {
  const [focus, setFocus] = useState<string | null>(null);
  const layout = useMemo(() => {
    const step = (2 * Math.PI) / Math.max(1, data.networks.length);
    const netAngle = new Map(data.networks.map((n, i) => [n.id, TOP + i * step]));
    const chAngle = ringOrder(data.chambers, (c) => data.links.filter((l) => l.chamber_id === c.id).map((l) => netAngle.get(l.network_id)!));
    const r1 = data.networks.length === 1 ? 0 : 150;
    return {
      net: new Map(data.networks.map((n) => [n.id, polar(r1, netAngle.get(n.id)!)])),
      ch: new Map(data.chambers.map((c) => [c.id, polar(265, chAngle.get(c.id)!)])),
      single: data.networks.length === 1,
    };
  }, [data]);
  const related = (l: { network_id: string; chamber_id: string }) => !focus || focus === l.network_id || focus === l.chamber_id;

  return (
    <svg className="nm" viewBox={`0 0 ${W} ${H}`} role="group" aria-label="نقشه شبکه‌های کمیسیون‌ها">
      {/* Hub → networks */}
      {!layout.single &&
        data.networks.map((n) => {
          const p = layout.net.get(n.id)!;
          return <line key={n.id} x1={CX} y1={CY} x2={p.x} y2={p.y} className={`nm-edge nm-edge-hub ${focus && focus !== n.id ? 'nm-dim' : ''}`} />;
        })}
      {/* Networks → chambers */}
      {data.links.map((l) => {
        const a = layout.net.get(l.network_id)!;
        const b = layout.ch.get(l.chamber_id)!;
        return (
          <line
            key={`${l.network_id}-${l.chamber_id}`}
            x1={a.x}
            y1={a.y}
            x2={b.x}
            y2={b.y}
            strokeWidth={1.5 + l.commissions}
            className={`nm-edge ${related(l) ? (focus ? 'nm-hot' : '') : 'nm-dim'}`}
          />
        );
      })}
      {!layout.single && (
        <g className="nm-node nm-hub">
          <circle cx={CX} cy={CY} r={38} />
          <Label x={CX} y={CY - 2} text="اتاق ایران" bold max={10} />
          <text x={CX} y={CY + 16} textAnchor="middle" className="nm-sub">
            {fa(data.networks.length)} شبکه
          </text>
        </g>
      )}
      {data.networks.map((n) => {
        const p = layout.net.get(n.id)!;
        return (
          <g
            key={n.id}
            className={`nm-node nm-network nm-click ${focus && focus !== n.id && !data.links.some((l) => l.network_id === n.id && l.chamber_id === focus) ? 'nm-dim' : ''}`}
            role="link"
            tabIndex={0}
            aria-label={`${n.name} — ورود به شبکه`}
            onClick={() => onNetwork(n.id)}
            onKeyDown={onKey(() => onNetwork(n.id))}
            onMouseEnter={() => setFocus(n.id)}
            onMouseLeave={() => setFocus(null)}
            onFocus={() => setFocus(n.id)}
            onBlur={() => setFocus(null)}
          >
            <title>{`${n.name}\n${fa(n.shared_count)} مصوبه مشترک، ${fa(n.proposal_count)} پیشنهاد ملی`}</title>
            <circle cx={p.x} cy={p.y} r={30} />
            <text x={p.x} y={p.y + 5} textAnchor="middle" className="nm-count">
              {fa(data.links.filter((l) => l.network_id === n.id).length)}
            </text>
            <Label x={p.x} y={p.y + 48} text={n.name} bold max={18} />
          </g>
        );
      })}
      {data.chambers.map((c) => {
        const p = layout.ch.get(c.id)!;
        const nets = data.links.filter((l) => l.chamber_id === c.id);
        const click = onChamber ? () => onChamber(c.id) : () => setFocus(focus === c.id ? null : c.id);
        return (
          <g
            key={c.id}
            className={`nm-node nm-chamber nm-click ${c.mine ? 'nm-mine' : ''} ${focus && focus !== c.id && !nets.some((l) => l.network_id === focus) ? 'nm-dim' : ''}`}
            role={onChamber ? 'link' : 'button'}
            tabIndex={0}
            aria-label={`${c.name} — ${fa(nets.length)} شبکه`}
            onClick={click}
            onKeyDown={onKey(click)}
            onMouseEnter={() => setFocus(c.id)}
            onMouseLeave={() => setFocus(null)}
          >
            <title>{`${c.name}\nعضو ${fa(nets.length)} شبکه`}</title>
            <circle cx={p.x} cy={p.y} r={20} />
            <Label x={p.x} y={p.y + 36} text={c.province} max={14} />
          </g>
        );
      })}
    </svg>
  );
}

// ─────────────────────────────── One network ───────────────────────────────

export interface NetworkMapCommission {
  id: string;
  name: string;
  chamber_id: string;
  chamber_name: string;
  province: string;
  shared_count: number | string;
  can_open: boolean;
}

/** The network in the middle, its provinces around it and each province's commissions; arrows show support. */
export function NetworkMap({
  name,
  commissions,
  links,
  onCenter,
  onChamber,
  onCommission,
}: {
  name: string;
  commissions: NetworkMapCommission[];
  links: { source: string; target: string; count: number }[];
  onCenter: () => void;
  onChamber: (chamberId: string) => void;
  onCommission: (c: NetworkMapCommission) => void;
}) {
  const [focus, setFocus] = useState<string | null>(null);
  const layout = useMemo(() => {
    const chambers = [...new Map(commissions.map((c) => [c.chamber_id, { id: c.chamber_id, name: c.chamber_name, province: c.province }])).values()];
    const step = (2 * Math.PI) / Math.max(1, chambers.length);
    const chPos = new Map<string, { x: number; y: number }>();
    const kPos = new Map<string, { x: number; y: number }>();
    chambers.forEach((ch, i) => {
      const a = TOP + i * step;
      chPos.set(ch.id, polar(150, a));
      const ks = commissions.filter((c) => c.chamber_id === ch.id);
      // Commissions fan out in the chamber's sector of the outer ring.
      const spread = Math.min(step * 0.7, 0.32 * (ks.length - 1));
      ks.forEach((k, j) => kPos.set(k.id, polar(275, a - spread / 2 + (ks.length > 1 ? (spread * j) / (ks.length - 1) : 0))));
    });
    return { chambers, chPos, kPos };
  }, [commissions]);
  const hot = (id: string) => !focus || focus === id || links.some((l) => (l.source === focus && l.target === id) || (l.target === focus && l.source === id));

  return (
    <svg className="nm" viewBox={`0 0 ${W} ${H}`} role="group" aria-label={`نقشه ${name}`}>
      <defs>
        <marker id="nm-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M0 0L10 5L0 10z" className="nm-arrow" />
        </marker>
      </defs>
      {layout.chambers.map((ch) => {
        const p = layout.chPos.get(ch.id)!;
        return <line key={ch.id} x1={CX} y1={CY} x2={p.x} y2={p.y} className="nm-edge nm-edge-hub" />;
      })}
      {commissions.map((k) => {
        const a = layout.chPos.get(k.chamber_id)!;
        const b = layout.kPos.get(k.id)!;
        return <line key={k.id} x1={a.x} y1={a.y} x2={b.x} y2={b.y} className={`nm-edge ${hot(k.id) ? '' : 'nm-dim'}`} />;
      })}
      {/* Support: supporter → originating commission, curved through the inside of the ring. */}
      {links.map((l) => {
        const a = layout.kPos.get(l.source);
        const b = layout.kPos.get(l.target);
        if (!a || !b) return null;
        const mx = CX + ((a.x + b.x) / 2 - CX) * 0.25;
        const my = CY + ((a.y + b.y) / 2 - CY) * 0.25;
        const shrink = (p: { x: number; y: number }, q: { x: number; y: number }) => {
          const d = Math.hypot(q.x - p.x, q.y - p.y) || 1;
          return { x: p.x + ((q.x - p.x) * 24) / d, y: p.y + ((q.y - p.y) * 24) / d };
        };
        const s = shrink(a, { x: mx, y: my });
        const t = shrink(b, { x: mx, y: my });
        const on = !focus || focus === l.source || focus === l.target;
        return (
          <path
            key={`${l.source}-${l.target}`}
            d={`M${s.x},${s.y} Q${mx},${my} ${t.x},${t.y}`}
            strokeWidth={1.5 + l.count}
            markerEnd="url(#nm-arrow)"
            className={`nm-support ${on ? '' : 'nm-dim'}`}
          >
            <title>{`${fa(l.count)} حمایت`}</title>
          </path>
        );
      })}
      <g className="nm-node nm-hub nm-click" role="link" tabIndex={0} aria-label={`${name} — مصوبات مشترک`} onClick={onCenter} onKeyDown={onKey(onCenter)}>
        <circle cx={CX} cy={CY} r={46} />
        <Label x={CX} y={CY - 4} text={name} bold max={12} />
      </g>
      {layout.chambers.map((ch) => {
        const p = layout.chPos.get(ch.id)!;
        return (
          <g key={ch.id} className="nm-node nm-chamber nm-click" role="link" tabIndex={0} aria-label={`${ch.name} — کمیسیون‌های عضو`} onClick={() => onChamber(ch.id)} onKeyDown={onKey(() => onChamber(ch.id))}>
            <title>{ch.name}</title>
            <circle cx={p.x} cy={p.y} r={28} />
            <Label x={p.x} y={p.y} text={ch.province} max={8} bold small center />
          </g>
        );
      })}
      {commissions.map((k) => {
        const p = layout.kPos.get(k.id)!;
        const out = p.y >= CY ? 40 : -34;
        return (
          <g
            key={k.id}
            className={`nm-node nm-commission nm-click ${k.can_open ? 'nm-mine' : ''} ${hot(k.id) ? '' : 'nm-dim'}`}
            role="link"
            tabIndex={0}
            aria-label={`${k.name} (${k.chamber_name})${k.can_open ? ' — ورود به کمیسیون' : ' — مصوبات منتشرشده'}`}
            onClick={() => onCommission(k)}
            onKeyDown={onKey(() => onCommission(k))}
            onMouseEnter={() => setFocus(k.id)}
            onMouseLeave={() => setFocus(null)}
            onFocus={() => setFocus(k.id)}
            onBlur={() => setFocus(null)}
          >
            <title>{`${k.name}\n${k.chamber_name}\n${fa(k.shared_count)} مصوبه منتشرشده`}</title>
            <circle cx={p.x} cy={p.y} r={18} />
            <text x={p.x} y={p.y + 5} textAnchor="middle" className="nm-count">
              {fa(k.shared_count)}
            </text>
            <Label x={p.x} y={p.y + out} text={k.name.replace(/^کمیسیون\s+/, '')} max={18} />
          </g>
        );
      })}
    </svg>
  );
}
