import type { Server as HttpServer } from 'node:http';
import { Server, type Socket } from 'socket.io';
import { loadAuthUser } from '../auth/middleware.js';
import { verifyToken } from '../auth/tokens.js';
import { config } from '../config.js';
import { logger } from '../lib/logger.js';

/**
 * Real-time channel of the office automation (Socket.IO, the same library the meetings system uses).
 * A socket authenticates with the access token and joins only its own room `user:<id>`; every event is addressed
 * to the users allowed to see it (conversation members), never broadcast with content.
 * The socket is closed when its access token expires and when the user's sessions are revoked, so it never
 * outlives the sign-in; the client reconnects with a fresh token.
 */
export const REALTIME_PATH = '/api/realtime';

let io: Server | null = null;
/** userId → number of open sockets (presence: online while at least one is connected). */
const online = new Map<string, number>();

export const isOnline = (userId: string) => (online.get(userId) ?? 0) > 0;
export const onlineUsers = () => [...online.keys()];

export function initRealtime(server: HttpServer): Server {
  io = new Server(server, { path: REALTIME_PATH, cors: { origin: config.corsOrigins, credentials: true }, serveClient: false });

  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth?.token as string | undefined;
      const payload = token ? (verifyToken(token, 'access') as { sub: string; exp?: number } | null) : null;
      const user = payload ? await loadAuthUser(payload.sub) : null;
      if (!payload || !user) return next(new Error('unauthorized'));
      // Same rule as the REST API: a role that must use 2FA gets nothing until it is enabled.
      if (!user.mfaEnabled && user.roles.some((r) => config.mfaRequiredRoles.includes(r))) return next(new Error('mfa_required'));
      socket.data.userId = user.id;
      socket.data.exp = payload.exp ?? 0;
      next();
    } catch (e) {
      logger.warn({ err: e }, 'realtime handshake failed');
      next(new Error('unauthorized'));
    }
  });

  io.on('connection', (socket: Socket) => {
    const userId: string = socket.data.userId;
    socket.join(`user:${userId}`);
    const n = (online.get(userId) ?? 0) + 1;
    online.set(userId, n);
    if (n === 1) io?.emit('UserPresenceChanged', { userId, online: true });

    const ms = socket.data.exp * 1000 - Date.now();
    const expiry = setTimeout(() => socket.disconnect(true), Math.max(0, Math.min(ms, 2 ** 31 - 1)));

    socket.on('disconnect', () => {
      clearTimeout(expiry);
      const left = (online.get(userId) ?? 1) - 1;
      if (left > 0) online.set(userId, left);
      else {
        online.delete(userId);
        io?.emit('UserPresenceChanged', { userId, online: false });
      }
    });
  });
  return io;
}

export function emitToUsers(userIds: string[], event: string, payload: unknown) {
  if (!io || !userIds.length) return;
  io.to(userIds.map((id) => `user:${id}`)).emit(event, payload);
}

/** Closes every socket of the user (sessions revoked, account disabled). */
export function disconnectUser(userId: string) {
  io?.in(`user:${userId}`).disconnectSockets(true);
}

export async function closeRealtime() {
  await io?.close();
  io = null;
  online.clear();
}
