/**
 * Simple MQTT Client - прямое подключение БЕЗ Worker
 * Простое и надёжное решение для всех браузеров
 */

class SimpleMQTTClient {
  constructor() {
    this.client = null;
    this.connected = false;
    this.config = null;
    this.lastState = null;
    this.publishQueue = [];
    this.eventHandlers = {};
    this.mqttLoaded = false;
    
    console.log('[MQTT Simple] Initialized');
  }

  _loadMQTTLib() {
    if (this.mqttLoaded || typeof mqtt !== 'undefined') {
      this.mqttLoaded = true;
      return Promise.resolve();
    }

    return new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = 'https://unpkg.com/mqtt@5.3.5/dist/mqtt.min.js';
      script.onload = () => {
        console.log('[MQTT Simple] Library loaded');
        this.mqttLoaded = true;
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
      console.error('[MQTT Simple] Failed to load library:', e);
      this._emit('status', 'error');
      return;
    }

    const tlsPorts = [8883, 8884, 8885, 443];
    const port = parseInt(cfg.port);
    const protocol = tlsPorts.includes(port) ? 'wss' : 'ws';
    const url = `${protocol}://${cfg.host}:${cfg.port}/mqtt`;

    console.log('[MQTT Simple] Connecting:', url);
    this._emit('status', 'connecting');

    if (this.client) {
      try {
        this.client.end(true);
      } catch (e) {}
    }

    this.client = mqtt.connect(url, {
      clientId: 'gh-' + Math.random().toString(16).slice(2, 10),
      username: cfg.user || undefined,
      password: cfg.pass || undefined,
      reconnectPeriod: 2000,
      connectTimeout: 10000,
      keepalive: 30,
      clean: true,
      rejectUnauthorized: false
    });

    const stateTopic = cfg.base.endsWith('/') ? cfg.base + 'state/json' : cfg.base + '/state/json';

    this.client.on('connect', () => {
      console.log('[MQTT Simple] Connected');
      this.connected = true;
      this._emit('status', 'connected');

      this.client.subscribe(stateTopic, { qos: 0 }, (err) => {
        if (err) {
          console.error('[MQTT Simple] Subscribe error:', err);
        } else {
          console.log('[MQTT Simple] Subscribed:', stateTopic);
          
          // Обрабатываем очередь
          if (this.publishQueue.length > 0) {
            console.log('[MQTT Simple] Processing queue:', this.publishQueue.length);
            const queue = [...this.publishQueue];
            this.publishQueue = [];
            queue.forEach(({ key, value }) => this.publish(key, value));
          }
        }
      });
    });

    this.client.on('message', (topic, payload) => {
      if (topic === stateTopic) {
        try {
          const state = JSON.parse(payload.toString());
          this.lastState = {
            data: state,
            timestamp: Date.now()
          };
          
          this._emit('state', state);
          this._cacheState(this.lastState);
        } catch (e) {
          console.error('[MQTT Simple] Parse error:', e);
        }
      }
    });

    this.client.on('error', (err) => {
      console.error('[MQTT Simple] Error:', err);
      this._emit('status', 'error');
    });

    this.client.on('close', () => {
      console.log('[MQTT Simple] Disconnected');
      this.connected = false;
      this._emit('status', 'disconnected');
    });

    this.client.on('reconnect', () => {
      console.log('[MQTT Simple] Reconnecting...');
      this._emit('status', 'reconnecting');
    });
  }

  publish(key, value) {
    if (!this.config) {
      console.error('[MQTT Simple] No config');
      return false;
    }

    if (!this.client || !this.connected) {
      console.warn('[MQTT Simple] Not connected, queueing:', key, '=', value);
      this.publishQueue.push({ key, value });
      this._emit('queued', { key, value });
      return false;
    }

    const base = this.config.base.endsWith('/') ? this.config.base : this.config.base + '/';
    const topic = base + 'set/' + key;
    
    console.log('[MQTT Simple] Publishing:', topic, '=', value);

    this.client.publish(topic, String(value), { qos: 0 }, (err) => {
      if (err) {
        console.error('[MQTT Simple] Publish error:', err);
      } else {
        this._emit('published', { key, value });
      }
    });

    return true;
  }

  disconnect() {
    if (this.client) {
      this.client.end(true);
      this.client = null;
    }
    this.connected = false;
  }

  on(event, handler) {
    if (!this.eventHandlers[event]) {
      this.eventHandlers[event] = [];
    }
    this.eventHandlers[event].push(handler);
  }

  off(event, handler) {
    if (!this.eventHandlers[event]) return;
    this.eventHandlers[event] = this.eventHandlers[event].filter(h => h !== handler);
  }

  _emit(event, data) {
    if (this.eventHandlers[event]) {
      this.eventHandlers[event].forEach(handler => {
        try {
          handler(data);
        } catch (e) {
          console.error('[MQTT Simple] Handler error:', e);
        }
      });
    }
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
      console.warn('[MQTT Simple] Cache failed:', e);
    }
  }

  loadCachedState() {
    try {
      const cached = localStorage.getItem('gh_mqtt_state_cache');
      if (cached) {
        const state = JSON.parse(cached);
        const age = Date.now() - state.timestamp;
        if (age < 300000) { // 5 минут
          this.lastState = state;
          this._emit('state', state.data);
          this._emit('cached', true);
          console.log('[MQTT Simple] Loaded cache (age: ' + Math.round(age/1000) + 's)');
        }
      }
    } catch (e) {}
  }
}

if (typeof window !== 'undefined') {
  window.SimpleMQTTClient = SimpleMQTTClient;
}
