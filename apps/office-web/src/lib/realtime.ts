import { useEffect, useRef, useState } from 'react';
import { io, type Socket } from 'socket.io-client';
import { get, getSession, onSessionChange } from './api';

/**
 * One Socket.IO connection per tab to the office API (path /api/realtime), authenticated with the access token.
 * The server closes it when the token expires or the sessions are revoked; we then refresh the token (any API call
 * does) and reconnect. Signing out closes it.
 */
let socket: Socket | null = null;

async function reauth(s: Socket) {
  try {
    await get('/auth/me'); // refreshes the access token when it has expired
  } catch {
    return;
  }
  if (getSession() && socket === s) s.connect();
}

export function getSocket(): Socket | null {
  if (!getSession()) return null;
  if (!socket) {
    const s = io({ path: '/api/realtime', auth: (cb) => cb({ token: getSession()?.accessToken }), transports: ['websocket', 'polling'] });
    s.on('connect_error', (e) => {
      if (e.message === 'unauthorized') setTimeout(() => void reauth(s), 1000);
    });
    s.on('disconnect', (reason) => {
      // closed by the server (token expired): no automatic reconnect, do it with a fresh token
      if (reason === 'io server disconnect') setTimeout(() => void reauth(s), 500);
    });
    socket = s;
  }
  return socket;
}

onSessionChange((sess) => {
  if (!sess && socket) {
    socket.disconnect();
    socket = null;
  }
});

/** Subscribes to real-time events for the component's lifetime; returns whether the channel is connected. */
export function useRealtime(handlers: Record<string, (payload: any) => void>) {
  const ref = useRef(handlers);
  ref.current = handlers;
  const [connected, setConnected] = useState(() => !!socket?.connected);
  const events = Object.keys(handlers).join(',');
  useEffect(() => {
    const s = getSocket();
    if (!s) return;
    const on = () => {
      setConnected(true);
      ref.current.reconnect?.(null);
    };
    const off = () => setConnected(false);
    s.on('connect', on);
    s.on('disconnect', off);
    setConnected(s.connected);
    const bound = events
      .split(',')
      .filter((e) => e && e !== 'reconnect')
      .map((e) => {
        const fn = (p: unknown) => ref.current[e]?.(p);
        s.on(e, fn);
        return [e, fn] as const;
      });
    return () => {
      s.off('connect', on);
      s.off('disconnect', off);
      bound.forEach(([e, fn]) => s.off(e, fn));
    };
  }, [events]);
  return connected;
}
