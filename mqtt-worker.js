/**
 * MQTT Shared Worker - единое постоянное соединение для всех вкладок/страниц PWA
 * 
 * Преимущества:
 * - Соединение создаётся ОДИН раз и переиспользуется
 * - Работает даже при переключении между страницами
 * - Автоматическое переподключение при потере связи
 * - Broadcast состояния всем подключённым вкладкам
 * - Кэширование последнего состояния для мгновенной загрузки
 */

console.log('[MQTT Worker] Loading...');

try {
  importScripts('https://unpkg.com/mqtt@5.3.5/dist/mqtt.min.js');
  console.log('[MQTT Worker] MQTT library loaded, version:', typeof mqtt !== 'undefined' ? 'OK' : 'FAILED');
} catch (e) {
  console.error('[MQTT Worker] Failed to load MQTT library:', e);
}

let mqttClient = null;
let connectedPorts = [];
let currentConfig = null;
let lastState = null;
let connectionStatus = 'disconnected';
let publishQueue = []; // Очередь публикаций до установки соединения

// Broadcast сообщения всем подключённым вкладкам
function broadcastToAll(message) {
  connectedPorts.forEach(port => {
    try {
      port.postMessage(message);
    } catch (e) {
      console.error('[MQTT Worker] Failed to broadcast:', e);
    }
  });
}

// Обновление статуса подключения
function updateStatus(status) {
  connectionStatus = status;
  broadcastToAll({ type: 'status', status });
}

// Подключение к MQTT брокеру
function connect(config) {
  console.log('[MQTT Worker] connect() called with config:', { host: config.host, port: config.port, base: config.base });
  
  if (typeof mqtt === 'undefined') {
    console.error('[MQTT Worker] MQTT library not loaded!');
    updateStatus('error');
    return;
  }
  
  if (mqttClient) {
    try {
      mqttClient.end(true);
    } catch (e) {
      console.error('[MQTT Worker] Error ending previous client:', e);
    }
    mqttClient = null;
  }

  currentConfig = config;
  
  // Определяем протокол на основе порта
  // Порты 8883, 8884, 443 - это TLS (wss://)
  // Порт 1883 - незащищённый (ws://)
  const tlsPorts = [8883, 8884, 8885, 443];
  const port = parseInt(config.port);
  const protocol = tlsPorts.includes(port) ? 'wss' : 'ws';
  const url = `${protocol}://${config.host}:${config.port}/mqtt`;
  
  console.log('[MQTT Worker] Connecting to:', url);
  console.log('[MQTT Worker] Base topic:', config.base);
  
  updateStatus('connecting');

  mqttClient = mqtt.connect(url, {
    clientId: 'gh-shared-' + Math.random().toString(16).slice(2),
    username: config.user || undefined,
    password: config.pass || undefined,
    reconnectPeriod: 2000,
    connectTimeout: 10000, // Увеличиваем таймаут до 10 секунд
    keepalive: 30, // Увеличиваем keepalive для нестабильных соединений
    clean: true,
    rejectUnauthorized: false // Для самоподписанных сертификатов
  });

  const stateTopic = config.base + 'state/json';
  const setBase = config.base + 'set/';

  mqttClient.on('connect', () => {
    console.log('[MQTT Worker] Connected to broker');
    updateStatus('connected');
    
    mqttClient.subscribe(stateTopic, { qos: 0 }, (err) => {
      if (err) {
        console.error('[MQTT Worker] Subscribe error:', err);
        updateStatus('error');
      } else {
        console.log('[MQTT Worker] Subscribed to:', stateTopic);
        
        // Обрабатываем очередь накопленных команд
        if (publishQueue.length > 0) {
          console.log('[MQTT Worker] Processing queued publishes:', publishQueue.length);
          const queue = [...publishQueue];
          publishQueue = [];
          
          queue.forEach(({ key, value }) => {
            const topic = setBase + key;
            console.log('[MQTT Worker] Publishing queued:', topic, '=', value);
            mqttClient.publish(topic, String(value), { qos: 0 }, (err) => {
              if (err) {
                console.error('[MQTT Worker] Queued publish error:', err);
              } else {
                broadcastToAll({ type: 'published', key, value });
              }
            });
          });
        }
      }
    });
  });
  
  // Сохраняем setBase для функции publish
  currentConfig.setBase = setBase;

  mqttClient.on('reconnect', () => {
    console.log('[MQTT Worker] Reconnecting...');
    updateStatus('reconnecting');
  });

  mqttClient.on('close', () => {
    console.log('[MQTT Worker] Connection closed');
    updateStatus('disconnected');
  });

  mqttClient.on('offline', () => {
    console.log('[MQTT Worker] Client offline');
    updateStatus('offline');
  });

  mqttClient.on('error', (err) => {
    console.error('[MQTT Worker] MQTT error:', err);
    console.error('[MQTT Worker] Error details:', {
      message: err.message,
      code: err.code,
      errno: err.errno,
      syscall: err.syscall
    });
    
    // Специфичные ошибки для диагностики
    if (err.message && err.message.includes('ECONNREFUSED')) {
      console.error('[MQTT Worker] Connection refused - check broker is running');
    } else if (err.message && err.message.includes('ETIMEDOUT')) {
      console.error('[MQTT Worker] Connection timeout - check firewall/network');
    } else if (err.message && err.message.includes('WebSocket')) {
      console.error('[MQTT Worker] WebSocket error - check protocol (ws vs wss)');
    } else if (err.message && err.message.includes('SSL') || err.message && err.message.includes('TLS')) {
      console.error('[MQTT Worker] TLS/SSL error - check certificate or use ws://');
    }
    
    updateStatus('error');
  });

  mqttClient.on('message', (topic, payload) => {
    if (topic === stateTopic) {
      try {
        const state = JSON.parse(payload.toString());
        lastState = {
          data: state,
          timestamp: Date.now()
        };
        
        // Broadcast новое состояние всем вкладкам
        broadcastToAll({
          type: 'state',
          state: lastState
        });
      } catch (e) {
        console.error('[MQTT Worker] Parse error:', e);
      }
    }
  });

  // Сохраняем setBase для публикации команд
  mqttClient._setBase = setBase;
}

// Публикация команды
function publish(key, value) {
  if (!currentConfig || !currentConfig.setBase) {
    console.error('[MQTT Worker] Cannot publish - no config');
    return false;
  }
  
  // Если не подключены - добавляем в очередь
  if (!mqttClient || !mqttClient.connected) {
    console.warn('[MQTT Worker] Not connected, queueing publish:', key, '=', value);
    publishQueue.push({ key, value });
    
    // Ограничиваем размер очереди
    if (publishQueue.length > 100) {
      publishQueue.shift();
    }
    
    // Сообщаем что команда в очереди
    broadcastToAll({
      type: 'queued',
      key,
      value
    });
    
    return false;
  }
  
  const topic = currentConfig.setBase + key;
  console.log('[MQTT Worker] Publishing:', topic, '=', value);
  
  mqttClient.publish(topic, String(value), { qos: 0 }, (err) => {
    if (err) {
      console.error('[MQTT Worker] Publish error:', err);
    } else {
      console.log('[MQTT Worker] Published successfully');
      broadcastToAll({
        type: 'published',
        key,
        value
      });
    }
  });
  
  return true;
}

// Обработка подключения новой вкладки
self.addEventListener('connect', (event) => {
  const port = event.ports[0];
  connectedPorts.push(port);
  
  console.log('[MQTT Worker] New connection, total ports:', connectedPorts.length);

  // Отправляем текущее состояние сразу при подключении
  if (lastState) {
    port.postMessage({
      type: 'state',
      state: lastState
    });
  }
  
  if (connectionStatus) {
    port.postMessage({
      type: 'status',
      status: connectionStatus
    });
  }

  port.addEventListener('message', (e) => {
    const { type, data } = e.data;

    switch (type) {
      case 'connect':
        connect(data);
        break;

      case 'publish':
        publish(data.key, data.value);
        break;

      case 'disconnect':
        if (mqttClient) {
          mqttClient.end(true);
          mqttClient = null;
          updateStatus('disconnected');
        }
        break;

      case 'request_state':
        // Вкладка запрашивает текущее состояние
        if (lastState) {
          port.postMessage({
            type: 'state',
            state: lastState
          });
        }
        break;
    }
  });

  port.start();

  // Очистка при отключении вкладки
  port.addEventListener('close', () => {
    connectedPorts = connectedPorts.filter(p => p !== port);
    console.log('[MQTT Worker] Port closed, remaining:', connectedPorts.length);
    
    // Если все вкладки закрыты, отключаемся от MQTT
    if (connectedPorts.length === 0 && mqttClient) {
      console.log('[MQTT Worker] No active ports, disconnecting MQTT');
      mqttClient.end(true);
      mqttClient = null;
      lastState = null;
      updateStatus('disconnected');
    }
  });
});

console.log('[MQTT Worker] Initialized');
