import jwt from 'jsonwebtoken';
import { config } from '../config.js';

/**
 * Built-in webinar: a self-hosted Jitsi Meet server that only accepts rooms joined with a token
 * signed here. Each meeting has one room; chair, vice-chair and secretary join as moderators.
 */
export const webinarEnabled = () => !!(config.webinar.url && config.webinar.secret);

export interface WebinarMeeting {
  id: string;
  number: number;
  title: string;
  type: string;
  status: string;
  scheduled_at: string | Date;
  duration_minutes: number | null;
}

/** Stable, URL-safe room name for a meeting (the token restricts who may enter it). */
export const webinarRoom = (m: Pick<WebinarMeeting, 'id' | 'number'>) => `kx-${m.number}-${m.id.replace(/-/g, '').slice(0, 12)}`;

const LIVE = ['checkin_open', 'in_progress', 'agenda_processing'];
const BEFORE = ['draft', 'scheduled', 'invitation_sent'];

export type WebinarState = 'disabled' | 'in_person' | 'open' | 'not_yet' | 'closed';

/**
 * Whether this person may enter the room now. Everyone invited can join while check-in is open and
 * during the meeting; officers may open the room a little before the scheduled start.
 */
export function webinarState(m: WebinarMeeting, isOfficer: boolean, now = new Date()): WebinarState {
  if (!webinarEnabled()) return 'disabled';
  if (m.type === 'in_person') return 'in_person';
  if (LIVE.includes(m.status)) return 'open';
  if (BEFORE.includes(m.status)) {
    const opensAt = new Date(m.scheduled_at).getTime() - config.webinar.earlyMinutes * 60_000;
    return isOfficer && m.status !== 'draft' && now.getTime() >= opensAt ? 'open' : 'not_yet';
  }
  return 'closed';
}

export function webinarToken(
  m: WebinarMeeting,
  user: { id: string; fullName: string; email?: string | null },
  moderator: boolean,
  now = new Date(),
): string {
  const end = new Date(m.scheduled_at).getTime() + ((m.duration_minutes ?? 120) + 180) * 60_000;
  const exp = Math.floor(Math.max(end, now.getTime() + 3 * 3600_000) / 1000);
  return jwt.sign(
    {
      aud: 'jitsi',
      iss: config.webinar.appId,
      sub: '*',
      room: webinarRoom(m),
      nbf: Math.floor(now.getTime() / 1000) - 60,
      exp,
      context: {
        user: { id: user.id, name: user.fullName, email: user.email ?? undefined, moderator, affiliation: moderator ? 'owner' : 'member' },
        features: { recording: false, livestreaming: false, transcription: false, 'screen-sharing': true },
      },
    },
    config.webinar.secret,
    { algorithm: 'HS256', noTimestamp: false },
  );
}

/** Join link with the token and a few interface settings (Persian UI, meeting title as subject). */
export function webinarJoinUrl(m: WebinarMeeting, token: string): string {
  const hash = [
    `config.subject=${encodeURIComponent(JSON.stringify(`جلسه ${m.number} — ${m.title}`))}`,
    `config.defaultLanguage=${encodeURIComponent('"fa"')}`,
    'config.disableDeepLinking=true',
  ].join('&');
  return `${config.webinar.url}/${webinarRoom(m)}?jwt=${token}#${hash}`;
}
