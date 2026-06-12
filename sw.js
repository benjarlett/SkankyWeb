const CACHE = 'skanky-v6';
const SHELL = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './db.js',
  './player.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/speaker-green.svg',
  './icons/speaker-red.svg',
  './icons/spotify.svg',
  './icons/youtube.svg',
  './icons/bass-hero.png',
  'https://cdn.jsdelivr.net/npm/soundtouch-js@0.1.1/dist/soundtouch.esm.js',
  'https://cdn.jsdelivr.net/npm/fuse.js@7.0.0/dist/fuse.min.js',
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  // Only handle GET requests for http(s)
  if (e.request.method !== 'GET' || !e.request.url.startsWith('http')) return;

  e.respondWith(
    caches.match(e.request).then(cached => {
      if (cached) return cached;
      return fetch(e.request).then(res => {
        // Don't cache non-successful or opaque responses for app shell
        if (!res || res.status !== 200 || res.type === 'opaque') return res;
        const clone = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, clone));
        return res;
      }).catch(() => cached); // Offline fallback
    })
  );
});
