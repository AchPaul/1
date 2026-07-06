// GrowHub MQTT manager: local mqtt.js + SharedWorker (fallback: direct per-tab connection).
(function(){
  const MQTT_LOCAL = 'vendor/mqtt.min.js';
  const WORKER_URL = 'mqtt-shared-worker.js';
  const cache = window.GHMqttCache;
  const STALE_DATA_THRESHOLD = cache ? cache.STALE_DATA_MS : 120000;

  function purgeLegacyLsCache(){
    if(cache && cache.purgeLegacyLsCache) cache.purgeLegacyLsCache();
  }

  let mqttReady;
  if (window.mqtt) {
    mqttReady = Promise.resolve(window.mqtt);
  } else {
    mqttReady = new Promise((resolve, reject)=>{
      const s = document.createElement('script');
      s.src = MQTT_LOCAL;
      s.async = true;
      s.onload = ()=> window.mqtt ? resolve(window.mqtt) : reject(new Error('mqtt.js not loaded'));
      s.onerror = ()=> reject(new Error('Failed to load local mqtt.js'));
      document.head.appendChild(s);
    });
  }

  function ensureSlash(path){
    if(!path.startsWith('/')) return '/' + path;
    return path;
  }

  function deriveProto(cfg){
    if(cfg.proto){
      const p = cfg.proto.toLowerCase();
      if(p === 'ws' || p === 'wss') return p;
    }
    if(cfg.ssl === false) return 'ws';
    if(cfg.port === '443' || cfg.port === 443 || cfg.port === '8883' || cfg.port === 8883 || cfg.port === '8884' || cfg.port === 8884) return 'wss';
    if(window.location.protocol === 'https:') return 'wss';
    return 'ws';
  }

  function normalizeBase(base){
    return cache ? cache.normalizeBase(base) : (base && base.endsWith('/') ? base : base + '/');
  }

  class BaseMQTTManager {
    constructor(){
      this.cfg = null;
      this.events = {status: [], state: [], history: [], diag: [], error: [], cached: [], deviceStatus: []};
      this.baseTopic = '';
      this.stateTopic = '';
      this.historyTopic = '';
      this.diagTopic = '';
      this.deviceStatusTopic = '';
      this.lastState = null;
      this.lastStateTime = 0;
      this.lastHistory = null;
      this.lastHistoryTime = 0;
      this.lastDiag = null;
      this.lastDiagTime = 0;
      this.connected = false;
      this.deviceOnline = null;
      this.awaitingFirstState = true;
      this.cachedStateWasStale = false;
    }

    isDataStale(timestamp){
      if(cache) return cache.isStale(timestamp);
      if(!timestamp) return true;
      return (Date.now() - timestamp) > STALE_DATA_THRESHOLD;
    }

    isCacheFresh(timestamp){
      if(cache) return cache.isFresh(timestamp);
      return !!timestamp && (Date.now() - timestamp) <= 60000;
    }

    on(evt, cb){ if(this.events[evt]) this.events[evt].push(cb); }
    emit(evt, payload){ (this.events[evt]||[]).forEach(cb=>{ try{ cb(payload); }catch(e){ console.error('[MQTTManager] handler error', e); } }); }

    _prepareTopics(cfg){
      const base = normalizeBase(cfg.base);
      this.baseTopic = base;
      this.stateTopic = base + 'state/json';
      this.historyTopic = base + 'history/json';
      this.diagTopic = base + 'diag/json';
      this.deviceStatusTopic = base + 'status';
    }

    _emitCachedHistory(){
      if(!cache || !this.baseTopic) return;
      const pack = cache.readPack(this.baseTopic);
      if(pack && pack.history){
        this.lastHistory = pack.history;
        this.lastHistoryTime = pack.historyTs || 0;
        this.emit('history', pack.history);
      }
    }

    _emitCachedDiag(){
      if(!cache || !this.baseTopic) return;
      const pack = cache.readPack(this.baseTopic);
      if(pack && pack.diag){
        this.lastDiag = pack.diag;
        this.lastDiagTime = pack.diagTs || 0;
        this.emit('diag', pack.diag);
      }
    }

    _emitCachedState(){
      if(!cache || !this.baseTopic){
        this.cachedStateWasStale = true;
        this.emit('cached', { stale: true, timestamp: 0 });
        return;
      }
      const pack = cache.readPack(this.baseTopic);
      if(pack && pack.state){
        this.lastState = pack.state;
        this.lastStateTime = pack.stateTs || 0;
        this.cachedStateWasStale = this.isDataStale(this.lastStateTime);
        this.emit('cached', { stale: this.cachedStateWasStale, timestamp: this.lastStateTime });
        this.emit('state', pack.state);
      } else {
        this.cachedStateWasStale = true;
        this.emit('cached', { stale: true, timestamp: 0 });
      }
    }

    _persistState(js, ts){
      if(cache && this.baseTopic) cache.writeState(this.baseTopic, js, ts);
    }

    _persistHistory(hist, ts){
      if(cache && this.baseTopic) cache.writeHistory(this.baseTopic, hist, ts);
    }

    _persistDiag(diag, ts){
      if(cache && this.baseTopic) cache.writeDiag(this.baseTopic, diag, ts);
    }
  }

  class DirectMQTTManager extends BaseMQTTManager {
    constructor(){
      super();
      this.client = null;
      this.queue = [];
      this.maxQueue = 10;
      this.reconnectMs = 1000;
      this.reconnectMax = 10000;
    }

    async connect(cfg){
      this.cfg = cfg || {};
      const mqtt = await mqttReady;
      if(this.client){ try{ this.client.end(true); }catch(_e){} this.client = null; }

      this.awaitingFirstState = true;
      this.cachedStateWasStale = false;
      this.deviceOnline = null;
      purgeLegacyLsCache();

      if(!cfg || !cfg.host || !cfg.port || !cfg.base) throw new Error('Incomplete MQTT config');
      this._prepareTopics(cfg);

      const proto = deriveProto(cfg);
      const path = ensureSlash(cfg.path || '/mqtt');
      const url = `${proto}://${cfg.host}:${cfg.port}${path}`;
      const opts = {
        clientId: 'gh-web-' + Math.random().toString(16).slice(2),
        username: cfg.user || undefined,
        password: cfg.pass || undefined,
        keepalive: 60,
        reconnectPeriod: this.reconnectMs,
        connectTimeout: 10000,
        clean: false,
      };

      this.client = mqtt.connect(url, opts);
      this._bind();
      this._emitCachedState();
      this._emitCachedHistory();
      this._emitCachedDiag();
    }

    _bind(){
      if(!this.client) return;
      this.client.on('connect', ()=>{
        this.connected = true;
        this.reconnectMs = 1000;
        this.client.subscribe(this.stateTopic, {qos:0});
        this.client.subscribe(this.historyTopic, {qos:0});
        this.client.subscribe(this.diagTopic, {qos:0});
        this.client.subscribe(this.deviceStatusTopic, {qos:0});
        this.emit('status','connected');
        this._flushQueue();
      });
      this.client.on('reconnect', ()=>{
        this.connected = false;
        this.emit('status','reconnecting');
        this.reconnectMs = Math.min(this.reconnectMax, Math.round(this.reconnectMs * 1.7));
        if(this.client) this.client.options.reconnectPeriod = this.reconnectMs;
      });
      this.client.on('close', ()=>{
        this.connected = false;
        const lastStateTime = this.lastStateTime || 0;
        if(Date.now() - lastStateTime > 5000){
          this.emit('status','disconnected');
        }
      });
      this.client.on('offline', ()=>{
        this.connected = false;
        this.emit('status','offline');
      });
      this.client.on('error', (err)=>{
        this.connected = false;
        this.emit('error', err);
      });
      this.client.on('message', (topic, payload)=>{
        if(topic === this.stateTopic){
          try{
            const js = JSON.parse(payload.toString());
            this.lastState = js;
            this.lastStateTime = Date.now();
            this.awaitingFirstState = false;
            this.deviceOnline = true;
            this._persistState(js, this.lastStateTime);
            this.emit('state', js);
          }catch(e){ console.warn('[MQTTManager] state parse error', e); }
        } else if(topic === this.historyTopic){
          try{
            const hist = JSON.parse(payload.toString());
            this.lastHistory = hist;
            this.lastHistoryTime = Date.now();
            this._persistHistory(hist, this.lastHistoryTime);
            this.emit('history', hist);
          }catch(e){ console.warn('[MQTTManager] history parse error', e); }
        } else if(topic === this.diagTopic){
          try{
            const diag = JSON.parse(payload.toString());
            this.lastDiag = diag;
            this.lastDiagTime = Date.now();
            this._persistDiag(diag, this.lastDiagTime);
            this.emit('diag', diag);
          }catch(e){ console.warn('[MQTTManager] diag parse error', e); }
        } else if(topic === this.deviceStatusTopic){
          const status = payload.toString().trim().toLowerCase();
          this.deviceOnline = (status === 'online');
          this.emit('deviceStatus', this.deviceOnline);
        }
      });
    }

    _flushQueue(){
      if(!this.connected || !this.client) return;
      while(this.queue.length){
        const {key, val} = this.queue.shift();
        this.publish(key, val);
      }
    }

    publish(key, val){
      const topic = this.baseTopic ? this.baseTopic + 'set/' + key : null;
      if(!topic) return false;
      const token = (typeof window !== 'undefined' && window.GH_MQTT_CMD_TOKEN) ? window.GH_MQTT_CMD_TOKEN : 'pwa';
      const payload = token + '\n' + String(val);
      if(!this.connected || !this.client){
        if(this.queue.length < this.maxQueue) this.queue.push({key, val});
        return false;
      }
      try{
        this.client.publish(topic, payload);
        return true;
      }catch(e){
        this.emit('error', e);
        return false;
      }
    }

    resubscribe(){
      if(this.client && this.connected){
        try {
          this.client.unsubscribe(this.stateTopic, ()=>{
            this.client.subscribe(this.stateTopic);
            this.client.subscribe(this.historyTopic);
            this.client.subscribe(this.diagTopic);
            this.client.subscribe(this.deviceStatusTopic);
          });
        } catch(_e) {}
      }
    }

    disconnect(){
      if(this.client){
        try{ this.client.end(true); }catch(_e){}
        this.client = null;
      }
      this.connected = false;
      this.deviceOnline = null;
      this.awaitingFirstState = true;
      this.emit('status','disconnected');
    }
  }

  let sharedWorker = null;
  let sharedWorkerInitFailed = false;

  class WorkerMQTTManager extends BaseMQTTManager {
    constructor(){
      super();
      this.queue = [];
      this.maxQueue = 10;
      this._port = null;
    }

    _ensureWorker(){
      if(this._port) return this._port;
      if(sharedWorkerInitFailed) throw new Error('SharedWorker unavailable');
      try {
        sharedWorker = new SharedWorker(WORKER_URL, { name: 'gh-mqtt-v1' });
        this._port = sharedWorker.port;
        this._port.start();
        this._port.onmessage = (e)=> this._onWorkerMessage(e.data);
        return this._port;
      } catch(e){
        sharedWorkerInitFailed = true;
        throw e;
      }
    }

    _onWorkerMessage(msg){
      if(!msg || !msg.type) return;
      switch(msg.type){
        case 'status':
          this.connected = (msg.status === 'connected');
          this.emit('status', msg.status);
          if(this.connected) this._flushQueue();
          break;
        case 'state': {
          const js = msg.payload;
          this.lastState = js;
          this.lastStateTime = msg.timestamp || Date.now();
          if(msg.fromBroker){
            this.awaitingFirstState = false;
            this.deviceOnline = true;
            this._persistState(js, this.lastStateTime);
          }
          this.emit('state', js);
          break;
        }
        case 'history': {
          const hist = msg.payload;
          this.lastHistory = hist;
          this.lastHistoryTime = msg.timestamp || Date.now();
          if(msg.fromBroker !== false) this._persistHistory(hist, this.lastHistoryTime);
          this.emit('history', hist);
          break;
        }
        case 'diag': {
          const diag = msg.payload;
          this.lastDiag = diag;
          this.lastDiagTime = msg.timestamp || Date.now();
          if(msg.fromBroker !== false) this._persistDiag(diag, this.lastDiagTime);
          this.emit('diag', diag);
          break;
        }
        case 'deviceStatus':
          this.deviceOnline = !!msg.online;
          this.emit('deviceStatus', this.deviceOnline);
          break;
        case 'error':
          this.emit('error', new Error(msg.message || 'mqtt worker error'));
          break;
        default:
          break;
      }
    }

    async connect(cfg){
      this.cfg = cfg || {};
      this.awaitingFirstState = true;
      this.cachedStateWasStale = false;
      this.deviceOnline = null;
      purgeLegacyLsCache();

      if(!cfg || !cfg.host || !cfg.port || !cfg.base) throw new Error('Incomplete MQTT config');
      this._prepareTopics(cfg);

      this._emitCachedState();
      this._emitCachedHistory();
      this._emitCachedDiag();

      const port = this._ensureWorker();
      port.postMessage({ type: 'connect', cfg: cfg });
    }

    publish(key, val){
      if(!this.baseTopic) return false;
      const token = window.GH_MQTT_CMD_TOKEN || 'pwa';
      if(!this._port){
        if(this.queue.length < this.maxQueue) this.queue.push({key, val});
        return false;
      }
      if(!this.connected){
        if(this.queue.length < this.maxQueue) this.queue.push({key, val});
      }
      try {
        this._port.postMessage({ type: 'publish', key: key, val: val, token: token });
        return this.connected;
      } catch(e){
        this.emit('error', e);
        return false;
      }
    }

    _flushQueue(){
      if(!this.connected || !this._port) return;
      while(this.queue.length){
        const item = this.queue.shift();
        this.publish(item.key, item.val);
      }
    }

    resubscribe(){
      if(this._port) this._port.postMessage({ type: 'resubscribe' });
    }

    disconnect(){
      if(this._port){
        try { this._port.postMessage({ type: 'disconnect' }); } catch(_e){}
      }
      this.connected = false;
      this.deviceOnline = null;
      this.awaitingFirstState = true;
      this.emit('status','disconnected');
    }
  }

  function canUseSharedWorker(){
    return typeof SharedWorker !== 'undefined' && !sharedWorkerInitFailed;
  }

  class MQTTManager {
    constructor(){
      this._impl = canUseSharedWorker() ? new WorkerMQTTManager() : new DirectMQTTManager();
    }

    get cfg(){ return this._impl.cfg; }
    get baseTopic(){ return this._impl.baseTopic; }
    get lastStateTime(){ return this._impl.lastStateTime; }
    get awaitingFirstState(){ return this._impl.awaitingFirstState; }
    get cachedStateWasStale(){ return this._impl.cachedStateWasStale; }
    get deviceOnline(){ return this._impl.deviceOnline; }
    get connected(){ return this._impl.connected; }

    on(evt, cb){ return this._impl.on(evt, cb); }
    connect(cfg){ return this._impl.connect(cfg); }
    publish(key, val){ return this._impl.publish(key, val); }
    resubscribe(){ return this._impl.resubscribe(); }
    disconnect(){ return this._impl.disconnect(); }
  }

  window.MQTTManager = MQTTManager;
  window.GH_MQTT_USES_SHARED_WORKER = canUseSharedWorker;
  purgeLegacyLsCache();
})();
