import { useEffect, useRef, useState } from 'react';
import { io, type Socket } from 'socket.io-client';
import { getSession, onSessionChange } from './api';
import { getApiUrl } from './config';

let socket: Socket | null = null;

export function getSocket(): Socket | null {
  if (!getSession()) return null;
  if (!socket) {
    socket = io(getApiUrl(), {
      path: '/socket.io',
      transports: ['websocket'],
      auth: (cb) => cb({ token: getSession()?.accessToken }),
      reconnectionDelayMax: 5000,
    });
    onSessionChange((s) => {
      if (!s) {
        socket?.disconnect();
        socket = null;
      }
    });
  }
  return socket;
}

/**
 * Subscribes to real-time events. After every (re)connection the meeting room is re-joined
 * and `onReconnect` is called so the screen can refetch state missed while offline.
 */
export function useRealtime(handlers: Record<string, (p: any) => void>, opts: { meetingId?: string; onReconnect?: () => void } = {}) {
  const ref = useRef({ handlers, onReconnect: opts.onReconnect });
  ref.current = { handlers, onReconnect: opts.onReconnect };
  const [connected, setConnected] = useState(false);
  useEffect(() => {
    const s = getSocket();
    if (!s) return;
    const onConnect = () => {
      setConnected(true);
      if (opts.meetingId) s.emit('meeting:join', opts.meetingId);
      ref.current.onReconnect?.();
    };
    const onDisconnect = () => setConnected(false);
    if (s.connected) onConnect();
    s.on('connect', onConnect);
    s.on('disconnect', onDisconnect);
    const bound = Object.keys(ref.current.handlers).map((name) => {
      const fn = (p: any) => ref.current.handlers[name]?.(p);
      s.on(name, fn);
      return [name, fn] as const;
    });
    return () => {
      s.off('connect', onConnect);
      s.off('disconnect', onDisconnect);
      bound.forEach(([n, fn]) => s.off(n, fn));
      if (opts.meetingId) s.emit('meeting:leave', opts.meetingId);
    };
  }, [opts.meetingId]);
  return connected;
}
