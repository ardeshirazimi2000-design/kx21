// Reads vital signs from Bluetooth LE medical devices that implement the standard Bluetooth SIG
// health profiles (e.g. many Beurer BM/BC blood-pressure monitors):
//   Blood Pressure 0x1810 → 0x2A35   Pulse Oximeter 0x1822 → 0x2A5E / 0x2A5F
//   Health Thermometer 0x1809 → 0x2A1C   Heart Rate 0x180D → 0x2A37
// Works in the Android app (Capacitor BluetoothLe plugin) and in Chrome on Android (Web Bluetooth).
// The phone itself measures nothing: values come from the certified device.

const uuid = (n) => `0000${n.toString(16).padStart(4, '0')}-0000-1000-8000-00805f9b34fb`;
export const SERVICES = {
  bp: { service: uuid(0x1810), chars: [uuid(0x2a35)] },
  plx: { service: uuid(0x1822), chars: [uuid(0x2a5e), uuid(0x2a5f)] },
  temp: { service: uuid(0x1809), chars: [uuid(0x2a1c)] },
  hr: { service: uuid(0x180d), chars: [uuid(0x2a37)] },
};

// ---------------------------------------------------------------- IEEE-11073 number formats
export function sfloat(raw) {
  if ([0x07ff, 0x0800, 0x07fe, 0x0802, 0x0801].includes(raw)) return null; // NaN, NRes, ±INF, reserved
  let mantissa = raw & 0x0fff;
  let exponent = raw >> 12;
  if (mantissa >= 0x0800) mantissa -= 0x1000;
  if (exponent >= 0x08) exponent -= 0x10;
  return mantissa * 10 ** exponent;
}

export function float32(raw) {
  if ([0x007fffff, 0x00800000, 0x007ffffe, 0x00800002, 0x00800001].includes(raw & 0x00ffffff) && (raw >>> 24) === 0) return null;
  let mantissa = raw & 0x00ffffff;
  let exponent = raw >> 24; // arithmetic shift keeps the sign of the 8-bit exponent
  if (mantissa >= 0x800000) mantissa -= 0x1000000;
  return mantissa * 10 ** exponent;
}

const round = (v, d = 0) => (v == null ? null : Math.round(v * 10 ** d) / 10 ** d);

function timestamp(dv, o) {
  const y = dv.getUint16(o, true);
  if (!y) return null;
  return new Date(y, dv.getUint8(o + 2) - 1, dv.getUint8(o + 3), dv.getUint8(o + 4), dv.getUint8(o + 5), dv.getUint8(o + 6)).toISOString();
}

// ---------------------------------------------------------------- characteristic parsers
export function parseBloodPressure(dv) {
  const flags = dv.getUint8(0);
  const kpa = flags & 0x01;
  const k = kpa ? 7.50062 : 1;
  let o = 7;
  const out = {
    sys: round(sfloat(dv.getUint16(1, true)) * k),
    dia: round(sfloat(dv.getUint16(3, true)) * k),
  };
  if (flags & 0x02) { out.measured_at = timestamp(dv, o); o += 7; }
  if (flags & 0x04) { out.hr = round(sfloat(dv.getUint16(o, true))); o += 2; }
  if (flags & 0x08) { out.user = dv.getUint8(o); o += 1; }
  if (flags & 0x10 && dv.byteLength >= o + 2) {
    const s = dv.getUint16(o, true);
    out.irregular_pulse = !!(s & 0x04);
    out.body_movement = !!(s & 0x01);
    out.cuff_fit_problem = !!(s & 0x02);
  }
  return out;
}

export function parsePlx(dv, spotCheck) {
  const flags = dv.getUint8(0);
  const out = { spo2: round(sfloat(dv.getUint16(1, true))), hr: round(sfloat(dv.getUint16(3, true))) };
  if (spotCheck && flags & 0x01) out.measured_at = timestamp(dv, 5);
  return out;
}

export function parseTemperature(dv) {
  const flags = dv.getUint8(0);
  let t = float32(dv.getInt32(1, true));
  if (t != null && flags & 0x01) t = (t - 32) * (5 / 9); // Fahrenheit → Celsius
  const out = { temp_c: round(t, 1) };
  if (flags & 0x02) out.measured_at = timestamp(dv, 5);
  return out;
}

export function parseHeartRate(dv) {
  const flags = dv.getUint8(0);
  return { hr: flags & 0x01 ? dv.getUint16(1, true) : dv.getUint8(1) };
}

export function parse(charUuid, dv) {
  switch (charUuid) {
    case SERVICES.bp.chars[0]: return { kind: 'bp', ...parseBloodPressure(dv) };
    case SERVICES.plx.chars[0]: return { kind: 'plx', ...parsePlx(dv, true) };
    case SERVICES.plx.chars[1]: return { kind: 'plx', ...parsePlx(dv, false) };
    case SERVICES.temp.chars[0]: return { kind: 'temp', ...parseTemperature(dv) };
    case SERVICES.hr.chars[0]: return { kind: 'hr', ...parseHeartRate(dv) };
    default: return null;
  }
}

// Keep plausible values only (devices send NaN/"no reading" markers).
export function toVitals(m) {
  const v = {};
  const ok = (x, lo, hi) => typeof x === 'number' && Number.isFinite(x) && x >= lo && x <= hi;
  if (ok(m.sys, 60, 260) && ok(m.dia, 30, 160)) { v.sys = m.sys; v.dia = m.dia; }
  if (ok(m.hr, 30, 220)) v.hr = m.hr;
  if (ok(m.spo2, 50, 100)) v.spo2 = m.spo2;
  if (ok(m.temp_c, 34, 43)) v.temp_c = m.temp_c;
  return v;
}

// ---------------------------------------------------------------- transport
const hexToDataView = (hex) => {
  const bytes = (String(hex).match(/[0-9a-f]{2}/gi) ?? []).map((b) => parseInt(b, 16));
  return new DataView(Uint8Array.from(bytes).buffer);
};

function nativePlugin() {
  const cap = window.Capacitor;
  return cap?.isNativePlatform?.() ? cap.Plugins?.BluetoothLe ?? null : null;
}

export function bleAvailable() {
  return !!nativePlugin() || !!navigator.bluetooth;
}

/**
 * Lets the user pick a device, connects, subscribes to every supported measurement and
 * resolves with the newest reading. `onStatus` receives Persian progress messages.
 */
export async function readFromDevice({ onStatus = () => {}, timeoutMs = 90_000, settleMs = 2500 } = {}) {
  const all = Object.values(SERVICES);
  const readings = [];
  let settleTimer = null;
  let resolveDone;
  const done = new Promise((r) => { resolveDone = r; });
  const onValue = (charUuid, dv) => {
    try {
      const m = parse(charUuid, dv);
      if (!m) return;
      readings.push(m);
      onStatus('داده دریافت شد…');
      clearTimeout(settleTimer); // devices may send their stored memory: wait for the burst to end
      settleTimer = setTimeout(resolveDone, settleMs);
    } catch { /* ignore malformed packet */ }
  };
  const timer = setTimeout(resolveDone, timeoutMs);
  let cleanup = async () => {};
  let name = 'دستگاه بلوتوثی';

  const ble = nativePlugin();
  if (ble) {
    await ble.initialize({ androidNeverForLocation: true });
    onStatus('دستگاه را از فهرست انتخاب کنید…');
    const dev = await ble.requestDevice({ optionalServices: all.map((s) => s.service) });
    name = dev.name || name;
    onStatus(`در حال اتصال به ${name}…`);
    await ble.connect({ deviceId: dev.deviceId });
    const listeners = [];
    for (const s of all) {
      for (const c of s.chars) {
        try {
          listeners.push(await ble.addListener(`notification|${dev.deviceId}|${s.service}|${c}`, (e) => onValue(c, hexToDataView(e?.value))));
          await ble.startNotifications({ deviceId: dev.deviceId, service: s.service, characteristic: c });
        } catch { /* service not on this device */ }
      }
    }
    cleanup = async () => { for (const l of listeners) await l.remove?.(); await ble.disconnect({ deviceId: dev.deviceId }).catch(() => {}); };
  } else if (navigator.bluetooth) {
    onStatus('دستگاه را از فهرست انتخاب کنید…');
    const dev = await navigator.bluetooth.requestDevice({ acceptAllDevices: true, optionalServices: all.map((s) => s.service) });
    name = dev.name || name;
    onStatus(`در حال اتصال به ${name}…`);
    const server = await dev.gatt.connect();
    for (const s of all) {
      let svc;
      try { svc = await server.getPrimaryService(s.service); } catch { continue; }
      for (const c of s.chars) {
        try {
          const ch = await svc.getCharacteristic(c);
          ch.addEventListener('characteristicvaluechanged', (e) => onValue(c, e.target.value));
          await ch.startNotifications();
        } catch { /* characteristic not present */ }
      }
    }
    cleanup = async () => { try { dev.gatt.disconnect(); } catch { /* already gone */ } };
  } else {
    throw new Error('بلوتوث در این مرورگر یا دستگاه پشتیبانی نمی‌شود');
  }

  onStatus('اکنون با دستگاه اندازه‌گیری کنید؛ نتیجه پس از پایان، خودکار دریافت می‌شود…');
  await done;
  clearTimeout(timer);
  clearTimeout(settleTimer);
  await cleanup();
  if (!readings.length) throw new Error('داده‌ای از دستگاه دریافت نشد. اندازه‌گیری را تکرار کنید و دکمه بلوتوث/حافظه دستگاه را بزنید.');

  // Merge: newest value per field (by device timestamp when present, else arrival order).
  const ordered = readings.map((r, i) => ({ ...r, _t: r.measured_at ? Date.parse(r.measured_at) : Number.MAX_SAFE_INTEGER - (readings.length - i) }))
    .sort((a, b) => a._t - b._t);
  const vitals = {};
  let measuredAt = null;
  const flags = {};
  for (const r of ordered) {
    Object.assign(vitals, toVitals(r));
    if (r.measured_at) measuredAt = r.measured_at;
    for (const f of ['irregular_pulse', 'body_movement', 'cuff_fit_problem']) if (r[f] != null) flags[f] = r[f];
  }
  return { device: name.slice(0, 60), vitals, measured_at: measuredAt, flags };
}
