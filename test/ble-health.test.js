import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sfloat, parse, toVitals, SERVICES } from '../public/ble-health.js';

const dv = (bytes) => new DataView(Uint8Array.from(bytes).buffer);
const u16 = (n) => [n & 0xff, (n >> 8) & 0xff];

test('IEEE-11073 SFLOAT decoding incl. negative exponent and NaN', () => {
  assert.equal(sfloat(0x0078), 120);
  assert.equal(sfloat(0xf0a0), 16);
  assert.equal(sfloat(0x07ff), null);
});

test('Blood Pressure Measurement (0x2A35) with timestamp, pulse and status', () => {
  const pkt = [0x16, ...u16(120), ...u16(80), ...u16(93), ...u16(2026), 10, 5, 9, 30, 0, ...u16(72), ...u16(0x0004)];
  const m = parse(SERVICES.bp.chars[0], dv(pkt));
  assert.equal(m.kind, 'bp');
  assert.equal(m.sys, 120);
  assert.equal(m.dia, 80);
  assert.equal(m.hr, 72);
  assert.equal(m.irregular_pulse, true);
  assert.equal(new Date(m.measured_at).getFullYear(), 2026);
});

test('Blood pressure reported in kPa is converted to mmHg', () => {
  const m = parse(SERVICES.bp.chars[0], dv([0x01, ...u16(0xf0a0), ...u16(0xf06b), ...u16(0x07ff)])); // 16.0 / 10.7 kPa
  assert.equal(m.sys, 120);
  assert.equal(m.dia, 80);
});

test('Pulse oximeter spot-check (0x2A5E) and continuous (0x2A5F)', () => {
  assert.deepEqual(toVitals(parse(SERVICES.plx.chars[0], dv([0x00, ...u16(97), ...u16(70)]))), { hr: 70, spo2: 97 });
  assert.deepEqual(toVitals(parse(SERVICES.plx.chars[1], dv([0x00, ...u16(91), ...u16(110)]))), { hr: 110, spo2: 91 });
});

test('Health thermometer (0x2A1C) in °C and °F', () => {
  assert.equal(parse(SERVICES.temp.chars[0], dv([0x00, 0x74, 0x01, 0x00, 0xff])).temp_c, 37.2);
  assert.equal(parse(SERVICES.temp.chars[0], dv([0x01, 0xda, 0x03, 0x00, 0xff])).temp_c, 37);
});

test('Heart rate (0x2A37) uint8/uint16 and implausible values are dropped', () => {
  assert.equal(parse(SERVICES.hr.chars[0], dv([0x00, 75])).hr, 75);
  assert.deepEqual(toVitals(parse(SERVICES.hr.chars[0], dv([0x01, ...u16(300)]))), {});
  assert.deepEqual(toVitals({ sys: null, dia: 80, spo2: null }), {});
});
