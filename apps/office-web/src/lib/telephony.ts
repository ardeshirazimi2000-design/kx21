import { useState } from 'react';
import { get, post } from './api';
import { useApi } from './hooks';

export interface CommStatus {
  pbx: { kind: string; configured: boolean; connected: boolean };
  realtime: boolean;
}

export interface MyExtension {
  id: string;
  extension_number: string;
  status: string;
  last_registered_at: string | null;
}

/** Persian digits typed in a number field → ASCII. */
export const asciiDigits = (s: string) => s.replace(/[۰-۹]/g, (d) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d))).replace(/[^0-9]/g, '');

/**
 * Click-to-call: Rasa asks the exchange to ring the user's own phone first; when they pick up, the destination rings.
 * `ready` is false without a connected exchange or an active extension of one's own.
 */
export function useClickToCall() {
  const status = useApi<CommStatus>('/communications/status');
  const mine = useApi<MyExtension[]>('/communications/extensions/mine');
  const [notice, setNotice] = useState<{ tone: 'info' | 'danger'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const own = mine.data?.find((e) => e.status === 'active') ?? null;
  const ready = !!status.data?.pbx.connected && !!own;
  const call = async (to: string, label?: string) => {
    setBusy(true);
    setNotice(null);
    try {
      await post('/communications/calls/originate', { to: asciiDigits(to) });
      setNotice({ tone: 'info', text: `گوشی شما (داخلی ${own?.extension_number ?? ''}) زنگ می‌خورد؛ گوشی را بردارید تا ${label ?? to} گرفته شود.` });
    } catch (e) {
      setNotice({ tone: 'danger', text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };
  return { ready, own, status: status.data, call, busy, notice, clear: () => setNotice(null) };
}

export const refreshStatus = () => get<CommStatus>('/communications/status');
