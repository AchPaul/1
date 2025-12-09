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

importScripts('https://unpkg.com/mqtt@5.3.5/dist/mqtt.min.js');

let mqttClient = null;
let connectedPorts = [];
let currentConfig = null;
let lastState = null;
let connectionStatus = 'disconnected';

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
  if (mqttClient) {
    try {
      mqttClient.end(true);
    } catch (e) {
      console.error('[MQTT Worker] Error ending previous client:', e);
    }
    mqttClient = null;
  }

  currentConfig = config;
  const url = `wss://${config.host}:${config.port}/mqtt`;
  
  updateStatus('connecting');
  
  mqttClient = mqtt.connect(url, {
    clientId: 'gh-shared-' + Math.random().toString(16).slice(2),
    username: config.user || undefined,
    password: config.pass || undefined,
    reconnectPeriod: 2000,
    connectTimeout: 5000,
    keepalive: 20,
    clean: true
  });

  const stateTopic = config.base + 'state/json';
  const setBase = config.base + 'set/';

  mqttClient.on('connect', () => {
    updateStatus('connected');
    mqttClient.subscribe(stateTopic, { qos: 0 }, (err) => {
      if (err) {
        console.error('[MQTT Worker] Subscribe error:', err);
        updateStatus('error');
      }
    });
  });

  mqttClient.on('reconnect', () => {
    updateStatus('reconnecting');
  });

  mqttClient.on('close', () => {
    updateStatus('disconnected');
  });

  mqttClient.on('offline', () => {
    updateStatus('offline');
  });

  mqttClient.on('error', (err) => {
    console.error('[MQTT Worker] MQTT error:', err);
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
  if (!mqttClient || !mqttClient.connected) {
    console.warn('[MQTT Worker] Not connected, cannot publish');
    return false;
  }

  const topic = mqttClient._setBase + key;
  mqttClient.publish(topic, String(value));
  
  broadcastToAll({
    type: 'published',
    key,
    value
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
