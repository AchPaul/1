/**
 * GrowHub MQTT localStorage cache helpers (shared by pwa-bridge, mqtt-simple, app).
 */
(function(global){
  'use strict';

  var LS_LAST_STATE_PREFIX = 'gh_last_state_';
  var LS_LAST_STATE_TS_PREFIX = 'gh_last_state_ts_';
  var LS_LAST_HISTORY_PREFIX = 'gh_last_history_';
  var LS_LAST_HISTORY_TS_PREFIX = 'gh_last_history_ts_';
  var LS_LAST_DIAG_PREFIX = 'gh_last_diag_';
  var LS_LAST_DIAG_TS_PREFIX = 'gh_last_diag_ts_';
  var STALE_DATA_THRESHOLD = 120000;
  var OPTIMISTIC_STATUS_MS = 60000;
  var LEGACY_LS_KEYS = [
    'gh_last_state', 'gh_last_state_ts', 'gh_last_history', 'gh_last_history_ts',
    'gh_last_diag', 'gh_last_diag_ts'
  ];

  function cacheSlug(base){
    return String(base || 'default').replace(/[^a-zA-Z0-9]/g, '_').slice(0, 48);
  }

  function normalizeBase(base){
    if(!base) return '';
    return base.endsWith('/') ? base : base + '/';
  }

  function lsStateKey(base){ return LS_LAST_STATE_PREFIX + cacheSlug(base); }
  function lsStateTsKey(base){ return LS_LAST_STATE_TS_PREFIX + cacheSlug(base); }
  function lsHistoryKey(base){ return LS_LAST_HISTORY_PREFIX + cacheSlug(base); }
  function lsHistoryTsKey(base){ return LS_LAST_HISTORY_TS_PREFIX + cacheSlug(base); }
  function lsDiagKey(base){ return LS_LAST_DIAG_PREFIX + cacheSlug(base); }
  function lsDiagTsKey(base){ return LS_LAST_DIAG_TS_PREFIX + cacheSlug(base); }

  function purgeLegacyLsCache(){
    LEGACY_LS_KEYS.forEach(function(k){
      try { localStorage.removeItem(k); } catch(_e){}
    });
  }

  function readJson(key){
    try {
      var raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch(_e){
      return null;
    }
  }

  function readTs(key){
    try {
      var raw = localStorage.getItem(key);
      var n = raw ? parseInt(raw, 10) : 0;
      return Number.isFinite(n) ? n : 0;
    } catch(_e){
      return 0;
    }
  }

  function isFresh(timestamp, thresholdMs){
    if(!timestamp) return false;
    var limit = (typeof thresholdMs === 'number') ? thresholdMs : OPTIMISTIC_STATUS_MS;
    return (Date.now() - timestamp) <= limit;
  }

  function isStale(timestamp){
    if(!timestamp) return true;
    return (Date.now() - timestamp) > STALE_DATA_THRESHOLD;
  }

  function readPack(base){
    base = normalizeBase(base);
    if(!base) return null;
    return {
      base: base,
      state: readJson(lsStateKey(base)),
      stateTs: readTs(lsStateTsKey(base)),
      history: readJson(lsHistoryKey(base)),
      historyTs: readTs(lsHistoryTsKey(base)),
      diag: readJson(lsDiagKey(base)),
      diagTs: readTs(lsDiagTsKey(base))
    };
  }

  function writeState(base, state, ts){
    base = normalizeBase(base);
    if(!base || !state) return;
    var stamp = (typeof ts === 'number') ? ts : Date.now();
    try {
      localStorage.setItem(lsStateKey(base), JSON.stringify(state));
      localStorage.setItem(lsStateTsKey(base), String(stamp));
    } catch(_e){}
  }

  function writeHistory(base, history, ts){
    base = normalizeBase(base);
    if(!base || !history) return;
    var stamp = (typeof ts === 'number') ? ts : Date.now();
    try {
      localStorage.setItem(lsHistoryKey(base), JSON.stringify(history));
      localStorage.setItem(lsHistoryTsKey(base), String(stamp));
    } catch(_e){}
  }

  function writeDiag(base, diag, ts){
    base = normalizeBase(base);
    if(!base || !diag) return;
    var stamp = (typeof ts === 'number') ? ts : Date.now();
    try {
      localStorage.setItem(lsDiagKey(base), JSON.stringify(diag));
      localStorage.setItem(lsDiagTsKey(base), String(stamp));
    } catch(_e){}
  }

  function resolveActiveBase(){
    try {
      var ghs = JSON.parse(localStorage.getItem('gh_greenhouses_v1') || '[]');
      var activeId = localStorage.getItem('gh_active_greenhouse_v1');
      if(activeId && Array.isArray(ghs)){
        for(var i = 0; i < ghs.length; i++){
          if(ghs[i].id === activeId && ghs[i].base){
            return normalizeBase(ghs[i].base);
          }
        }
      }
      var legacy = JSON.parse(localStorage.getItem('gh_remote_cfg_v1') || 'null');
      if(legacy && legacy.base) return normalizeBase(legacy.base);
    } catch(_e){}
    return null;
  }

  var api = {
    STALE_DATA_MS: STALE_DATA_THRESHOLD,
    OPTIMISTIC_STATUS_MS: OPTIMISTIC_STATUS_MS,
    normalizeBase: normalizeBase,
    readPack: readPack,
    writeState: writeState,
    writeHistory: writeHistory,
    writeDiag: writeDiag,
    isFresh: isFresh,
    isStale: isStale,
    resolveActiveBase: resolveActiveBase,
    purgeLegacyLsCache: purgeLegacyLsCache,
    lsStateKey: lsStateKey,
    lsStateTsKey: lsStateTsKey,
    lsHistoryKey: lsHistoryKey,
    lsHistoryTsKey: lsHistoryTsKey,
    lsDiagKey: lsDiagKey,
    lsDiagTsKey: lsDiagTsKey
  };

  if(typeof global !== 'undefined'){
    global.GHMqttCache = api;
    global.GH_STALE_DATA_MS = STALE_DATA_THRESHOLD;
    global.GH_OPTIMISTIC_STATUS_MS = OPTIMISTIC_STATUS_MS;
  }

  purgeLegacyLsCache();
})(typeof window !== 'undefined' ? window : self);
