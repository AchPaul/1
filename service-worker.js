// Basic cache for static assets; MQTT data is real-time and not cached.
const CACHE = 'gh-remote-v25';
const ASSETS = [
  './',
  './index.html',
  './state.html',
  './settings.html',
  './profile.html',
  './service.html',
  './telegram.html',
  './mqtt-simple.js',
  './app.js',
  './favicon-plant.svg',
  './manifest.json'
];
self.addEventListener('install', e => {
  self.skipWaiting(); // Немедленно активировать новый SW
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)));
});
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k))))
      .then(() => self.clients.claim()) // Немедленно контролировать все открытые вкладки
  );
});
self.addEventListener('fetch', e => {
  const { request } = e;
  if(request.method !== 'GET') return;
  e.respondWith(
    caches.match(request).then(r => r || fetch(request).catch(()=> caches.match('./index.html')))
  );
});
