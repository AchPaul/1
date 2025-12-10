// Basic cache for static assets; MQTT data is real-time and not cached.
const CACHE = 'gh-remote-v29';
const ASSETS = [
  './',
  './index.html',
  './state.html',
  './settings.html',
  './profile.html',
  './service.html',
  './telegram.html',
  './time.html',
  './ap.html',
  './name.html',
  './contacts.html',
  './app.js',
  './mqtt-simple.js',
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

// Handle messages from main app (for notifications)
self.addEventListener('message', event => {
  if (event.data && event.data.type === 'SHOW_NOTIFICATION') {
    const {title, options} = event.data;
    self.registration.showNotification(title, options);
  }
});

// Handle notification clicks
self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({type: 'window', includeUncontrolled: true}).then(clientList => {
      // Focus existing window if available
      for (let client of clientList) {
        if (client.url.includes(self.location.origin) && 'focus' in client) {
          return client.focus();
        }
      }
      // Otherwise open new window
      if (clients.openWindow) {
        return clients.openWindow('/');
      }
    })
  );
});
