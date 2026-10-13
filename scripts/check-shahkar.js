// Server-side Shahkar diagnostic: run on the VPS to see exactly what s.api.ir returns to *this* server.
//   sudo node /opt/kx21/scripts/check-shahkar.js <nationalCode> <mobile>          (Shahkar)
//   sudo node /opt/kx21/scripts/check-shahkar.js person <nationalCode> <1371/1/1>  (PersonInfo / ثبت احوال)
// Reads SAPI_TOKEN / SAPI_BASE from the environment or /etc/kx21.env. The token is never printed.
import { readFileSync } from 'node:fs';
import { callShahkar, callSapi, cleanToken, readVerdict, readPerson } from '../src/modules/identity.js';

const env = { ...process.env };
try {
  for (const line of readFileSync('/etc/kx21.env', 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m && env[m[1]] === undefined) env[m[1]] = m[2];
  }
} catch { /* no env file */ }

const args = process.argv.slice(2);
const person = args[0] === 'person';
const [nationalId, mobile] = person ? args.slice(1) : args; // for `person`, the 2nd value is the Jalali birth date
if (!nationalId || !mobile) {
  console.log('usage: node scripts/check-shahkar.js <nationalCode> <mobile>\n       node scripts/check-shahkar.js person <nationalCode> <1371/1/1>');
  process.exit(1);
}
const token = cleanToken(env.SAPI_TOKEN);
const base = env.SAPI_BASE || 'https://s.api.ir/api/sw1';
const raw = String(env.SAPI_TOKEN ?? '');
console.log('SAPI_BASE      :', base);
console.log('SAPI_TOKEN     :', token ? `set (${token.length} chars${raw !== token ? ', cleaned quotes/space/"Bearer"' : ''})` : 'NOT SET → app uses mock (dev) or refuses (production)');
console.log('NODE_ENV       :', env.NODE_ENV ?? '(unset)');
if (!token) process.exit(2);

try {
  const r = person
    ? await callSapi({ url: env.IDENTITY_INQUIRY_URL || `${base.replace(/\/$/, '')}/PersonInfo`, token, body: { nationalCode: nationalId, birthDate: mobile } })
    : await callShahkar({ base, token, nationalId, mobile });
  console.log('HTTP status    :', r.status);
  const mask = (s) => s.replaceAll(nationalId, '<nid>').replaceAll(mobile, '<mobile>');
  if (person) {
    // Names are personal data: show the structure only, with values masked.
    console.log('response shape :', JSON.stringify(r.body, (k, v) => (typeof v === 'string' && k !== 'message' ? '…' : v))?.slice(0, 1500) ?? mask(r.text).slice(0, 300));
    const p = r.body ? readPerson(r.body) : undefined;
    console.log('app verdict    :', p === undefined ? 'UNRECOGNISED (send the shape above)' : p.found ? `FOUND (name: ${p.first_name ? '✓' : '✗'} first, ${p.last_name ? '✓' : '✗'} last${p.deceased ? ', DECEASED' : ''})` : `NOT FOUND (${p.message ?? ''})`);
  } else {
    console.log('response       :', mask(r.text).slice(0, 1500));
    const v = r.body ? readVerdict(r.body) : undefined;
    console.log('app verdict    :', v === undefined ? 'UNRECOGNISED (send the response above, without personal data)' : v ? 'MATCH' : 'NO MATCH');
  }
} catch (e) {
  console.log('network error  :', e.cause?.code ?? '', e.cause?.message ?? e.message);
  console.log('→ this server cannot reach s.api.ir (firewall / DNS / geo-restriction of non-Iranian IPs).');
}
