// Drug-directory diagnostic: run on the server to see what the external API returns to it.
//   sudo /opt/node22/bin/node /opt/kx21/scripts/check-drug-api.js استامینوفن
// Reads DRUG_API_BASE / DRUG_API_TOKEN from the environment or /etc/kx21.env (token never printed).
import { readFileSync } from 'node:fs';
import { extractItems, normalizeSearchItem, normalizeInfo } from '../src/modules/rx/drug-directory.js';

const env = { ...process.env };
try {
  for (const line of readFileSync('/etc/kx21.env', 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m && env[m[1]] === undefined) env[m[1]] = m[2];
  }
} catch { /* no env file */ }
const base = (env.DRUG_API_BASE || 'https://api.majidapi.ir/darooyab').replace(/\/$/, '');
const term = process.argv[2] || 'استامینوفن';
const shape = (v) => JSON.stringify(v, (k, x) => (typeof x === 'string' && x.length > 60 ? `${x.slice(0, 60)}…` : x), 1)?.slice(0, 2500);
console.log('DRUG_API_BASE :', base, env.DRUG_API_BASE ? '' : '(default — not set in /etc/kx21.env)');
console.log('DRUG_API_TOKEN:', env.DRUG_API_TOKEN ? 'set' : 'not set');

async function get(path, params) {
  const u = new URL(`${base}/${path}`);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  if (env.DRUG_API_TOKEN) u.searchParams.set('token', env.DRUG_API_TOKEN);
  const res = await fetch(u, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, body, text };
}

try {
  const s = await get('search', { search: term });
  console.log('\n== search HTTP', s.status);
  console.log(s.body ? shape(s.body) : s.text.slice(0, 500));
  const items = s.body ? extractItems(s.body).map(normalizeSearchItem).filter(Boolean) : [];
  console.log(`\napp reads ${items.length} result(s):`, items.slice(0, 3));
  const url = items.find((i) => i.url)?.url;
  if (!url) { console.log('\n→ no darooyab.ir link found in results; send the output above.'); process.exit(0); }
  const i = await get('info', { url });
  console.log('\n== info HTTP', i.status, url);
  console.log(i.body ? shape(i.body) : i.text.slice(0, 500));
  const sections = i.body ? normalizeInfo(i.body) : [];
  console.log(`\napp reads ${sections.length} section(s):`, sections.slice(0, 6).map((x) => `${x.label}: ${x.text.slice(0, 50)}…`));
} catch (e) {
  console.log('network error:', e.cause?.code ?? '', e.cause?.message ?? e.message);
}
