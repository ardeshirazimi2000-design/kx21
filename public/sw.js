// Service worker: caches the app shell so the PWA opens instantly and offline.
// API calls (/v1) always go to the network — health data is never cached on the device.
const CACHE = 'clinic-shell-v5';
const SHELL = ['/', '/index.html', '/app.js', '/triage-wizard.js', '/jalali.js', '/ble-health.js', '/video-call.js', '/config.js', '/styles.css', '/icon.svg', '/manifest.webmanifest', '/icons/icon-192.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/v1/') || url.pathname === '/healthz') return;
  // Network first (fresh code after deploys), cache as fallback.
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
        return res;
      })
      .catch(() => caches.match(e.request).then((r) => r || caches.match('/index.html'))),
  );
});
