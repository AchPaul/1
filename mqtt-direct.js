/**
 * MQTT Direct Client - прямое подключение БЕЗ SharedWorker
 * Fallback для браузеров не поддерживающих SharedWorker
 * 
 * Работает на всех браузерах включая старые версии Chrome Mobile
 */

class MQTTDirectClient extends EventTarget {
  constructor() {
    super();
    this.mqttClient = null;
    this.connected = false;
    this.lastState = null;
    this.config = null;
    this.publishQueue = [];
    
    console.log('[MQTT Direct] Initialized (no SharedWorker)');
  }

  _dispatchEvent(name, detail) {
    this.dispatchEvent(new CustomEvent(name, { detail }));
  }

  _loadMQTTLib() {
    return new Promise((resolve, reject) => {
      if (typeof mqtt !== 'undefined') {
        resolve();
        return;
      }

      const script = document.createElement('script');
      script.src = 'https://unpkg.com/mqtt@5.3.5/dist/mqtt.min.js';
      script.onload = () => {
        console.log('[MQTT Direct] Library loaded');
        resolve();
      };
      script.onerror = () => reject(new Error('Failed to load MQTT library'));
      document.head.appendChild(script);
    });
  }

  async connect(cfg) {
    this.config = cfg;
    
    try {
      await this._loadMQTTLib();
    } catch (e) {
      console.error('[MQTT Direct] Failed to load MQTT lib:', e);
      this._dispatchEvent('status', 'error');
      return;
    }

    const tlsPorts = [8883, 8884, 8885, 443];
    const port = parseInt(cfg.port);
    const protocol = tlsPorts.includes(port) ? 'wss' : 'ws';
    const url = `${protocol}://${cfg.host}:${cfg.port}/mqtt`;

    console.log('[MQTT Direct] Connecting to:', url);
    this._dispatchEvent('status', 'connecting');

    if (this.mqttClient) {
      try {
        this.mqttClient.end(true);
      } catch (e) {}
      this.mqttClient = null;
    }

    this.mqttClient = mqtt.connect(url, {
      clientId: 'gh-direct-' + Math.random().toString(16).slice(2),
      username: cfg.user || undefined,
      password: cfg.pass || undefined,
      reconnectPeriod: 2000,
      connectTimeout: 10000,
      keepalive: 30,
      clean: true,
      rejectUnauthorized: false
    });

    const stateTopic = cfg.base + 'state/json';

    this.mqttClient.on('connect', () => {
      console.log('[MQTT Direct] Connected');
      this.connected = true;
      this._dispatchEvent('status', 'connected');

      this.mqttClient.subscribe(stateTopic, { qos: 0 }, (err) => {
        if (err) {
          console.error('[MQTT Direct] Subscribe error:', err);
        } else {
          console.log('[MQTT Direct] Subscribed to:', stateTopic);
          
          // Обрабатываем очередь
          if (this.publishQueue.length > 0) {
            console.log('[MQTT Direct] Processing queue:', this.publishQueue.length);
            const queue = [...this.publishQueue];
            this.publishQueue = [];
            queue.forEach(({ key, value }) => this.publish(key, value));
          }
        }
      });
    });

    this.mqttClient.on('message', (topic, payload) => {
      if (topic === stateTopic) {
        try {
          const state = JSON.parse(payload.toString());
          this.lastState = {
            data: state,
            timestamp: Date.now()
          };
          
          this._dispatchEvent('state', state);
          this._cacheState(this.lastState);
        } catch (e) {
          console.error('[MQTT Direct] Parse error:', e);
        }
      }
    });

    this.mqttClient.on('error', (err) => {
      console.error('[MQTT Direct] Error:', err);
      this._dispatchEvent('status', 'error');
    });

    this.mqttClient.on('close', () => {
      console.log('[MQTT Direct] Connection closed');
      this.connected = false;
      this._dispatchEvent('status', 'disconnected');
    });

    this.mqttClient.on('reconnect', () => {
      console.log('[MQTT Direct] Reconnecting...');
      this._dispatchEvent('status', 'reconnecting');
    });
  }

  publish(key, value) {
    if (!this.config) {
      console.error('[MQTT Direct] No config');
      return false;
    }

    if (!this.mqttClient || !this.connected) {
      console.warn('[MQTT Direct] Not connected, queueing:', key, '=', value);
      this.publishQueue.push({ key, value });
      this._dispatchEvent('queued', { key, value });
      return false;
    }

    const topic = this.config.base + 'set/' + key;
    console.log('[MQTT Direct] Publishing:', topic, '=', value);

    this.mqttClient.publish(topic, String(value), { qos: 0 }, (err) => {
      if (err) {
        console.error('[MQTT Direct] Publish error:', err);
      } else {
        this._dispatchEvent('published', { key, value });
      }
    });

    return true;
  }

  disconnect() {
    if (this.mqttClient) {
      this.mqttClient.end(true);
      this.mqttClient = null;
    }
    this.connected = false;
  }

  on(eventName, handler) {
    this.addEventListener(eventName, (e) => handler(e.detail));
  }

  off(eventName, handler) {
    this.removeEventListener(eventName, handler);
  }

  getLastState() {
    return this.lastState ? this.lastState.data : null;
  }

  isConnected() {
    return this.connected;
  }

  _cacheState(state) {
    try {
      localStorage.setItem('gh_mqtt_state_cache', JSON.stringify(state));
    } catch (e) {
      console.warn('[MQTT Direct] Cache failed:', e);
    }
  }

  _loadCachedState() {
    try {
      const cached = localStorage.getItem('gh_mqtt_state_cache');
      if (cached) {
        const state = JSON.parse(cached);
        const age = Date.now() - state.timestamp;
        if (age < 300000) { // 5 минут
          this.lastState = state;
          this._dispatchEvent('state', state.data);
          this._dispatchEvent('cached', true);
        }
      }
    } catch (e) {}
  }
}

// Export
if (typeof module !== 'undefined' && module.exports) {
  module.exports = MQTTDirectClient;
}
if (typeof window !== 'undefined') {
  window.MQTTDirectClient = MQTTDirectClient;
}
