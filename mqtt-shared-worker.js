/**
 * GrowHub SharedWorker: one MQTT WebSocket session for all PWA tabs.
 */
'use strict';

importScripts('./vendor/mqtt.min.js');

var STALE_DATA_MS = 120000;
var ports = new Set();
var client = null;
var cfg = null;
var baseTopic = '';
var stateTopic = '';
var historyTopic = '';
var diagTopic = '';
var deviceStatusTopic = '';
var queue = [];
var maxQueue = 10;
var reconnectMs = 1000;
var reconnectMax = 10000;
var connected = false;
var deviceOnline = null;
var awaitingFirstState = true;
var lastState = null;
var lastStateTime = 0;
var lastHistory = null;
var lastHistoryTime = 0;
var lastDiag = null;
var lastDiagTime = 0;
var clientId = 'gh-web-shared-' + Math.random().toString(16).slice(2);

function ensureSlash(path){
  if(!path.startsWith('/')) return '/' + path;
  return path;
}

function deriveProto(c){
  if(c.proto){
    var p = String(c.proto).toLowerCase();
    if(p === 'ws' || p === 'wss') return p;
  }
  if(c.ssl === false) return 'ws';
  if(c.port === '443' || c.port === 443 || c.port === '8883' || c.port === 8883 ||
     c.port === '8884' || c.port === 8884) return 'wss';
  return 'wss';
}

function normalizeBase(base){
  if(!base) return '';
  return base.endsWith('/') ? base : base + '/';
}

function cfgKey(c){
  if(!c) return '';
  return [c.host, c.port, normalizeBase(c.base), c.user || '', c.path || '/mqtt'].join('|');
}

function broadcast(msg){
  ports.forEach(function(port){
    try { port.postMessage(msg); } catch(_e){}
  });
}

function sendSnapshot(port){
  port.postMessage({ type: 'status', status: connected ? 'connected' : 'disconnected' });
  if(deviceOnline !== null){
    port.postMessage({ type: 'deviceStatus', online: deviceOnline });
  }
  if(lastState){
    port.postMessage({
      type: 'state',
      payload: lastState,
      fromBroker: !awaitingFirstState,
      timestamp: lastStateTime
    });
  }
  if(lastHistory){
    port.postMessage({ type: 'history', payload: lastHistory, timestamp: lastHistoryTime });
  }
  if(lastDiag){
    port.postMessage({ type: 'diag', payload: lastDiag, timestamp: lastDiagTime });
  }
}

function endClient(){
  if(client){
    try { client.end(true); } catch(_e){}
    client = null;
  }
  connected = false;
}

function bindClient(){
  if(!client) return;

  client.on('connect', function(){
    connected = true;
    reconnectMs = 1000;
    client.subscribe(stateTopic, { qos: 0 });
    client.subscribe(historyTopic, { qos: 0 });
    client.subscribe(diagTopic, { qos: 0 });
    client.subscribe(deviceStatusTopic, { qos: 0 });
    broadcast({ type: 'status', status: 'connected' });
    flushQueue();
  });

  client.on('reconnect', function(){
    connected = false;
    broadcast({ type: 'status', status: 'reconnecting' });
    reconnectMs = Math.min(reconnectMax, Math.round(reconnectMs * 1.7));
    if(client) client.options.reconnectPeriod = reconnectMs;
  });

  client.on('close', function(){
    connected = false;
    if(Date.now() - (lastStateTime || 0) > 5000){
      broadcast({ type: 'status', status: 'disconnected' });
    }
  });

  client.on('offline', function(){
    connected = false;
    broadcast({ type: 'status', status: 'offline' });
  });

  client.on('error', function(err){
    connected = false;
    broadcast({ type: 'error', message: err && err.message ? err.message : 'mqtt error' });
  });

  client.on('message', function(topic, payload){
    if(topic === stateTopic){
      try {
        var js = JSON.parse(payload.toString());
        lastState = js;
        lastStateTime = Date.now();
        awaitingFirstState = false;
        deviceOnline = true;
        broadcast({ type: 'state', payload: js, fromBroker: true, timestamp: lastStateTime });
      } catch(e){
        console.warn('[GH MQTT Worker] state parse error', e);
      }
    } else if(topic === historyTopic){
      try {
        var hist = JSON.parse(payload.toString());
        lastHistory = hist;
        lastHistoryTime = Date.now();
        broadcast({ type: 'history', payload: hist, timestamp: lastHistoryTime });
      } catch(e){
        console.warn('[GH MQTT Worker] history parse error', e);
      }
    } else if(topic === diagTopic){
      try {
        var diag = JSON.parse(payload.toString());
        lastDiag = diag;
        lastDiagTime = Date.now();
        broadcast({ type: 'diag', payload: diag, timestamp: lastDiagTime });
      } catch(e){
        console.warn('[GH MQTT Worker] diag parse error', e);
      }
    } else if(topic === deviceStatusTopic){
      var status = payload.toString().trim().toLowerCase();
      deviceOnline = (status === 'online');
      broadcast({ type: 'deviceStatus', online: deviceOnline });
    }
  });
}

function flushQueue(){
  if(!connected || !client) return;
  while(queue.length){
    var item = queue.shift();
    publishNow(item.key, item.val, item.token);
  }
}

function publishNow(key, val, token){
  if(!baseTopic || !client || !connected) return false;
  var topic = baseTopic + 'set/' + key;
  var payload = (token || 'pwa') + '\n' + String(val);
  try {
    client.publish(topic, payload);
    return true;
  } catch(e){
    broadcast({ type: 'error', message: e && e.message ? e.message : 'publish failed' });
    return false;
  }
}

function connectMqtt(nextCfg){
  if(!nextCfg || !nextCfg.host || !nextCfg.port || !nextCfg.base) return;
  var sameCfg = cfg && cfgKey(cfg) === cfgKey(nextCfg);
  cfg = nextCfg;
  baseTopic = normalizeBase(nextCfg.base);
  stateTopic = baseTopic + 'state/json';
  historyTopic = baseTopic + 'history/json';
  diagTopic = baseTopic + 'diag/json';
  deviceStatusTopic = baseTopic + 'status';

  if(sameCfg && client && connected){
    broadcast({ type: 'status', status: 'connected' });
    return;
  }

  endClient();
  awaitingFirstState = true;
  deviceOnline = null;

  var proto = deriveProto(nextCfg);
  var path = ensureSlash(nextCfg.path || '/mqtt');
  var url = proto + '://' + nextCfg.host + ':' + nextCfg.port + path;
  var opts = {
    clientId: clientId,
    username: nextCfg.user || undefined,
    password: nextCfg.pass || undefined,
    keepalive: 60,
    reconnectPeriod: reconnectMs,
    connectTimeout: 10000,
    clean: false
  };

  if(typeof mqtt === 'undefined'){
    broadcast({ type: 'error', message: 'mqtt.js not loaded in worker' });
    return;
  }

  client = mqtt.connect(url, opts);
  bindClient();
}

function resubscribe(){
  if(!client || !connected) return;
  try {
    client.unsubscribe(stateTopic, function(){
      client.subscribe(stateTopic);
      client.subscribe(historyTopic);
      client.subscribe(diagTopic);
      client.subscribe(deviceStatusTopic);
    });
  } catch(_e){}
}

function handlePortMessage(port, data){
  if(!data || !data.type) return;
  switch(data.type){
    case 'connect':
      connectMqtt(data.cfg || null);
      break;
    case 'disconnect':
      endClient();
      awaitingFirstState = true;
      deviceOnline = null;
      broadcast({ type: 'status', status: 'disconnected' });
      break;
    case 'publish':
      if(!publishNow(data.key, data.val, data.token)){
        if(queue.length < maxQueue) queue.push({ key: data.key, val: data.val, token: data.token });
      }
      break;
    case 'resubscribe':
      resubscribe();
      break;
    case 'ping':
      sendSnapshot(port);
      break;
    default:
      break;
  }
}

self.onconnect = function(e){
  var port = e.ports[0];
  ports.add(port);
  port.start();
  sendSnapshot(port);
  port.onmessage = function(ev){
    handlePortMessage(port, ev.data);
  };
};
