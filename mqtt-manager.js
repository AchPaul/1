/**
 * MQTT Client Manager - обёртка для работы с Shared Worker
 * 
 * Использование:
 * 
 * import MQTTManager from './mqtt-manager.js';
 * 
 * const mqtt = new MQTTManager();
 * 
 * mqtt.on('state', (state) => {
 *   console.log('New state:', state);
 *   updateUI(state);
 * });
 * 
 * mqtt.on('status', (status) => {
 *   console.log('Connection status:', status);
 * });
 * 
 * mqtt.connect({ host, port, user, pass, base });
 * mqtt.publish('lig_hours', 12);
 */

class MQTTManager extends EventTarget {
  constructor() {
    super();
    this.worker = null;
    this.connected = false;
    this.lastState = null;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 5;
    
    this._initWorker();
    this._setupVisibilityHandling();
  }

  _initWorker() {
    // Проверка поддержки SharedWorker
    if (typeof SharedWorker === 'undefined') {
      console.error('[MQTT Manager] SharedWorker not supported in this browser!');
      console.log('[MQTT Manager] User Agent:', navigator.userAgent);
      console.log('[MQTT Manager] Platform:', navigator.platform);
      this._dispatchEvent('status', 'error');
      this._dispatchEvent('error', new Error('SharedWorker not supported. Please use Chrome 120+ or another browser.'));
      return;
    }
    
    try {
      console.log('[MQTT Manager] Initializing SharedWorker...');
      
      // Используем Shared Worker для постоянного соединения
      this.worker = new SharedWorker('mqtt-worker.js');
      
      console.log('[MQTT Manager] SharedWorker created successfully');
      
      this.worker.port.addEventListener('message', (event) => {
        const { type, status, state, key, value } = event.data;

        switch (type) {
          case 'status':
            this.connected = status === 'connected';
            this._dispatchEvent('status', status);
            
            // Сброс счётчика при успешном подключении
            if (status === 'connected') {
              this.reconnectAttempts = 0;
            }
            break;

          case 'state':
            this.lastState = state;
            this._dispatchEvent('state', state.data);
            this._dispatchEvent('stateTimestamp', state.timestamp);
            
            // Кэшируем в localStorage для мгновенной загрузки
            this._cacheState(state);
            break;

          case 'published':
            this._dispatchEvent('published', { key, value });
            break;
            
          case 'queued':
            this._dispatchEvent('queued', { key, value });
            break;
        }
      });

      this.worker.port.start();
      console.log('[MQTT Manager] Port started');
      
      // Обработка ошибок worker
      this.worker.addEventListener('error', (e) => {
        console.error('[MQTT Manager] Worker error:', e);
        console.error('[MQTT Manager] Error details:', e.message, e.filename, e.lineno);
        this._dispatchEvent('error', e);
      });
      
      // Обработка ошибок порта
      this.worker.port.addEventListener('messageerror', (e) => {
        console.error('[MQTT Manager] Port message error:', e);
      });
      
      // Запрашиваем текущее состояние при инициализации
      setTimeout(() => this._requestState(), 100);
      
      // Пытаемся загрузить кэшированное состояние для мгновенного отображения
      this._loadCachedState();
      
    } catch (error) {
      console.error('[MQTT Manager] Failed to initialize Shared Worker:', error);
      console.error('[MQTT Manager] Error stack:', error.stack);
      this._dispatchEvent('status', 'error');
      this._dispatchEvent('error', error);
    }
  }

  _setupVisibilityHandling() {
    // Обработка visibility change - запрашиваем свежие данные при возврате на вкладку
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        console.log('[MQTT Manager] Tab visible, requesting fresh state');
        this._requestState();
      }
    });

    // Обработка online/offline событий браузера
    window.addEventListener('online', () => {
      console.log('[MQTT Manager] Browser online');
      this._dispatchEvent('status', 'reconnecting');
    });

    window.addEventListener('offline', () => {
      console.log('[MQTT Manager] Browser offline');
      this._dispatchEvent('status', 'offline');
    });
  }

  _dispatchEvent(eventName, data) {
    const event = new CustomEvent(eventName, { detail: data });
    this.dispatchEvent(event);
  }

  _requestState() {
    if (this.worker && this.worker.port) {
      this.worker.port.postMessage({ type: 'request_state' });
    }
  }

  _cacheState(state) {
    try {
      localStorage.setItem('gh_mqtt_state_cache', JSON.stringify({
        data: state.data,
        timestamp: state.timestamp,
        cachedAt: Date.now()
      }));
    } catch (e) {
      console.warn('[MQTT Manager] Failed to cache state:', e);
    }
  }

  _loadCachedState() {
    try {
      const cached = localStorage.getItem('gh_mqtt_state_cache');
      if (cached) {
        const parsed = JSON.parse(cached);
        
        // Проверяем свежесть кэша (не старше 5 минут)
        const age = Date.now() - parsed.cachedAt;
        if (age < 5 * 60 * 1000) {
          this.lastState = {
            data: parsed.data,
            timestamp: parsed.timestamp
          };
          
          // Отправляем кэшированное состояние сразу для мгновенной загрузки UI
          this._dispatchEvent('state', parsed.data);
          this._dispatchEvent('stateTimestamp', parsed.timestamp);
          this._dispatchEvent('cached', true);
          
          console.log('[MQTT Manager] Loaded cached state (age: ' + Math.round(age / 1000) + 's)');
        } else {
          console.log('[MQTT Manager] Cached state too old, ignoring');
        }
      }
    } catch (e) {
      console.warn('[MQTT Manager] Failed to load cached state:', e);
    }
  }

  connect(config) {
    if (!config || !config.host || !config.port || !config.base) {
      throw new Error('Invalid MQTT configuration');
    }

    // Нормализация base topic
    if (!config.base.endsWith('/')) {
      config.base += '/';
    }

    console.log('[MQTT Manager] Connecting to:', config.host);
    this.worker.port.postMessage({
      type: 'connect',
      data: config
    });
  }

  publish(key, value) {
    if (!this.worker || !this.worker.port) {
      console.error('[MQTT Manager] Worker not initialized');
      return false;
    }

    if (!this.connected) {
      console.warn('[MQTT Manager] Not connected yet, attempting to publish anyway');
      // Worker сам обработает очередь или выведет ошибку
    }

    try {
      this.worker.port.postMessage({
        type: 'publish',
        data: { key, value }
      });
      return true;
    } catch (error) {
      console.error('[MQTT Manager] Failed to send publish message:', error);
      return false;
    }
  }

  disconnect() {
    this.worker.port.postMessage({ type: 'disconnect' });
  }

  // Convenience методы для подписки на события
  on(eventName, handler) {
    this.addEventListener(eventName, (e) => handler(e.detail));
  }

  off(eventName, handler) {
    this.removeEventListener(eventName, handler);
  }

  // Получение последнего состояния синхронно
  getLastState() {
    return this.lastState ? this.lastState.data : null;
  }

  isConnected() {
    return this.connected;
  }
}

// Export для использования как модуль
if (typeof module !== 'undefined' && module.exports) {
  module.exports = MQTTManager;
}

// Также доступен как глобальный объект
if (typeof window !== 'undefined') {
  window.MQTTManager = MQTTManager;
}
