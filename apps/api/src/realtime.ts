import type { Server as HttpServer } from 'node:http';
import { Server } from 'socket.io';
import { loadAuthUser } from './auth/middleware.js';
import { verifyToken } from './auth/tokens.js';
import { config } from './config.js';
import { meetingAccess } from './services/access.js';

/**
 * Real-time channel (Socket.IO over WebSocket with polling fallback).
 * Rooms:
 *   user:{userId}               personal notifications
 *   meeting:{id}                everyone allowed to view the meeting
 *   meeting:{id}:officers       chair / vice-chair / secretary / admins (full attendance, voter details)
 */
let io: Server | null = null;

export function initRealtime(server: HttpServer): Server {
  io = new Server(server, {
    cors: { origin: config.corsOrigins, credentials: true },
    path: '/socket.io',
  });

  io.use(async (socket, next) => {
    const token = (socket.handshake.auth?.token as string | undefined) ?? undefined;
    const payload = token ? verifyToken(token, 'access') : null;
    const user = payload ? await loadAuthUser(payload.sub) : null;
    if (!user) return next(new Error('unauthorized'));
    socket.data.user = user;
    next();
  });

  io.on('connection', (socket) => {
    socket.join(`user:${socket.data.user.id}`);

    socket.on('meeting:join', async (meetingId: string, ack?: (r: unknown) => void) => {
      try {
        const access = await meetingAccess(socket.data.user, String(meetingId));
        socket.join(`meeting:${access.meeting.id}`);
        if (access.can('attendance.view_all')) socket.join(`meeting:${access.meeting.id}:officers`);
        ack?.({ ok: true });
      } catch {
        ack?.({ ok: false });
      }
    });

    socket.on('meeting:leave', (meetingId: string) => {
      socket.leave(`meeting:${meetingId}`);
      socket.leave(`meeting:${meetingId}:officers`);
    });
  });

  return io;
}

export function emitToMeeting(meetingId: string, event: string, payload: unknown) {
  io?.to(`meeting:${meetingId}`).emit(event, payload);
}

export function emitToOfficers(meetingId: string, event: string, payload: unknown) {
  io?.to(`meeting:${meetingId}:officers`).emit(event, payload);
}

export function emitToUser(userId: string, event: string, payload: unknown) {
  io?.to(`user:${userId}`).emit(event, payload);
}

export async function closeRealtime() {
  await io?.close();
  io = null;
}
