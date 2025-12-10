// Lightweight MQTT bootstrap + shared MQTTManager wrapper for the GrowHub PWA
// Loads mqtt.js from CDN if not already present and exposes window.MQTTManager
(function(){
  const MQTT_CDN = 'https://unpkg.com/mqtt/dist/mqtt.min.js';
  const LS_LAST_STATE = 'gh_last_state';

  let mqttReady;
  if (window.mqtt) {
    mqttReady = Promise.resolve(window.mqtt);
  } else {
    mqttReady = new Promise((resolve, reject)=>{
      const s = document.createElement('script');
      s.src = MQTT_CDN;
      s.async = true;
      s.onload = ()=> window.mqtt ? resolve(window.mqtt) : reject(new Error('mqtt.js not loaded'));
      s.onerror = ()=> reject(new Error('Failed to load mqtt.js'));
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

  class MQTTManager {
    constructor(){
      this.client = null;
      this.cfg = null;
      this.events = {status: [], state: [], error: [], cached: [], alert: []};
      this.baseTopic = '';
      this.stateTopic = '';
      this.alertTopic = '';
      this.queue = [];
      this.maxQueue = 10;
      this.reconnectMs = 2000;
      this.reconnectMax = 15000;
      this.lastState = null;
      this.connected = false;
    }

    on(evt, cb){ if(this.events[evt]) this.events[evt].push(cb); }
    emit(evt, payload){ (this.events[evt]||[]).forEach(cb=>{ try{ cb(payload); }catch(e){ console.error('[MQTTManager] handler error', e); } }); }

    async connect(cfg){
      this.cfg = cfg || {};
      const mqtt = await mqttReady;
      if(this.client){ try{ this.client.end(true); }catch(_e){} this.client = null; }

      if(!cfg || !cfg.host || !cfg.port || !cfg.base) throw new Error('Incomplete MQTT config');
      const proto = deriveProto(cfg);
      const path = ensureSlash(cfg.path || '/mqtt');
      const base = cfg.base.endsWith('/') ? cfg.base : cfg.base + '/';
      this.baseTopic = base;
      this.stateTopic = base + 'state/json';
      this.alertTopic = base + 'alert';

      const url = `${proto}://${cfg.host}:${cfg.port}${path}`;
      const opts = {
        clientId: 'gh-web-' + Math.random().toString(16).slice(2),
        username: cfg.user || undefined,
        password: cfg.pass || undefined,
        keepalive: 30,
        reconnectPeriod: this.reconnectMs,
        connectTimeout: 8000,
        clean: true,
      };

      this.client = mqtt.connect(url, opts);
      this._bind();
      // emit cached state immediately if present
      this._emitCachedState();
    }

    _bind(){
      if(!this.client) return;
      this.client.on('connect', ()=>{
        this.connected = true;
        this.reconnectMs = 2000;
        this.client.subscribe(this.stateTopic, {qos:0});
        this.client.subscribe(this.alertTopic, {qos:0});
        this.emit('status','connected');
        this._flushQueue();
      });
      this.client.on('reconnect', ()=>{
        this.connected = false;
        this.emit('status','reconnecting');
        // backoff for next attempt (capped)
        this.reconnectMs = Math.min(this.reconnectMax, Math.round(this.reconnectMs * 1.7));
        if(this.client) this.client.options.reconnectPeriod = this.reconnectMs;
      });
      this.client.on('close', ()=>{
        this.connected = false;
        this.emit('status','disconnected');
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
            try{ localStorage.setItem(LS_LAST_STATE, JSON.stringify(js)); }catch(_e){}
            this.emit('state', js);
          }catch(e){ console.warn('[MQTTManager] state parse error', e); }
        } else if(topic === this.alertTopic){
          try{
            const alertData = JSON.parse(payload.toString());
            this.emit('alert', alertData);
          }catch(e){ console.warn('[MQTTManager] alert parse error', e); }
        }
      });
    }

    _emitCachedState(){
      try{
        const cached = localStorage.getItem(LS_LAST_STATE);
        if(cached){
          const js = JSON.parse(cached);
          this.lastState = js;
          this.emit('cached', true);
          this.emit('state', js);
        }
      }catch(_e){}
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
      const payload = String(val);
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
        try { this.client.unsubscribe(this.stateTopic, ()=>{ this.client.subscribe(this.stateTopic); }); } catch(_e) {}
      }
    }

    disconnect(){
      if(this.client){
        try{ this.client.end(true); }catch(_e){}
      }
      this.connected = false;
      this.emit('status','disconnected');
    }
  }

  window.MQTTManager = MQTTManager;
})();
