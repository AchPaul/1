/**
 * GrowHub Service Worker
 * Обеспечивает:
 * - Кэширование статических ресурсов для офлайн-работы
 * - Push-уведомления (Web Push API)
 * - Обработка кликов по уведомлениям
 */

// Версия кэша - увеличивайте при обновлении ресурсов
const CACHE = 'gh-remote-v31';

// Статические ресурсы для кэширования
const ASSETS = [
  './',
  './index.html',
  './state.html',
  './settings.html',
  './profile.html',
  './service.html',
  './time.html',
  './ap.html',
  './name.html',
  './contacts.html',
  './notifications.html',
  './app.js',
  './mqtt-simple.js',
  './push-notifications.js',
  './favicon-plant.svg',
  './manifest.json'
];

// ============================================================================
// LIFECYCLE EVENTS
// ============================================================================

self.addEventListener('install', e => {
  console.log('[SW] Installing...');
  self.skipWaiting(); // Немедленно активировать новый SW
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
      .then(() => self.clients.claim()) // Немедленно контролировать все открытые вкладки
      .then(() => console.log('[SW] Activated and claimed clients'))
  );
});

// ============================================================================
// FETCH EVENTS (Caching Strategy: Cache First, Network Fallback)
// ============================================================================

self.addEventListener('fetch', e => {
  const { request } = e;
  
  // Пропускаем не-GET запросы
  if (request.method !== 'GET') return;
  
  // Пропускаем WebSocket и MQTT соединения
  if (request.url.includes('ws://') || request.url.includes('wss://')) return;
  
  e.respondWith(
    caches.match(request)
      .then(cached => {
        if (cached) {
          // Возвращаем кэш, но обновляем в фоне
          fetch(request)
            .then(response => {
              if (response && response.status === 200) {
                caches.open(CACHE).then(cache => cache.put(request, response));
              }
            })
            .catch(() => {}); // Игнорируем ошибки фонового обновления
          return cached;
        }
        
        // Нет в кэше - запрашиваем из сети
        return fetch(request)
          .then(response => {
            // Кэшируем успешные ответы
            if (response && response.status === 200) {
              const responseClone = response.clone();
              caches.open(CACHE).then(cache => cache.put(request, responseClone));
            }
            return response;
          })
          .catch(() => {
            // Офлайн fallback на главную страницу
            if (request.mode === 'navigate') {
              return caches.match('./index.html');
            }
            return new Response('Offline', { status: 503, statusText: 'Service Unavailable' });
          });
      })
  );
});

// ============================================================================
// PUSH EVENTS (Web Push API)
// ============================================================================

self.addEventListener('push', e => {
  console.log('[SW] Push received');
  
  let data = {
    title: 'GrowHub',
    body: 'Новое уведомление',
    icon: './favicon-plant.svg',
    badge: './favicon-plant.svg',
    tag: 'growhub-default',
    data: { url: './' }
  };
  
  // Парсим данные из push если есть
  if (e.data) {
    try {
      const payload = e.data.json();
      data = { ...data, ...payload };
      console.log('[SW] Push payload:', payload);
    } catch (err) {
      // Fallback на текстовые данные
      const text = e.data.text();
      if (text) {
        data.body = text;
      }
    }
  }
  
  // Маппинг типов алертов GrowHub
  const alertMappings = {
    alert_water: { title: '⚠️ Бак для воды пуст!', body: 'Требуется дозаправка бака для полива.', tag: 'growhub-water' },
    alert_humid: { title: '⚠️ Увлажнитель пуст!', body: 'Требуется дозаправка увлажнителя.', tag: 'growhub-humid' },
    alert_high_temp: { title: '🌡️ Слишком жарко!', body: 'Температура превышает допустимую норму.', tag: 'growhub-temp-high' },
    alert_low_temp: { title: '❄️ Слишком холодно!', body: 'Температура ниже допустимой нормы.', tag: 'growhub-temp-low' },
    err_sensor_temp: { title: '⚠️ Ошибка датчика температуры', body: 'Датчик температуры не отвечает.', tag: 'growhub-sensor-temp' },
    err_sensor_hg: { title: '⚠️ Ошибка датчика влажности', body: 'Датчик влажности почвы не отвечает.', tag: 'growhub-sensor-hg' },
    err_sensor_dht: { title: '⚠️ Ошибка датчика DHT', body: 'Датчик влажности воздуха не отвечает.', tag: 'growhub-sensor-dht' },
    rebooted: { title: '⚡ Теплица перезагружена', body: 'Требуется настройка времени.', tag: 'growhub-reboot' }
  };
  
  if (data.type && alertMappings[data.type]) {
    const mapped = alertMappings[data.type];
    data.title = mapped.title;
    data.body = data.message || mapped.body;
    data.tag = mapped.tag;
  }
  
  const options = {
    body: data.body,
    icon: data.icon || './favicon-plant.svg',
    badge: data.badge || './favicon-plant.svg',
    tag: data.tag || 'growhub-notification',
    vibrate: [200, 100, 200],
    requireInteraction: data.requireInteraction || false,
    renotify: true,
    data: {
      url: data.url || data.data?.url || './',
      type: data.type,
      timestamp: Date.now()
    },
    actions: data.actions || []
  };
  
  // Добавляем действия для определенных типов уведомлений
  if (data.type === 'alert_water' || data.type === 'alert_humid') {
    options.actions = [
      { action: 'refill', title: '✓ Залито', icon: './favicon-plant.svg' },
      { action: 'dismiss', title: 'Закрыть' }
    ];
    options.requireInteraction = true;
  }
  
  e.waitUntil(
    self.registration.showNotification(data.title, options)
      .then(() => {
        // Уведомляем все открытые окна о получении push
        return self.clients.matchAll({ type: 'window' });
      })
      .then(clients => {
        clients.forEach(client => {
          client.postMessage({
            type: 'PUSH_RECEIVED',
            payload: data
          });
        });
      })
  );
});

// ============================================================================
// NOTIFICATION CLICK EVENTS
// ============================================================================

self.addEventListener('notificationclick', e => {
  console.log('[SW] Notification clicked:', e.action);
  
  const notification = e.notification;
  const data = notification.data || {};
  
  notification.close();
  
  // Обработка действий
  if (e.action === 'refill') {
    // Отправляем команду refill через MQTT
    e.waitUntil(
      self.clients.matchAll({ type: 'window' })
        .then(clients => {
          if (clients.length > 0) {
            // Отправляем сообщение в активное окно
            const refillType = data.type === 'alert_water' ? 'water' : 'humid';
            clients[0].postMessage({
              type: 'REFILL_ACTION',
              payload: { refillType }
            });
            clients[0].focus();
          }
        })
    );
    return;
  }
  
  if (e.action === 'dismiss') {
    return; // Просто закрываем
  }
  
  // Открываем или фокусируем окно приложения
  const urlToOpen = data.url || './';
  
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      .then(clientList => {
        // Ищем уже открытое окно
        for (const client of clientList) {
          if (client.url.includes(self.registration.scope) && 'focus' in client) {
            client.postMessage({
              type: 'NOTIFICATION_CLICKED',
              payload: data
            });
            return client.focus();
          }
        }
        
        // Открываем новое окно если нет открытых
        if (self.clients.openWindow) {
          return self.clients.openWindow(urlToOpen);
        }
      })
  );
});

// ============================================================================
// NOTIFICATION CLOSE EVENTS
// ============================================================================

self.addEventListener('notificationclose', e => {
  console.log('[SW] Notification closed:', e.notification.tag);
  
  // Можно отправлять аналитику или логировать закрытие
  const data = e.notification.data || {};
  
  e.waitUntil(
    self.clients.matchAll({ type: 'window' })
      .then(clients => {
        clients.forEach(client => {
          client.postMessage({
            type: 'NOTIFICATION_CLOSED',
            payload: {
              tag: e.notification.tag,
              type: data.type
            }
          });
        });
      })
  );
});

// ============================================================================
// PUSH SUBSCRIPTION CHANGE
// ============================================================================

self.addEventListener('pushsubscriptionchange', e => {
  console.log('[SW] Push subscription changed');
  
  e.waitUntil(
    self.registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: e.oldSubscription?.options?.applicationServerKey
    })
    .then(subscription => {
      // Уведомляем приложение о новой подписке
      return self.clients.matchAll({ type: 'window' })
        .then(clients => {
          clients.forEach(client => {
            client.postMessage({
              type: 'SUBSCRIPTION_CHANGED',
              payload: subscription.toJSON()
            });
          });
        });
    })
    .catch(err => {
      console.error('[SW] Failed to resubscribe:', err);
    })
  );
});

// ============================================================================
// MESSAGE HANDLING (from main thread)
// ============================================================================

self.addEventListener('message', e => {
  console.log('[SW] Message received:', e.data);
  
  if (e.data && e.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
  
  if (e.data && e.data.type === 'GET_SUBSCRIPTION') {
    e.waitUntil(
      self.registration.pushManager.getSubscription()
        .then(subscription => {
          e.source.postMessage({
            type: 'SUBSCRIPTION_STATUS',
            payload: subscription ? subscription.toJSON() : null
          });
        })
    );
  }
  
  if (e.data && e.data.type === 'SHOW_NOTIFICATION') {
    const { title, options } = e.data.payload;
    e.waitUntil(
      self.registration.showNotification(title, options)
    );
  }
});

