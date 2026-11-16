import { useState } from 'react';
import { Icon } from '../components/icons';
import { Badge, Button, Card, Empty, ErrorBox, Loading, PageHeader, Pager, Tabs, dateTimeFa, fa, type Tone } from '../components/ui';
import { useAuth } from '../lib/auth';
import { useApi } from '../lib/hooks';
import { useRealtime } from '../lib/realtime';
import { useClickToCall } from '../lib/telephony';
import '../communications.css';

interface Call {
  id: string;
  direction: 'internal' | 'inbound' | 'outbound';
  caller_number: string | null;
  caller_name: string | null;
  callee_number: string | null;
  caller_user_id: string | null;
  callee_user_id: string | null;
  caller_user_name: string | null;
  callee_user_name: string | null;
  started_at: string;
  answered_at: string | null;
  ended_at: string | null;
  disposition: 'answered' | 'missed' | 'busy' | 'failed' | null;
  duration_seconds: number | null;
}

const DISPOSITION: Record<NonNullable<Call['disposition']>, [string, Tone]> = {
  answered: ['پاسخ داده شد', 'success'],
  missed: ['بی‌پاسخ', 'warning'],
  busy: ['اشغال', 'neutral'],
  failed: ['برقرار نشد', 'danger'],
};
const DIRECTION: Record<Call['direction'], string> = { internal: 'داخلی', inbound: 'ورودی (خط شهری)', outbound: 'خروجی (خط شهری)' };

const duration = (s: number | null) => {
  if (!s) return '—';
  const m = Math.floor(s / 60);
  return m ? `${fa(m)}:${fa(String(s % 60).padStart(2, '0'))}` : `${fa(s)} ثانیه`;
};

/** «تماس‌ها»: one's own call history (internal and city line); everyone's for holders of communications.report.view. */
export function CommCallsPage() {
  const { me, can } = useAuth();
  const [scope, setScope] = useState<'mine' | 'all'>('mine');
  const [direction, setDirection] = useState('');
  const [disposition, setDisposition] = useState('');
  const [page, setPage] = useState(1);
  const r = useApi<{ items: Call[]; total: number; page: number; pageSize: number }>(
    `/communications/calls?scope=${scope}&direction=${direction}&disposition=${disposition}&page=${page}`,
    [scope, direction, disposition, page],
  );
  const c2c = useClickToCall();
  useRealtime({ CallEnded: () => void r.reload(), CallMissed: () => void r.reload() });

  /** The other party, from the viewer's side; and the number to call back (city numbers get the 9 prefix). */
  const other = (c: Call) => {
    const outgoing = scope === 'mine' ? c.caller_user_id === me!.id : true;
    if (scope === 'all')
      return { label: `${c.caller_user_name ?? fa(c.caller_number) ?? '—'} ← ${c.callee_user_name ?? fa(c.callee_number) ?? '—'}`, dial: null, outgoing };
    const name = outgoing ? c.callee_user_name : (c.caller_user_name ?? c.caller_name);
    const num = outgoing ? c.callee_number : c.caller_number;
    const city = (outgoing && c.direction === 'outbound') || (!outgoing && c.direction === 'inbound');
    return { label: name ? `${name} (${fa(num)})` : num ? fa(num) : 'شماره نامشخص', dial: num ? (city ? `9${num}` : num) : null, outgoing };
  };

  return (
    <>
      <PageHeader title="تماس‌ها" subtitle="تماس‌های داخلی و خط شهری؛ صدای تماس ضبط و نگهداری نمی‌شود" />
      {c2c.status && !c2c.status.pbx.configured && <div className="alert alert-info mb">مرکز تلفن هنوز به رسا متصل نشده است.</div>}
      {c2c.status?.pbx.configured && !c2c.status.pbx.connected && (
        <div className="alert alert-warning mb" role="status">
          ارتباط رسا با مرکز تلفن قطع است؛ تماس‌ها برقرار می‌شوند ولی تا وصل شدن دوباره در این فهرست ثبت نمی‌شوند.
        </div>
      )}
      {c2c.notice && (
        <div className={`alert alert-${c2c.notice.tone} mb`} role="status">
          {c2c.notice.text}
        </div>
      )}
      <Card>
        {can('communications.report.view') && (
          <Tabs
            tabs={[
              { id: 'mine', label: 'تماس‌های من' },
              { id: 'all', label: 'همه تماس‌ها' },
            ]}
            value={scope}
            onChange={(v) => {
              setScope(v);
              setPage(1);
            }}
          />
        )}
        <div className="dir-filters calls-filters">
          <select className="input" value={direction} onChange={(e) => (setDirection(e.target.value), setPage(1))} aria-label="نوع تماس">
            <option value="">همه انواع</option>
            {Object.entries(DIRECTION).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
          <select className="input" value={disposition} onChange={(e) => (setDisposition(e.target.value), setPage(1))} aria-label="نتیجه تماس">
            <option value="">همه نتیجه‌ها</option>
            {Object.entries(DISPOSITION).map(([k, [v]]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </div>
        <ErrorBox error={r.error} />
        {r.loading && !r.data ? (
          <Loading />
        ) : !r.data?.items.length ? (
          <Empty>تماسی ثبت نشده است.</Empty>
        ) : (
          <ul className="call-list">
            {r.data.items.map((c) => {
              const o = other(c);
              const [label, tone] = c.disposition ? DISPOSITION[c.disposition] : ['در جریان', 'info' as Tone];
              return (
                <li key={c.id} className="call-row">
                  <span className={`call-dir ${o.outgoing ? 'out' : 'in'}`} title={o.outgoing ? 'تماس گرفته شده' : 'تماس دریافتی'}>
                    <Icon name="phone" size={16} />
                    <span className="small">{o.outgoing ? 'خروجی' : 'ورودی'}</span>
                  </span>
                  <span className="call-who">
                    <strong>{o.label}</strong>
                    <span className="small muted">{DIRECTION[c.direction]}</span>
                  </span>
                  <span className="call-when small">
                    {dateTimeFa(c.started_at)}
                    <span className="muted">{duration(c.duration_seconds)}</span>
                  </span>
                  <Badge tone={tone}>{label}</Badge>
                  <span>
                    {o.dial && c2c.ready && (
                      <Button size="sm" variant="secondary" onClick={() => c2c.call(o.dial!, o.label)} disabled={c2c.busy}>
                        تماس دوباره
                      </Button>
                    )}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
        {r.data && <Pager page={r.data.page} pageSize={r.data.pageSize} total={r.data.total} onPage={setPage} />}
      </Card>
    </>
  );
}
