import { useState } from 'react';
import { Link } from 'react-router-dom';
import { fa } from './ui';
import { Icon } from './icons';
import { useRealtime } from '../lib/realtime';

interface Ringing {
  callId: string;
  from: string | null;
  fromName: string | null;
  direction: 'internal' | 'inbound' | 'outbound';
}

/**
 * Shown while one's phone rings: who is calling (internal colleague or city line). Rasa does not answer the call;
 * the desk phone or softphone does. A missed call stays until dismissed and links to the call history.
 */
export function CallAlert() {
  const [ringing, setRinging] = useState<Ringing | null>(null);
  const [missed, setMissed] = useState<Ringing | null>(null);
  const end = (p: { callId: string }, wasMissed: boolean) => {
    setRinging((r) => {
      if (r && r.callId === p.callId && wasMissed) setMissed(r);
      return r && r.callId === p.callId ? null : r;
    });
  };
  useRealtime({
    IncomingCall: (p: Ringing) => setRinging(p),
    CallRinging: (p: Ringing) => setRinging(p),
    CallAnswered: (p: { callId: string }) => end(p, false),
    CallEnded: (p: { callId: string }) => end(p, false),
    CallMissed: (p: { callId: string }) => end(p, true),
  });
  const who = (r: Ringing) => (r.fromName ? `${r.fromName} (${fa(r.from)})` : r.from ? fa(r.from) : 'شماره نامشخص');
  if (ringing)
    return (
      <div className="call-alert" role="alert" aria-live="assertive">
        <span className="call-alert-icon ringing" aria-hidden>
          <Icon name="phone" size={20} />
        </span>
        <span className="call-alert-text">
          <strong>{ringing.direction === 'inbound' ? 'تماس از خط شهری' : 'تماس داخلی'}</strong>
          <span>{who(ringing)}</span>
        </span>
        <button className="call-alert-close" onClick={() => setRinging(null)} aria-label="بستن">
          ×
        </button>
      </div>
    );
  if (missed)
    return (
      <div className="call-alert call-alert-missed" role="status">
        <span className="call-alert-icon" aria-hidden>
          <Icon name="phone" size={20} />
        </span>
        <span className="call-alert-text">
          <strong>تماس بی‌پاسخ</strong>
          <span>
            {who(missed)} ·{' '}
            <Link to="/communications/calls" onClick={() => setMissed(null)}>
              تماس‌ها
            </Link>
          </span>
        </span>
        <button className="call-alert-close" onClick={() => setMissed(null)} aria-label="بستن">
          ×
        </button>
      </div>
    );
  return null;
}
