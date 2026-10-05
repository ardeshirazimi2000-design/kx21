import { createApp } from '../src/app.js';
import { randomUUID } from 'node:crypto';

export async function startApp(overrides = {}) {
  const app = createApp({
    dbPath: ':memory:', streamDelayMs: 0, logNotifications: false, devMode: true, llmBaseUrl: '', ...overrides,
  });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;

  async function call(method, path, { token, body, headers = {} } = {}) {
    const res = await fetch(base + path, {
      method,
      headers: {
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...headers,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* SSE / non-JSON */ }
    return { status: res.status, body: json, text, headers: res.headers };
  }

  async function login(phone) {
    const r1 = await call('POST', '/v1/auth/otp/request', { body: { phone } });
    const r2 = await call('POST', '/v1/auth/otp/verify', { body: { phone, code: r1.body.dev_code } });
    if (r2.body.mfa_required) {
      const r3 = await call('POST', '/v1/auth/mfa/verify', { body: { mfa_token: r2.body.mfa_token, code: r2.body.dev_code } });
      return r3.body.access_token;
    }
    return r2.body.access_token;
  }

  // Registers a patient with profile + telehealth consent; returns a token that carries pid.
  async function newPatient({ phone, nationalId = '0499370899', consents = ['telehealth'] } = {}) {
    const p = phone ?? `0912${String(Math.floor(1e6 + Math.random() * 8e6)).padStart(7, '0')}`;
    let token = await login(p);
    const r = await call('PUT', '/v1/patients/me', { token, body: { full_name: 'بیمار آزمایشی', national_id: nationalId, dob: '1990-05-01' } });
    if (r.status !== 201) throw new Error(`profile failed: ${r.text}`);
    for (const type of consents) await call('POST', '/v1/patients/me/consents', { token, body: { type } });
    token = (await call('POST', '/v1/auth/refresh', { token })).body.access_token;
    return { token, phone: p };
  }

  async function chat(token, sessionId, content) {
    const r = await call('POST', '/v1/ai/chat', { token, body: { session_id: sessionId, message: { type: 'text', content } } });
    if (r.status !== 200) return { status: r.status, error: r.body };
    const events = [];
    for (const block of r.text.split('\n\n')) {
      const ev = /^event: (.+)$/m.exec(block)?.[1];
      const data = /^data: (.+)$/m.exec(block)?.[1];
      if (ev) events.push({ event: ev, data: JSON.parse(data) });
    }
    const text = events.filter((e) => e.event === 'token').map((e) => e.data.text).join('');
    const done = events.find((e) => e.event === 'done')?.data;
    return { status: 200, events, text, mode: done?.mode, done };
  }

  return { app, base, call, login, newPatient, chat, close: () => app.close(), uuid: randomUUID };
}

// Valid Iranian national IDs for tests.
export const NATIONAL_IDS = ['0499370899', '0790419904', '0084575948', '0013542419', '0067749828', '0076229645'];

// Random valid Iranian national ID (checksum digit computed), for tests that need a fresh patient.
export function randomNationalId() {
  const d = Array.from({ length: 9 }, () => Math.floor(Math.random() * 10));
  if (d.every((x) => x === d[0])) d[0] = (d[0] + 1) % 10;
  const r = d.reduce((a, x, i) => a + x * (10 - i), 0) % 11;
  return d.join('') + (r < 2 ? r : 11 - r);
}
