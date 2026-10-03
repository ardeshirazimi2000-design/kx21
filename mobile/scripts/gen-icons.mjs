// Renders the app icon / splash PNGs (web PWA + Android launcher + splash) with headless
// Chromium. Run once after changing the brand: `npm run icons` (needs Playwright installed).
import { createRequire } from 'node:module';
import { writeFileSync, readFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); } catch {
  ({ chromium } = createRequire('/opt/node22/lib/node_modules/')('playwright'));
}

const BRAND = '#0f766e';
const BG = '#f5f7f8';
const root = fileURLToPath(new URL('../..', import.meta.url));
const res = join(root, 'mobile/android/app/src/main/res');
const pngSize = (f) => { const b = readFileSync(f); return [b.readUInt32BE(16), b.readUInt32BE(20)]; };

const browser = await chromium.launch();
const page = await browser.newPage();
await page.setContent('<canvas id="c"></canvas>');

// kind: 'square' (rounded tile), 'round', 'full' (edge-to-edge tile, maskable), 'fg' (cross only, adaptive), 'splash'
async function render(file, w, h, kind) {
  const data = await page.evaluate(({ w, h, kind, BRAND, BG }) => {
    const c = document.getElementById('c');
    c.width = w; c.height = h;
    const g = c.getContext('2d');
    g.clearRect(0, 0, w, h);
    const s = Math.min(w, h);
    const cross = (cx, cy, size, color) => {
      // Same geometry as public/icon.svg (64-unit grid: arms 10 wide, 36 long).
      const u = size / 64;
      g.fillStyle = color;
      g.fillRect(cx - 5 * u, cy - 18 * u, 10 * u, 36 * u);
      g.fillRect(cx - 18 * u, cy - 5 * u, 36 * u, 10 * u);
    };
    const tile = (x, y, size, r) => {
      g.fillStyle = BRAND;
      g.beginPath();
      g.roundRect(x, y, size, size, r);
      g.fill();
    };
    if (kind === 'square') { tile(0, 0, s, s * 0.22); cross(w / 2, h / 2, s, '#fff'); }
    else if (kind === 'full') { g.fillStyle = BRAND; g.fillRect(0, 0, w, h); cross(w / 2, h / 2, s * 0.72, '#fff'); }
    else if (kind === 'round') { g.fillStyle = BRAND; g.beginPath(); g.arc(w / 2, h / 2, s / 2, 0, Math.PI * 2); g.fill(); cross(w / 2, h / 2, s, '#fff'); }
    else if (kind === 'fg') { cross(w / 2, h / 2, s * 0.62, '#fff'); }
    else if (kind === 'splash') {
      g.fillStyle = BG; g.fillRect(0, 0, w, h);
      const t = s * 0.3;
      tile(w / 2 - t / 2, h / 2 - t / 2, t, t * 0.22);
      cross(w / 2, h / 2, t, '#fff');
    }
    return c.toDataURL('image/png').split(',')[1];
  }, { w, h, kind, BRAND, BG });
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, Buffer.from(data, 'base64'));
}

// PWA
const icons = join(root, 'public/icons');
await render(join(icons, 'icon-192.png'), 192, 192, 'square');
await render(join(icons, 'icon-512.png'), 512, 512, 'square');
await render(join(icons, 'maskable-512.png'), 512, 512, 'full');
await render(join(icons, 'apple-touch-icon.png'), 180, 180, 'full');

// Android (sizes taken from the generated Capacitor project)
if (existsSync(res)) {
  for (const dir of readdirSync(res)) {
    for (const [name, kind] of [['ic_launcher.png', 'square'], ['ic_launcher_round.png', 'round'], ['ic_launcher_foreground.png', 'fg'], ['splash.png', 'splash']]) {
      const f = join(res, dir, name);
      if (existsSync(f)) { const [w, h] = pngSize(f); await render(f, w, h, kind); }
    }
  }
  writeFileSync(join(res, 'values/ic_launcher_background.xml'),
    `<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="ic_launcher_background">${BRAND.toUpperCase()}</color>\n</resources>\n`);
}
await browser.close();
console.log('icons generated');
