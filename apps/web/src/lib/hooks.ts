import { useCallback, useEffect, useRef, useState } from 'react';
import { io, type Socket } from 'socket.io-client';
import { ApiError, get, getSession, onSessionChange } from './api';

/** Loads data from the API; `reload` re-fetches. */
export function useApi<T = any>(path: string | null, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(!!path);
  const seq = useRef(0);
  const reload = useCallback(async () => {
    if (!path) return;
    const n = ++seq.current;
    setLoading(true);
    try {
      const d = await get<T>(path);
      if (n === seq.current) {
        setData(d);
        setError(null);
      }
    } catch (e) {
      if (n === seq.current) setError(e as ApiError);
    } finally {
      if (n === seq.current) setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, ...deps]);
  useEffect(() => {
    void reload();
  }, [reload]);
  return { data, error, loading, reload, setData };
}

let socket: Socket | null = null;

export function getSocket(): Socket | null {
  const s = getSession();
  if (!s) return null;
  if (!socket) {
    socket = io({ path: '/socket.io', auth: (cb) => cb({ token: getSession()?.accessToken }), transports: ['websocket', 'polling'] });
    onSessionChange((sess) => {
      if (!sess) {
        socket?.disconnect();
        socket = null;
      }
    });
  }
  return socket;
}

/** Subscribe to socket events (optionally after joining a meeting room). Re-joins after reconnect. */
export function useSocket(handlers: Record<string, (payload: any) => void>, meetingId?: string) {
  const ref = useRef(handlers);
  ref.current = handlers;
  const [connected, setConnected] = useState(false);
  useEffect(() => {
    const s = getSocket();
    if (!s) return;
    const join = () => {
      setConnected(true);
      if (meetingId) s.emit('meeting:join', meetingId);
      ref.current['reconnect']?.(null);
    };
    const onDisconnect = () => setConnected(false);
    if (s.connected) join();
    s.on('connect', join);
    s.on('disconnect', onDisconnect);
    const names = Object.keys(ref.current).filter((n) => n !== 'reconnect');
    const fns = names.map((n) => {
      const fn = (p: any) => ref.current[n]?.(p);
      s.on(n, fn);
      return [n, fn] as const;
    });
    return () => {
      s.off('connect', join);
      s.off('disconnect', onDisconnect);
      fns.forEach(([n, fn]) => s.off(n, fn));
      if (meetingId) s.emit('meeting:leave', meetingId);
    };
  }, [meetingId]);
  return connected;
}
