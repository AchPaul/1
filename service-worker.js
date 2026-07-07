/**
 * GrowHub Service Worker
 * HTML/JS — network-first (актуальная логика с сервера).
 * CSS — stale-while-revalidate (офлайн + свежие стили онлайн).
 * Иконки/manifest — cache-first (офлайн).
 */
// BUILD_ID: local-dev

const CACHE = 'gh-remote-v62';

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
  './mqtt-cache.js',
  './app.js',
  './pwa-bridge.js',
  './pwa-handoff.js',
  './mqtt-simple.js',
  './mqtt-shared-worker.js',
  './vendor/mqtt.min.js',
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

function wantsNetworkFirst(request) {
  if (request.mode === 'navigate') return true;
  try {
    const path = new URL(request.url).pathname;
    return path.endsWith('.js') || path.endsWith('.html');
  } catch (_e) {
    return false;
  }
}

function wantsStaleWhileRevalidate(request) {
  try {
    const path = new URL(request.url).pathname;
    return path.endsWith('.css');
  } catch (_e) {
    return false;
  }
}

function putInCache(request, response) {
  if (!response || response.status !== 200 || response.type === 'opaque') return;
  const clone = response.clone();
  caches.open(CACHE).then(cache => cache.put(request, clone));
}

function offlineFallback(request) {
  if (request.mode === 'navigate') {
    return caches.match('./index.html');
  }
  return new Response('Offline', { status: 503, statusText: 'Offline' });
}

function networkFirst(request) {
  return fetch(request, { cache: 'no-store' })
    .then(response => {
      putInCache(request, response);
      return response;
    })
    .catch(() => caches.match(request).then(cached => cached || offlineFallback(request)));
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(request);
  const fetchAndUpdate = fetch(request, { cache: 'no-store' })
    .then(response => {
      if (response && response.status === 200 && response.type !== 'opaque') {
        cache.put(request, response.clone());
      }
      return response;
    });

  if (cached) {
    fetchAndUpdate.catch(() => {});
    return cached;
  }

  try {
    const response = await fetchAndUpdate;
    if (response) return response;
  } catch (_e) {}

  return offlineFallback(request);
}

function cacheFirst(request) {
  return caches.match(request).then(cached => {
    if (cached) return cached;
    return fetch(request).then(response => {
      putInCache(request, response);
      return response;
    }).catch(() => offlineFallback(request));
  });
}

function pickFetchStrategy(request) {
  if (wantsNetworkFirst(request)) return networkFirst(request);
  if (wantsStaleWhileRevalidate(request)) return staleWhileRevalidate(request);
  return cacheFirst(request);
}

async function precacheAssets(cache) {
  await Promise.all(ASSETS.map(async (url) => {
    try {
      const response = await fetch(url, { cache: 'no-store' });
      if (response.ok) await cache.put(url, response);
    } catch (e) {
      console.warn('[SW] precache failed:', url, e);
    }
  }));
}

self.addEventListener('install', e => {
  console.log('[SW] Installing', CACHE);
  self.skipWaiting();
  e.waitUntil(
    caches.open(CACHE)
      .then(cache => precacheAssets(cache))
      .then(() => console.log('[SW] Assets precached'))
  );
});

self.addEventListener('activate', e => {
  console.log('[SW] Activating', CACHE);
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

self.addEventListener('message', e => {
  if (e.data && e.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

self.addEventListener('fetch', e => {
  const request = e.request;
  if (request.method !== 'GET') return;
  if (!isCacheableRequest(request)) return;

  e.respondWith(pickFetchStrategy(request));
});
