/**
 * Alerts for new notifications while the system is open: a short chime, a desktop notification (when the
 * browser allows it — it needs HTTPS) and the unread count in the tab title. Preferences are per browser.
 */

export interface LiveNotification {
  id: string;
  event: string;
  title: string;
  body: string;
  data?: Record<string, any>;
}

/** Page to open for a notification. */
export const notificationLink = (n: { data?: Record<string, any> }) =>
  n.data?.networkId
    ? `/networks/${n.data.networkId}`
    : n.data?.meetingId
      ? `/meetings/${n.data.meetingId}`
      : n.data?.resolutionId
        ? `/resolutions/${n.data.resolutionId}`
        : n.data?.referralId
          ? '/referrals'
          : '/notifications';

const KEY = 'kx.notify.sound';
export function soundEnabled() {
  try {
    return localStorage.getItem(KEY) !== 'off';
  } catch {
    return true;
  }
}
export function setSoundEnabled(on: boolean) {
  try {
    localStorage.setItem(KEY, on ? 'on' : 'off');
  } catch {
    /* storage unavailable */
  }
}

let ctx: AudioContext | null = null;
function audio() {
  const AC = window.AudioContext ?? (window as any).webkitAudioContext;
  if (!AC) return null;
  ctx ??= new AC();
  return ctx;
}
/** Browsers start sound only after the user has interacted with the page; the first click unlocks it. */
export function unlockAudioOnFirstGesture() {
  const unlock = () => {
    void audio()?.resume();
    window.removeEventListener('pointerdown', unlock);
    window.removeEventListener('keydown', unlock);
  };
  window.addEventListener('pointerdown', unlock);
  window.addEventListener('keydown', unlock);
}

/** Two soft rising notes. */
export function playChime() {
  const a = audio();
  if (!a) return;
  void a.resume();
  const start = a.currentTime + 0.02;
  [
    [880, 0],
    [1318.5, 0.16],
  ].forEach(([freq, at]) => {
    const o = a.createOscillator();
    const g = a.createGain();
    o.type = 'sine';
    o.frequency.value = freq;
    g.gain.setValueAtTime(0.0001, start + at);
    g.gain.exponentialRampToValueAtTime(0.25, start + at + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, start + at + 0.45);
    o.connect(g).connect(a.destination);
    o.start(start + at);
    o.stop(start + at + 0.5);
  });
}

/** Desktop notifications exist only on HTTPS (or localhost). */
export const desktopSupported = () => 'Notification' in window && window.isSecureContext;
export const desktopPermission = () => (desktopSupported() ? Notification.permission : 'unsupported');
export async function requestDesktop() {
  if (!desktopSupported()) return 'unsupported';
  return Notification.requestPermission();
}

export function showDesktop(n: LiveNotification, open: (path: string) => void) {
  if (!desktopSupported() || Notification.permission !== 'granted' || !document.hidden) return;
  const d = new Notification(n.title, { body: n.body, tag: n.id, icon: '/iran-chamber-logo.png', lang: 'fa', dir: 'rtl' });
  d.onclick = () => {
    window.focus();
    open(notificationLink(n));
    d.close();
  };
}

let baseTitle: string | null = null;
/** «(۳) سامانه …» in the browser tab while there are unread notifications. */
export function setTitleCount(n: number) {
  baseTitle ??= document.title.replace(/^\(\S+\)\s*/, '');
  document.title = n > 0 ? `(${n.toLocaleString('fa-IR')}) ${baseTitle}` : baseTitle;
}
