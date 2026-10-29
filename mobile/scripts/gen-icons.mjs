// Renders the app icon / splash PNGs (web PWA + Android launcher + splash) from the brand SVGs in
// public/brand with headless Chromium. Run after changing the brand: `npm run icons`.
import { createRequire } from 'node:module';
import { writeFileSync, readFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); } catch {
  ({ chromium } = createRequire('/opt/node22/lib/node_modules/')('playwright'));
}

// Darman Plus palette
const NAVY = '#0B3D91';
const BLUE = '#1976D2';
const GREEN = '#00B894';
const BG = '#F4F7FA';
const root = fileURLToPath(new URL('../..', import.meta.url));
const pub = join(root, 'public');
const res = join(root, 'mobile/android/app/src/main/res');
const pngSize = (f) => { const b = readFileSync(f); return [b.readUInt32BE(16), b.readUInt32BE(20)]; };
const dataUrl = (f, type) => `data:${type};base64,${readFileSync(f).toString('base64')}`;

const browser = await chromium.launch();
const page = await browser.newPage();
await page.setContent(`<style>
  @font-face { font-family: V; font-weight: 900; src: url(${dataUrl(join(pub, 'fonts/vazirmatn-arabic-900-normal.woff2'), 'font/woff2')}); }
  @font-face { font-family: VL; font-weight: 700; src: url(${dataUrl(join(pub, 'fonts/vazirmatn-latin-700-normal.woff2'), 'font/woff2')}); }
</style><canvas id="c"></canvas>`);
await page.evaluate(async ({ color, white }) => {
  const load = (src) => new Promise((ok, fail) => { const i = new Image(); i.onload = () => ok(i); i.onerror = fail; i.src = src; });
  window.marks = { color: await load(color), white: await load(white) };
  await Promise.all([document.fonts.load('900 40px V', 'درمان'), document.fonts.load('700 20px VL', 'DARMAN')]);
}, { color: dataUrl(join(pub, 'brand/mark.svg'), 'image/svg+xml'), white: dataUrl(join(pub, 'brand/mark-white.svg'), 'image/svg+xml') });

// kind: 'square' (rounded tile), 'round', 'full' (edge-to-edge tile, maskable), 'fg' (mark only, adaptive), 'splash'
async function render(file, w, h, kind) {
  const data = await page.evaluate(({ w, h, kind, NAVY, BLUE, GREEN, BG }) => {
    const c = document.getElementById('c');
    c.width = w; c.height = h;
    const g = c.getContext('2d');
    g.clearRect(0, 0, w, h);
    const s = Math.min(w, h);
    const grad = () => { const gr = g.createLinearGradient(0, 0, w, h); gr.addColorStop(0, BLUE); gr.addColorStop(1, GREEN); return gr; };
    const mark = (img, cx, cy, size) => g.drawImage(img, cx - size / 2, cy - size / 2, size, size);
    if (kind === 'square') {
      g.fillStyle = grad(); g.beginPath(); g.roundRect(0, 0, s, s, s * 0.22); g.fill();
      mark(marks.white, w / 2, h / 2, s * 0.74);
    } else if (kind === 'full') { g.fillStyle = grad(); g.fillRect(0, 0, w, h); mark(marks.white, w / 2, h / 2, s * 0.6); }
    else if (kind === 'round') { g.fillStyle = grad(); g.beginPath(); g.arc(w / 2, h / 2, s / 2, 0, Math.PI * 2); g.fill(); mark(marks.white, w / 2, h / 2, s * 0.66); }
    else if (kind === 'fg') { mark(marks.white, w / 2, h / 2, s * 0.56); }
    else if (kind === 'splash') {
      g.fillStyle = BG; g.fillRect(0, 0, w, h);
      const m = s * 0.34;
      const top = h / 2 - m * 0.75;
      mark(marks.color, w / 2, top, m);
      // Word mark: «درمان» navy, «پلاس» green, as in the logo.
      const fs = m * 0.36;
      g.font = `900 ${fs}px V`; g.direction = 'rtl'; g.textBaseline = 'alphabetic'; g.textAlign = 'right';
      const a = 'درمان', b = 'پلاس', gap = fs * 0.28;
      const wa = g.measureText(a).width, wb = g.measureText(b).width;
      const x = w / 2 + (wa + gap + wb) / 2, y = top + m * 0.5 + fs * 1.15;
      g.fillStyle = NAVY; g.fillText(a, x, y);
      g.fillStyle = GREEN; g.fillText(b, x - wa - gap, y);
      g.direction = 'ltr'; g.textAlign = 'center'; g.font = `700 ${fs * 0.34}px VL`; g.letterSpacing = `${fs * 0.12}px`;
      g.fillStyle = NAVY; g.fillText('DARMAN PLUS', w / 2, y + fs * 0.75);
      g.letterSpacing = '0px';
    }
    return c.toDataURL('image/png').split(',')[1];
  }, { w, h, kind, NAVY, BLUE, GREEN, BG });
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, Buffer.from(data, 'base64'));
}

// PWA
const icons = join(pub, 'icons');
await render(join(icons, 'icon-192.png'), 192, 192, 'square');
await render(join(icons, 'icon-512.png'), 512, 512, 'square');
await render(join(icons, 'maskable-512.png'), 512, 512, 'full');
await render(join(icons, 'apple-touch-icon.png'), 180, 180, 'full');
await render(join(pub, 'brand/splash.png'), 1280, 1920, 'splash');

// Android (sizes taken from the generated Capacitor project)
if (existsSync(res)) {
  for (const dir of readdirSync(res)) {
    for (const [name, kind] of [['ic_launcher.png', 'square'], ['ic_launcher_round.png', 'round'], ['ic_launcher_foreground.png', 'fg'], ['splash.png', 'splash']]) {
      const f = join(res, dir, name);
      if (existsSync(f)) { const [w, h] = pngSize(f); await render(f, w, h, kind); }
    }
  }
  writeFileSync(join(res, 'values/ic_launcher_background.xml'),
    `<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="ic_launcher_background">${BLUE}</color>\n</resources>\n`);
  // Adaptive icon background: the same blue→green gradient as the tile.
  writeFileSync(join(res, 'drawable/ic_launcher_brand_bg.xml'),
    `<?xml version="1.0" encoding="utf-8"?>\n<shape xmlns:android="http://schemas.android.com/apk/res/android" android:shape="rectangle">\n    <gradient android:type="linear" android:angle="315" android:startColor="${BLUE}" android:endColor="${GREEN}" />\n</shape>\n`);
  for (const f of ['ic_launcher.xml', 'ic_launcher_round.xml']) {
    const p = join(res, 'mipmap-anydpi-v26', f);
    if (existsSync(p)) writeFileSync(p, readFileSync(p, 'utf8').replace('@color/ic_launcher_background', '@drawable/ic_launcher_brand_bg'));
  }
}
await browser.close();
console.log('icons generated');
