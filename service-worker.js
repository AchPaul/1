/**
 * GrowHub Service Worker
 * Кэширование статических ресурсов PWA (страницы = site.cpp прошивки).
 */

const CACHE = 'gh-remote-v44';

const ASSETS = [
  './',
  './index.html',
  './profile.html',
  './service.html',
  './reset_all.html',
  './contacts.html',
  './diag.html',
  './setup.html',
  './greenhouses.html',
  './theme.css',
  './plant_config.js',
  './app.js',
  './pwa-bridge.js',
  './mqtt-simple.js',
  './favicon-plant.svg',
  './manifest.json',
];

const STATIC_PATHS = new Set(
  ASSETS.map(a => new URL(a, self.location.href).pathname)
);

function isCacheableRequest(request) {
  try {
    const reqUrl = new URL(request.url);
    if (reqUrl.origin !== self.location.origin) return false;
    const path = reqUrl.pathname;
    if (path.startsWith('/api/')) return false;
    if (STATIC_PATHS.has(path)) return true;
    if (request.mode === 'navigate') {
      const indexPath = new URL('./index.html', self.location.href).pathname;
      return STATIC_PATHS.has(indexPath);
    }
    return false;
  } catch (_e) {
    return false;
  }
}

self.addEventListener('install', e => {
  console.log('[SW] Installing...');
  self.skipWaiting();
  e.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(ASSETS))
      .then(() => console.log('[SW] Assets cached'))
  );
});

self.addEventListener('activate', e => {
  console.log('[SW] Activating...');
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== CACHE).map(k => {
          console.log('[SW] Deleting old cache:', k);
          return caches.delete(k);
        })
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const request = e.request;
  if (request.method !== 'GET') return;
  if (!isCacheableRequest(request)) return;

  e.respondWith(
    caches.match(request).then(cached => {
      if (cached) return cached;
      return fetch(request).then(response => {
        if (!response || response.status !== 200 || response.type === 'opaque') {
          return response;
        }
        const clone = response.clone();
        caches.open(CACHE).then(cache => cache.put(request, clone));
        return response;
      }).catch(() => {
        if (request.mode === 'navigate') {
          return caches.match('./index.html');
        }
        return new Response('Offline', { status: 503, statusText: 'Offline' });
      });
    })
  );
});
