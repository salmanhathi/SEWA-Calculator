const CACHE_NAME = 'sewa-tracker-v3';
const ASSETS = [
  './', './index.html', './styles.css', './app.js', './parser.js', './manifest.json',
  './icons/icon-192.png', './icons/icon-512.png',
  './lib/pdf.min.js', './lib/pdf.worker.min.js', './lib/xlsx.full.min.js'
];
self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE_NAME).then(c => Promise.all(ASSETS.map(u => c.add(u).catch(() => {})))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  e.respondWith(caches.match(e.request).then(cached => cached || fetch(e.request).then(res => {
    if (res && res.status === 200) { const copy = res.clone(); caches.open(CACHE_NAME).then(c => c.put(e.request, copy)).catch(() => {}); }
    return res;
  }).catch(() => cached)));
});
