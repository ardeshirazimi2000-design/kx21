// Calendar file (iCalendar, .ics) for one visit, so the phone's own calendar reminds the patient or
// doctor even when the app is closed and without any SMS.
const esc = (s) => String(s ?? '').replace(/\\/g, '\\\\').replace(/[,;]/g, (c) => `\\${c}`).replace(/\r?\n/g, '\\n');
const stamp = (iso) => new Date(iso).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
// Lines longer than 75 bytes are folded (continuation lines start with a space); never split a character.
function fold(line) {
  const out = [];
  let cur = '';
  let bytes = 0;
  for (const ch of line) {
    const n = Buffer.byteLength(ch);
    if (bytes + n > (out.length ? 74 : 75)) { out.push(cur); cur = ''; bytes = 0; }
    cur += ch; bytes += n;
  }
  out.push(cur);
  return out.join('\r\n ');
}

export function visitIcs({ id, startsAt, endsAt, title, description, url, alarms = [60, 10] }) {
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Darman Plus//Visit//FA', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:visit-${id}@darman-plus.ir`, `DTSTAMP:${stamp(new Date().toISOString())}`,
    `DTSTART:${stamp(startsAt)}`, `DTEND:${stamp(endsAt)}`,
    `SUMMARY:${esc(title)}`, `DESCRIPTION:${esc(description)}`, `URL:${esc(url)}`, `LOCATION:${esc(url)}`,
    ...alarms.flatMap((m) => ['BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${esc(`${title} — ${m} دقیقه دیگر`)}`, `TRIGGER:-PT${m}M`, 'END:VALARM']),
    'END:VEVENT', 'END:VCALENDAR',
  ];
  return `${lines.map(fold).join('\r\n')}\r\n`;
}
