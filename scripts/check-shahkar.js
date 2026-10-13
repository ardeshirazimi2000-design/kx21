// Server-side Shahkar diagnostic: run on the VPS to see exactly what s.api.ir returns to *this* server.
//   sudo node /opt/kx21/scripts/check-shahkar.js <nationalCode> <mobile>
// Reads SAPI_TOKEN / SAPI_BASE from the environment or /etc/kx21.env. The token is never printed.
import { readFileSync } from 'node:fs';
import { callShahkar, cleanToken, readVerdict } from '../src/modules/identity.js';

const env = { ...process.env };
try {
  for (const line of readFileSync('/etc/kx21.env', 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m && env[m[1]] === undefined) env[m[1]] = m[2];
  }
} catch { /* no env file */ }

const [nationalId, mobile] = process.argv.slice(2);
if (!nationalId || !mobile) { console.log('usage: node scripts/check-shahkar.js <nationalCode> <mobile>'); process.exit(1); }
const token = cleanToken(env.SAPI_TOKEN);
const base = env.SAPI_BASE || 'https://s.api.ir/api/sw1';
const raw = String(env.SAPI_TOKEN ?? '');
console.log('SAPI_BASE      :', base);
console.log('SAPI_TOKEN     :', token ? `set (${token.length} chars${raw !== token ? ', cleaned quotes/space/"Bearer"' : ''})` : 'NOT SET → app uses mock (dev) or refuses (production)');
console.log('NODE_ENV       :', env.NODE_ENV ?? '(unset)');
if (!token) process.exit(2);

try {
  const r = await callShahkar({ base, token, nationalId, mobile });
  console.log('HTTP status    :', r.status);
  const mask = (s) => s.replaceAll(nationalId, '<nid>').replaceAll(mobile, '<mobile>');
  console.log('response       :', mask(r.text).slice(0, 1500));
  const v = r.body ? readVerdict(r.body) : undefined;
  console.log('app verdict    :', v === undefined ? 'UNRECOGNISED (send the response above, without personal data)' : v ? 'MATCH' : 'NO MATCH');
} catch (e) {
  console.log('network error  :', e.cause?.code ?? '', e.cause?.message ?? e.message);
  console.log('→ this server cannot reach s.api.ir (firewall / DNS / geo-restriction of non-Iranian IPs).');
}
