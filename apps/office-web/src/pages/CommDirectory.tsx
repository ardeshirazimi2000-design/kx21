import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Icon } from '../components/icons';
import { UnitSelect } from '../components/pickers';
import { Badge, Button, Card, Empty, ErrorBox, Loading, PageHeader, fa } from '../components/ui';
import { post } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useAction, useApi } from '../lib/hooks';
import { useRealtime } from '../lib/realtime';
import { useClickToCall } from '../lib/telephony';
import '../communications.css';

interface Person {
  id: string;
  full_name: string;
  position_title: string | null;
  unit_id: string | null;
  unit_name: string | null;
  extensions: { number: string; label: string | null; status: string }[];
  online: boolean;
}

/** Online/offline shown with text and a mark, not by colour alone. */
export function Presence({ online }: { online: boolean }) {
  return (
    <span className={`presence ${online ? 'presence-on' : ''}`}>
      <span className="presence-dot" aria-hidden />
      {online ? 'برخط' : 'آفلاین'}
    </span>
  );
}

/** «دفترچه تلفن سازمانی»: people, their unit and position, internal numbers and whether they are online. */
export function CommDirectoryPage() {
  const { me } = useAuth();
  const [q, setQ] = useState('');
  const [unitId, setUnitId] = useState('');
  const r = useApi<Person[]>(`/communications/directory?q=${encodeURIComponent(q)}&unitId=${unitId}`, [q, unitId]);
  const nav = useNavigate();
  const act = useAction();
  const c2c = useClickToCall();
  useRealtime({
    UserPresenceChanged: (p: { userId: string; online: boolean }) =>
      r.setData((list) => list?.map((x) => (x.id === p.userId ? { ...x, online: p.online } : x)) ?? list),
  });
  const message = (p: Person) =>
    act.run(async () => {
      const c = await post<{ id: string }>('/communications/conversations', { type: 'direct', userId: p.id });
      nav(`/communications/messages?c=${c.id}`);
    });

  return (
    <>
      <PageHeader title="دفترچه تلفن سازمانی" subtitle="شماره داخلی، واحد و سمت همکاران؛ با «تماس» اول گوشی خودتان زنگ می‌خورد، با «پیام» گفت‌وگو شروع می‌شود" />
      <Card>
        <div className="dir-filters">
          <input className="input" placeholder="جستجوی نام، سمت، واحد یا شماره داخلی…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="جستجو" />
          <UnitSelect value={unitId} onChange={setUnitId} emptyLabel="همه واحدها" />
        </div>
        {c2c.notice && (
          <div className={`alert alert-${c2c.notice.tone} mb`} role="status">
            {c2c.notice.text}
          </div>
        )}
        <ErrorBox error={r.error ?? act.error} />
        {r.loading && !r.data ? (
          <Loading />
        ) : !r.data?.length ? (
          <Empty>کسی با این مشخصات پیدا نشد.</Empty>
        ) : (
          <ul className="dir-list">
            {r.data.map((p) => (
              <li key={p.id} className="dir-card">
                <div className="dir-main">
                  <strong>{p.full_name}</strong>
                  <span className="small muted">
                    {p.position_title ?? 'بدون سمت'}
                    {p.unit_name ? ` · ${p.unit_name}` : ''}
                  </span>
                  <Presence online={p.online} />
                </div>
                <div className="dir-ext">
                  {p.extensions.length ? (
                    p.extensions.map((e) => (
                      <span key={e.number} className="dir-number" title={e.label ?? undefined}>
                        <Icon name="phone" size={15} />
                        <span className="mono">{fa(e.number)}</span>
                        {e.status !== 'active' && <Badge tone="warning">در حال راه‌اندازی</Badge>}
                        {e.status === 'active' && c2c.ready && p.id !== me!.id && (
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => c2c.call(e.number, p.full_name)}
                            disabled={c2c.busy}
                            aria-label={`تماس با ${p.full_name}، داخلی ${fa(e.number)}`}
                          >
                            تماس
                          </Button>
                        )}
                      </span>
                    ))
                  ) : (
                    <span className="small muted">داخلی ندارد</span>
                  )}
                </div>
                {p.id !== me!.id && (
                  <Button variant="secondary" size="sm" onClick={() => message(p)} disabled={act.busy}>
                    <Icon name="chat" size={16} /> پیام
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}
