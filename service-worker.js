// Basic cache for static assets; MQTT data is real-time and not cached.
const CACHE = 'gh-remote-v3';
const ASSETS = [
  './',
  './index.html',
  './app.js',
  './manifest.json'
];
self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)));
});
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k))))
  );
});
self.addEventListener('fetch', e => {
  const { request } = e;
  if(request.method !== 'GET') return;
  e.respondWith(
    caches.match(request).then(r => r || fetch(request).catch(()=> caches.match('./index.html')))
  );
});
