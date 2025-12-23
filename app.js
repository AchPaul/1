/* GrowHub Remote UI - MQTT over WebSockets
 * Assumptions:
 *  - MQTT state topic: <base>state/json (retained)
 *  - Commands: <base>set/<key> (payload = plain value)
 *  - JSON fields per firmware publish_state_core() in mqtt.cpp
 *    Keys: name, profile_id, profile_name, day_time, lig_type, lig_hours, lig_pwm,
 *          temp_day, temp_night, humgr_day, humgr_night, humair_day, humair_night,
 *          temp_now, humgr_now, humair_now, alert_* flags
 */

const LS_KEY = 'gh_remote_cfg_v1';
const LS_GREENHOUSES_KEY = 'gh_greenhouses_v1'; // Список всех теплиц
const LS_ACTIVE_GH_KEY = 'gh_active_greenhouse_v1'; // ID активной теплицы
const LS_MQTT_CONNECTED = 'gh_mqtt_connected'; // Статус MQTT подключения
const LS_LOGS_KEY = 'gh_logs_v1';
const LS_ESP32_LOGS_KEY = 'gh_esp32_logs_v1';
const MAX_LOGS = 500; // Максимальное количество записей в логах

// === Система управления несколькими теплицами ===
let greenhouses = []; // Массив теплиц [{id, name, host, port, user, pass, base, path, proto}]
let activeGreenhouseId = null;

function generateGreenhouseId(){
  return 'gh_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
}

function loadGreenhouses(){
  try {
    const stored = localStorage.getItem(LS_GREENHOUSES_KEY);
    if(stored){
      greenhouses = JSON.parse(stored);
    } else {
      greenhouses = [];
    }
    // Загружаем ID активной теплицы
    activeGreenhouseId = localStorage.getItem(LS_ACTIVE_GH_KEY);
    // Проверяем что активная теплица существует
    if(activeGreenhouseId && !greenhouses.find(g => g.id === activeGreenhouseId)){
      activeGreenhouseId = greenhouses.length > 0 ? greenhouses[0].id : null;
      localStorage.setItem(LS_ACTIVE_GH_KEY, activeGreenhouseId || '');
    }
    // Миграция старой конфигурации если теплицы пусты
    if(greenhouses.length === 0){
      const oldCfg = localStorage.getItem(LS_KEY);
      if(oldCfg){
        try {
          const cfg = JSON.parse(oldCfg);
          if(cfg.host && cfg.base){
            const migrated = {
              id: generateGreenhouseId(),
              name: 'Теплица 1',
              host: cfg.host,
              port: cfg.port || '8884',
              user: cfg.user || '',
              pass: cfg.pass || '',
              base: cfg.base,
              path: cfg.path || '/mqtt',
              proto: cfg.proto || 'wss'
            };
            greenhouses.push(migrated);
            activeGreenhouseId = migrated.id;
            saveGreenhouses();
            console.log('[GrowHub] Миграция старой конфигурации в новую систему теплиц');
          }
        } catch(e){}
      }
    }
  } catch(e) {
    console.warn('[GrowHub] Failed to load greenhouses', e);
    greenhouses = [];
  }
  return greenhouses;
}

function saveGreenhouses(){
  try {
    localStorage.setItem(LS_GREENHOUSES_KEY, JSON.stringify(greenhouses));
    if(activeGreenhouseId){
      localStorage.setItem(LS_ACTIVE_GH_KEY, activeGreenhouseId);
    }
  } catch(e){
    console.warn('[GrowHub] Failed to save greenhouses', e);
  }
}

function addGreenhouse(config){
  const gh = {
    id: generateGreenhouseId(),
    name: config.name || '',
    host: config.host,
    port: config.port || '8884',
    user: config.user || '',
    pass: config.pass || '',
    base: config.base,
    path: config.path || '/mqtt',
    proto: config.proto || 'wss'
  };
  greenhouses.push(gh);
  if(!activeGreenhouseId){
    activeGreenhouseId = gh.id;
  }
  saveGreenhouses();
  return gh;
}

function updateGreenhouse(id, config){
  const idx = greenhouses.findIndex(g => g.id === id);
  if(idx === -1) return null;
  greenhouses[idx] = { ...greenhouses[idx], ...config };
  saveGreenhouses();
  return greenhouses[idx];
}

function deleteGreenhouse(id){
  greenhouses = greenhouses.filter(g => g.id !== id);
  if(activeGreenhouseId === id){
    activeGreenhouseId = greenhouses.length > 0 ? greenhouses[0].id : null;
  }
  saveGreenhouses();
}

function getActiveGreenhouse(){
  if(!activeGreenhouseId) return null;
  return greenhouses.find(g => g.id === activeGreenhouseId) || null;
}

function setActiveGreenhouse(id){
  const gh = greenhouses.find(g => g.id === id);
  if(!gh) return false;
  activeGreenhouseId = id;
  localStorage.setItem(LS_ACTIVE_GH_KEY, id);
  return true;
}

function switchGreenhouse(id){
  if(!setActiveGreenhouse(id)) return false;
  const gh = getActiveGreenhouse();
  if(gh){
    // Отключаемся от текущего MQTT и подключаемся к новому
    if(manager){
      manager.disconnect();
    }
    lastState = null;
    lastStateTs = 0;
    deviceOnline = null; // Reset device status when switching
    connect(gh);
    const displayName = gh.name || 'Новая теплица';
    addLog(`Переключено на: ${displayName}`, 'connection', 'info');
  }
  return true;
}

// Публичные функции для работы с теплицами из других страниц
window.ghGreenhouses = {
  load: loadGreenhouses,
  save: saveGreenhouses,
  add: addGreenhouse,
  update: updateGreenhouse,
  delete: deleteGreenhouse,
  getActive: getActiveGreenhouse,
  setActive: setActiveGreenhouse,
  switch: switchGreenhouse,
  getAll: () => greenhouses,
  getActiveId: () => activeGreenhouseId
};
// === Конец системы управления теплицами ===

let manager = null;
let connected = false;
let deviceOnline = null; // null = unknown, true = online, false = offline (from LWT)
let baseTopic = '';
let stateTopic = '';
let setBase = '';
let lastState = null;
let lastPubMap = {}; // key -> timestamp
const PUB_THROTTLE_MS = 400; // minimal interval per key
const FORCE_STATE_INTERVAL = 35000; // if no state for this long -> show stale (должен быть > STATE_INTERVAL на ESP32)
let lastStateTs = 0;

let configFromUrl = false;

// Механизм блокировки UI обновлений на странице настроек
let lastUserInteractionTime = 0;
const UI_LOCK_DURATION = 120000; // 120 секунд после последнего взаимодействия
let isOnSettingsPage = false;

function isStagePresetProfileName(name){
  if(!name) return false;
  return /Рассада|Вегетация|Цветение/.test(String(name));
}

function applyStagePresetUi(profileName){
  const hide = isStagePresetProfileName(profileName);
  const stateRow = document.getElementById('growth-stage-row');
  if(stateRow) stateRow.style.display = hide ? 'none' : '';
  const settingsSection = document.getElementById('growth-stage-section');
  if(settingsSection) settingsSection.style.display = hide ? 'none' : '';
  const vpdSection = document.getElementById('vpd-target-section');
  if(vpdSection) vpdSection.style.display = hide ? 'none' : '';
  // Extra safety: prevent sending commands from hidden controls
  const radios = document.querySelectorAll('input[name="growth_stage"]');
  if(radios && radios.length){
    radios.forEach(r => { r.disabled = hide; });
  }

  const vpdInp = document.getElementById('inp_vpd_target_x10');
  if(vpdInp) vpdInp.disabled = hide;
  const vpdBtn = document.getElementById('btn_save_vpd_target');
  if(vpdBtn) vpdBtn.disabled = hide;
}

function formatVpdTargetX10(x10){
  const n = Number(x10);
  if(!Number.isFinite(n) || n <= 0) return 'авто';
  return (n / 10).toFixed(1) + ' kPa';
}

function isStagePresetProfileId(profileId){
  const id = Number(profileId);
  // Firmware uses PLANT_NUMS=337; stage presets are the last 3 entries: 334..336.
  // Use numeric id instead of profile_name to avoid localization/rename fragility.
  return Number.isFinite(id) && id >= 334 && id <= 336;
}

// Система логирования
let systemLogs = [];

function addLog(message, category = 'system', type = 'info'){
  const now = Date.now();
  
  // Дедупликация: не добавляем повторяющиеся логи в течение 5 секунд
  const isDuplicate = systemLogs.some(log => 
    log.message === message && 
    log.category === category && 
    (now - log.timestamp) < 5000
  );
  
  if(isDuplicate){
    return; // Игнорируем дубликат
  }
  
  const log = {
    timestamp: now,
    message: message,
    category: category, // system, connection, control, alert
    type: type // info, success, warning, error
  };
  
  systemLogs.unshift(log); // Новые записи в начало
  
  // Ограничиваем размер логов
  if(systemLogs.length > MAX_LOGS){
    systemLogs = systemLogs.slice(0, MAX_LOGS);
  }
  
  // Сохраняем в localStorage
  try {
    localStorage.setItem(LS_LOGS_KEY, JSON.stringify(systemLogs));
  } catch(e) {
    console.warn('[GrowHub:Logs] Failed to save logs to localStorage', e);
  }
}

function loadLogs(){
  try {
    const stored = localStorage.getItem(LS_LOGS_KEY);
    if(stored){
      systemLogs = JSON.parse(stored);
      // Ограничиваем размер при загрузке
      if(systemLogs.length > MAX_LOGS){
        systemLogs = systemLogs.slice(0, MAX_LOGS);
      }
    }
  } catch(e) {
    console.warn('[GrowHub:Logs] Failed to load logs from localStorage', e);
    systemLogs = [];
  }
  
  // Загружаем ESP32 логи
  try {
    const storedEsp32 = localStorage.getItem(LS_ESP32_LOGS_KEY);
    if(storedEsp32){
      const logsArray = JSON.parse(storedEsp32);
      window.esp32LogsMap = new Map();
      logsArray.forEach(log => {
        if(log.id){
          window.esp32LogsMap.set(log.id, log);
        }
      });
      window.esp32Logs = logsArray;
      console.log('[GrowHub] Загружено ESP32 логов из localStorage:', logsArray.length);
    } else {
      window.esp32LogsMap = new Map();
      window.esp32Logs = [];
    }
  } catch(e) {
    console.warn('[GrowHub:Logs] Failed to load ESP32 logs from localStorage', e);
    window.esp32LogsMap = new Map();
    window.esp32Logs = [];
  }
}

// Публичные функции для доступа к логам
window.ghGetLogs = function(){ return systemLogs; };
window.ghClearLogs = function(){
  systemLogs = [];
  window.esp32Logs = [];
  if(window.esp32LogsMap){
    window.esp32LogsMap.clear();
  }
  try {
    localStorage.removeItem(LS_LOGS_KEY);
    localStorage.removeItem(LS_ESP32_LOGS_KEY);
  } catch(e) {}
  addLog('Логи очищены', 'system', 'info');
};
window.ghAddLog = addLog;

function markUserInteraction(){
  lastUserInteractionTime = Date.now();
}

function isUIUpdateLocked(){
  // Блокируем обновления только на странице настроек и только если недавно было взаимодействие
  if(!isOnSettingsPage) return false;
  const elapsed = Date.now() - lastUserInteractionTime;
  return elapsed < UI_LOCK_DURATION;
}

const ALERT_KEYS = [
  'rebooted',
  'alert_water',
  'alert_humid',
  'alert_high_temp',
  'alert_low_temp',
  'err_sensor_temp',
  'err_sensor_hg',
  'err_sensor_hg2',
  'err_sensor_dht',
  'watering_notification_pending'
];

function isFlagActive(val){
  if(val === true || val === 1 || val === '1') return true;
  if(val === false || val === 0 || val === '0' || val === null || val === undefined) return false;
  if(typeof val === 'string'){
    const trimmed = val.trim().toLowerCase();
    if(trimmed === 'true') return true;
    if(trimmed === 'false') return false;
    const numeric = Number(trimmed);
    if(!Number.isNaN(numeric)) return numeric !== 0;
  }
  if(typeof val === 'number') return val !== 0;
  return false;
}

// UI references
const statusLine = document.getElementById('status-line');
const badgesEl = document.getElementById('badges');
const alertsBox = document.getElementById('alerts');
const lastUpdateEl = document.getElementById('last-update');
const pubStatusEl = document.getElementById('pub-status');
const cfgToggle = document.getElementById('config-toggle');
const cfgBox = document.getElementById('config-box');
const deviceNameEls = document.querySelectorAll('[data-field="name"], #device-name');

const formCfg = {
  host: document.getElementById('cfg-host'),
  port: document.getElementById('cfg-port'),
  user: document.getElementById('cfg-user'),
  pass: document.getElementById('cfg-pass'),
  base: document.getElementById('cfg-base'),
  save: document.getElementById('cfg-save'),
  clear: document.getElementById('cfg-clear')
};

// Raw URL parameter dump (long & short forms) for diagnostics
function extractUrlRaw(){
  const sp = new URLSearchParams(window.location.search);
  const raw = {
    host: sp.get('host'), port: sp.get('port'), user: sp.get('user'), pass: sp.get('pass'), topic: sp.get('topic'),
    path: sp.get('path'), proto: sp.get('proto'),
    h: sp.get('h'), p: sp.get('p'), u: sp.get('u'), pw: sp.get('pw'), b: sp.get('b'), pt: sp.get('pt'), pr: sp.get('pr')
  };
  console.log('[GrowHub:PWA] URL params raw:', raw);
  return raw;
}

const ackBox = document.getElementById('service-acks');
const ackButtons = {
  water: document.getElementById('btn_ack_water'),
  humid: document.getElementById('btn_ack_humid')
};

// Control inputs
const inputs = {
  lig_type: document.getElementById('inp_lig_type'),
  lig_hours: document.getElementById('inp_lig_hours'),
  lig_pwm: document.getElementById('inp_lig_pwm'),
  temp_day: document.getElementById('inp_temp_day'),
  temp_night: document.getElementById('inp_temp_night'),
  humgr_day: document.getElementById('inp_humgr_day'),
  humgr_night: document.getElementById('inp_humgr_night'),
  humair_day: document.getElementById('inp_humair_day'),
  humair_night: document.getElementById('inp_humair_night'),
  vent_day: document.getElementById('inp_vent_day'),
  vent_day_always: document.getElementById('chk_vent_day_always'),
  vent_night: document.getElementById('inp_vent_night'),
  vent_night_always: document.getElementById('chk_vent_night_always'),
  smart_humair_day: document.getElementById('chk_smart_humair_day'),
  smart_humair_night: document.getElementById('chk_smart_humair_night'),
  vent_interval: document.getElementById('inp_vent_interval'),
  cooling: document.getElementById('chk_cooling'),
  dehumidify: document.getElementById('chk_dehumidify'),
  alternate_watering: document.getElementById('chk_alternate_watering'),
  btn_save_advanced: document.getElementById('btn_save_advanced'),
  btn_watered: document.getElementById('btn_watered'),
  growth_stage_0: document.getElementById('gs_0'),
  growth_stage_1: document.getElementById('gs_1'),
  growth_stage_2: document.getElementById('gs_2'),
  growth_stage_3: document.getElementById('gs_3'),
  vpd_target_x10: document.getElementById('inp_vpd_target_x10'),
  vpd_target_display: document.getElementById('vpd_target_display'),
  btn_save_vpd_target: document.getElementById('btn_save_vpd_target'),
  profile: document.getElementById('inp_profile'),
  btn_profile: document.getElementById('btn_profile'),
  sync_now: document.getElementById('btn_sync_now'),
  disconnect: document.getElementById('btn_disconnect')
};

function logStatus(msg, warn=false){
  if(statusLine){
    statusLine.textContent = msg;
    statusLine.classList.toggle('warn', !!warn);
  }
}

function getStoredMqttStatus(){
  try {
    const stored = localStorage.getItem(LS_MQTT_CONNECTED);
    if(stored){
      const data = JSON.parse(stored);
      // Проверяем что статус не старше 2 минут
      if(data.timestamp && (Date.now() - data.timestamp) < 120000){
        return data.status;
      }
    }
  } catch(e) {}
  return null;
}

function setStoredMqttStatus(status){
  try {
    localStorage.setItem(LS_MQTT_CONNECTED, JSON.stringify({
      status: status,
      timestamp: Date.now()
    }));
  } catch(e) {}
}

function loadConfig(){
  const url = new URL(window.location.href);
  const p = (k)=> url.searchParams.get(k) || '';
  
  // Загружаем список теплиц
  loadGreenhouses();
  
  // Support both short (h,p,u,pw,b) and long (host,port,user,pass,topic) parameter styles
  const longParams = {
    host: p('host'),
    port: p('port'),
    user: p('user'),
    pass: p('pass'),
    base: p('topic'),
    path: p('path'),
    proto: p('proto')
  };
  const shortParams = {
    host: p('h'),
    port: p('p'),
    user: p('u'),
    pass: p('pw'),
    base: p('b'),
    path: p('pt'),
    proto: p('pr')
  };
  // Prefer long params when provided, else fall back to short
  const chosen = {};
  ['host','port','user','pass','base','path','proto'].forEach(k=>{
    if(longParams[k]) chosen[k] = longParams[k]; else if(shortParams[k]) chosen[k] = shortParams[k];
  });
  configFromUrl = Object.values(chosen).some(Boolean);
  // Normalize base topic trailing slash
  if(chosen.base && !chosen.base.endsWith('/')) chosen.base += '/';
  if(chosen.path && !chosen.path.startsWith('/')) chosen.path = '/' + chosen.path;
  
  // Если есть URL параметры - используем их и добавляем как новую теплицу
  if(configFromUrl && chosen.host && chosen.base){
    // Проверяем есть ли уже такая теплица
    const existing = greenhouses.find(g => g.host === chosen.host && g.base === chosen.base);
    if(existing){
      setActiveGreenhouse(existing.id);
      return existing;
    } else {
      // Добавляем новую теплицу из URL
      const newGh = addGreenhouse({
        name: 'Теплица (URL)',
        ...chosen
      });
      setActiveGreenhouse(newGh.id);
      return newGh;
    }
  }
  
  // Если нет URL параметров - берем активную теплицу
  const activeGh = getActiveGreenhouse();
  if(activeGh){
    return activeGh;
  }
  
  // Fallback: старая логика для совместимости
  let cfg = null;
  const stored = localStorage.getItem(LS_KEY);
  if(stored){ try { cfg = JSON.parse(stored); } catch(_){} }
  
  // Merge with stored config (URL params override stored when non-empty)
  const merged = Object.assign({}, cfg||{}, Object.fromEntries(Object.entries(chosen).filter(([,v])=>v)));
  return merged;
}

function saveConfig(cfg){
  // Сохраняем для совместимости со старым форматом
  localStorage.setItem(LS_KEY, JSON.stringify(cfg));
  
  // Также обновляем активную теплицу если она есть
  if(activeGreenhouseId){
    updateGreenhouse(activeGreenhouseId, cfg);
  }
}

function fillConfigForm(cfg){
  if(!formCfg.host) return;
  formCfg.host.value = cfg.host||'';
  formCfg.port.value = cfg.port||'';
  formCfg.user.value = cfg.user||'';
  formCfg.pass.value = cfg.pass||'';
  formCfg.base.value = cfg.base||'';
}

function ensureValidConfig(cfg){
  if(!cfg.host || !cfg.port || !cfg.base) return false;
  const portNum = Number(cfg.port);
  if(Number.isNaN(portNum) || portNum <= 0) return false;
  cfg.port = String(portNum);
  if(!cfg.base.endsWith('/')) cfg.base += '/';
  if(cfg.path && !cfg.path.startsWith('/')) cfg.path = '/' + cfg.path;
  return true;
}

function connect(cfg){
  if(!ensureValidConfig(cfg)) { 
    logStatus('MQTT не настроен', true); 
    if(cfgBox) cfgBox.classList.add('visible'); 
    return; 
  }
  saveConfig(cfg);
  currentConfig = cfg; // Сохраняем для автоматического переподключения
  baseTopic = cfg.base;
  stateTopic = baseTopic + 'state/json';
  setBase = baseTopic + 'set/';
  if(!manager){
    manager = new MQTTManager();
    attachManagerEvents();
  }
  logStatus('Подключение...');
  manager.connect(cfg).catch(err=>{
    console.error('[GrowHub:PWA] connect error', err);
    logStatus('Ошибка подключения: ' + (err && err.message ? err.message : 'неизвестно'), true);
    setStoredMqttStatus('disconnected');
  });
}
let currentConfig = null; // Сохраняем конфиг для переподключения

function attachManagerEvents(){
  if(!manager) return;
  manager.on('status', (st)=>{
    connected = (st === 'connected');
    if(st === 'connected'){
      // Брокер подключен, но статус устройства ещё неизвестен - ждём LWT
      if(deviceOnline === null){
        logStatus('Подключение к устройству...');
      } else if(deviceOnline){
        logStatus('Подключено');
      } else {
        logStatus('Устройство не в сети', true);
      }
      setStoredMqttStatus('connected');
      addLog('MQTT подключен к ' + currentConfig.host, 'connection', 'success');
      setTimeout(requestSyncHint, 300);
    } else if(st === 'reconnecting'){
      logStatus('Переподключение...');
      addLog('MQTT переподключение...', 'connection', 'warning');
    } else if(st === 'offline'){
      logStatus('Нет сети', true);
      addLog('Нет интернет-соединения', 'connection', 'error');
    } else if(st === 'disconnected'){
      // Не показываем 'Отключено' если недавно получали данные
      const timeSinceLastState = lastStateTs ? (Date.now() - lastStateTs) : Infinity;
      if(timeSinceLastState > 60000){
        logStatus('Отключено', true);
        setStoredMqttStatus('disconnected');
        addLog('MQTT отключен', 'connection', 'warning');
      }
    }
  });
  // Handle device LWT status (online/offline)
  manager.on('deviceStatus', (isOnline)=>{
    deviceOnline = isOnline;
    if(connected){
      if(isOnline){
        logStatus('Подключено');
        addLog('Устройство в сети', 'connection', 'success');
      } else {
        logStatus('Устройство не в сети', true);
        addLog('Устройство не в сети (LWT)', 'connection', 'warning');
      }
    }
  });
  manager.on('state', (js)=>{
    const previousState = lastState;
    lastState = js;
    lastStateTs = Date.now();
    
    // If we receive state, device is definitely online
    if(deviceOnline !== true){
      deviceOnline = true;
      logStatus('Подключено');
    }
    
    // Автоматическое обновление имени теплицы из gh_name
    if(js.name && activeGreenhouseId){
      const activeGh = getActiveGreenhouse();
      if(activeGh && activeGh.name !== js.name){
        updateGreenhouse(activeGreenhouseId, { name: js.name });
        // Обновляем селектор на главной странице
        const selectEl = document.getElementById('greenhouse-select');
        if(selectEl){
          const option = selectEl.querySelector(`option[value="${activeGreenhouseId}"]`);
          if(option) option.textContent = js.name;
        }
      }
    }
    
    // Генерируем CustomEvent для других страниц (time.html и т.д.)
    window.dispatchEvent(new CustomEvent('gh-state-update', { detail: js }));
    
    renderState(js);
    // Логирование изменений состояния систем
    trackSystemChanges(js, previousState);
    // Проверяем алерты для push-уведомлений
    checkAlertsForPush(js, previousState);
    // Сохраняем логи из ESP32 если они есть (с дедупликацией по ID)
    // Логи отключены в MQTT, обрабатываются только локально
    if(false && js.logs && Array.isArray(js.logs)){
      // Если мы на странице логов - обновляем отображение
      if(window.location.pathname.includes('logs.html') && typeof updateLogsDisplay === 'function'){
        updateLogsDisplay();
      }
    } else {
      console.warn('[GrowHub] Логи не получены из MQTT state:', typeof js.logs, js.logs);
    }
  });
  manager.on('alert', (alertData)=>{
    // Критические уведомления от ESP32
    handleBrowserAlert(alertData);
  });
  manager.on('cached', ()=>{
    // already handled in state event
  });
  manager.on('error', (err)=>{
    console.error('[GrowHub:PWA] MQTT error', err);
    logStatus('Ошибка: ' + (err && err.message ? err.message : 'MQTT'));
    addLog('MQTT ошибка: ' + (err && err.message ? err.message : 'неизвестно'), 'connection', 'error');
  });
}

// Отслеживание изменений состояния систем
function trackSystemChanges(current, previous){
  if(!previous) return; // Первое состояние - пропускаем
  
  // Освещение
  if(previous.light_on !== current.light_on){
    const state = current.light_on ? 'включено' : 'выключено';
    addLog(`Освещение ${state}`, 'system', 'info');
  }
  
  // Полив
  if(previous.irrigation_on !== current.irrigation_on){
    const state = current.irrigation_on ? 'запущен' : 'остановлен';
    addLog(`Полив ${state}`, 'system', current.irrigation_on ? 'success' : 'info');
  }
  
  // Обогрев
  if(previous.heating_on !== current.heating_on){
    const state = current.heating_on ? 'включен' : 'выключен';
    addLog(`Обогрев ${state} (цель: ${current.day_time ? current.temp_day : current.temp_night}°C)`, 'system', 'info');
  }
  
  // Увлажнитель воздуха
  if(previous.humidifier_on !== current.humidifier_on){
    const state = current.humidifier_on ? 'включен' : 'выключен';
    addLog(`Увлажнитель ${state}`, 'system', 'info');
  }
  
  // Вентиляция
  if(previous.vent_on !== current.vent_on){
    const state = current.vent_on ? 'включена' : 'выключена';
    addLog(`Вентиляция ${state}`, 'system', 'info');
  }
  
  // Охлаждение
  if(previous.cooling_on !== current.cooling_on){
    const state = current.cooling_on ? 'включено' : 'выключено';
    addLog(`Охлаждение ${state}`, 'system', 'info');
  }
  
  // День/Ночь
  if(previous.day_time !== current.day_time){
    const mode = current.day_time ? 'Дневной' : 'Ночной';
    addLog(`Переключение на ${mode} режим`, 'system', 'info');
  }
  
  // WiFi AP
  if(previous.ap_started !== current.ap_started){
    const state = current.ap_started ? 'запущена' : 'остановлена';
    addLog(`WiFi точка доступа ${state}`, 'connection', 'info');
  }
  
  // Изменение профиля
  if(previous.profile_id !== current.profile_id){
    addLog(`Профиль изменён: ${current.profile_name || current.profile_id}`, 'control', 'success');
  }
}

// Обработка событий браузера online/offline
window.addEventListener('online', ()=>{
  console.log('[GrowHub:PWA] Browser online');
  addLog('Интернет восстановлен', 'connection', 'success');
  if(!connected && currentConfig){
    logStatus('Восстановление связи...');
    setTimeout(()=> connect(currentConfig), 1000);
  }
});
window.addEventListener('offline', ()=>{
  console.log('[GrowHub:PWA] Browser offline');
  logStatus('Нет интернета');
  addLog('Интернет отключён', 'connection', 'error');
});
// Обработка возврата на вкладку (visibility change)
document.addEventListener('visibilitychange', ()=>{
  if(document.visibilityState === 'visible' && currentConfig){
    if(!connected){
      logStatus('Восстановление связи...');
      connect(currentConfig);
    } else {
      // Запросить свежие данные при возврате на вкладку
      requestSyncHint();
    }
  }
});
function renderState(js){
  // Пропускаем обновление UI если пользователь активно настраивает
  const locked = isUIUpdateLocked();
  if(locked){
    console.log('[GrowHub:UI] Update locked - user is adjusting settings');
  }
  
  const alertStates = {};
  ALERT_KEYS.forEach(key=>{
    // rebooted имеет инвертированную логику: показываем алерт когда rebooted=0 (т.е. после перезагрузки)
    // Но НЕ показываем если lig_hours=0 или 24 (освещение постоянно вкл/выкл)
    if(key === 'rebooted'){
      const ligHours = Number(js.lig_hours);
      alertStates[key] = !isFlagActive(js[key]) && ligHours !== 0 && ligHours !== 24;
    } else {
      alertStates[key] = isFlagActive(js[key]);
    }
  });
  const ventDayAlways = isFlagActive(js.vent_day_always);
  const ventNightAlways = isFlagActive(js.vent_night_always);
  // Debug alerts (uncomment if needed)
  // console.log('Alerts state:', {
  //   alert_water: alertStates.alert_water, alert_humid: alertStates.alert_humid,
  //   alert_high_temp: alertStates.alert_high_temp, alert_low_temp: alertStates.alert_low_temp,
  //   err_sensor_temp: alertStates.err_sensor_temp, err_sensor_hg: alertStates.err_sensor_hg,
  //   err_sensor_dht: alertStates.err_sensor_dht
  // });
  
  // Primary numeric / text fields
  document.querySelectorAll('[data-field]').forEach(el=>{
  const k = el.getAttribute('data-field'); 
        // Actuator states - special handling 
    if(k === 'cooling_state'){
      el.textContent = js.cooling_on ? 'вкл' : 'выкл';
    } else if (k === 'vpd_mode') {
      const vpdX10 = Number(js.vpd_target_x10);
      el.textContent = (Number.isFinite(vpdX10) && vpdX10 > 0) ? 'Ручной' : 'По фазе';
    } else if(k === 'cooling_enabled' || k === 'dehumidify' || k === 'alternate_watering'){
      el.textContent = isFlagActive(js[k]) ? 'вкл' : 'выкл';
    } else if(k === 'smart_humair'){
      el.textContent = isFlagActive(js.smart_humair) ? 'вкл' : 'выкл';
    } else if(k === 'vpd_target_x10'){
      el.textContent = formatVpdTargetX10(js.vpd_target_x10);
    } else if(k in js){
      // humair_now показываем без "(авто)" - авто показывается только в целевых значениях день/ночь
      if(k === 'growth_stage_name'){
        el.textContent = js.growth_stage_name || '';
      } else if(k === 'growth_stage'){
        const stageMap = {0:'Универсальный',1:'Проращивание',2:'Вегетация',3:'Цветение'};
        el.textContent = stageMap[js.growth_stage] || String(js.growth_stage);
      } else {
        el.textContent = js[k];
      }
    }
  });
  // Device name special case
  if(js.name && deviceNameEls.length){ deviceNameEls.forEach(el=> el.textContent = js.name); }
  // Live slider labels (used in settings.html and state.html)
  document.querySelectorAll('[data-live]').forEach(el=>{
    const k = el.getAttribute('data-live');
    if(k in js){
      const suffix = el.getAttribute('data-suffix') || '';
      const val = js[k];
      if ((k === 'vent_day' && ventDayAlways) || (k === 'vent_night' && ventNightAlways)) {
        el.textContent = 'вкл';
      } else if (suffix && (val === 0 || val === '0')) {
        // Для state.html: показываем "выкл" вместо "0" когда есть суффикс
        el.textContent = 'выкл';
      } else if (suffix) {
        // Для state.html: добавляем суффикс (°C, %, мин)
        let text = val + suffix;
        // Добавляем (авто) если включен умный контроль влажности воздуха
        if ((k === 'humair_day' || k === 'humair_night') && isFlagActive(js.smart_humair)) {
          text += '(авто)';
        }
        el.textContent = text;
      } else {
        el.textContent = val;
      }
    }
  });
  document.querySelectorAll('[data-field="vent_day_unit"]').forEach(el=>{
    el.textContent = ventDayAlways ? '' : ' мин';
  });
  document.querySelectorAll('[data-field="vent_night_unit"]').forEach(el=>{
    el.textContent = ventNightAlways ? '' : ' мин';
  });
  // Вентиляция display: "выкл" при 0, "вкл" при always, иначе "X мин"
  document.querySelectorAll('[data-field="vent_day_display"]').forEach(el=>{
    if(ventDayAlways) el.textContent = 'вкл';
    else if(js.vent_day !== undefined) el.textContent = (js.vent_day === 0 || js.vent_day === '0') ? 'выкл' : js.vent_day + ' мин';
  });
  document.querySelectorAll('[data-field="vent_night_display"]').forEach(el=>{
    if(ventNightAlways) el.textContent = 'вкл';
    else if(js.vent_night !== undefined) el.textContent = (js.vent_night === 0 || js.vent_night === '0') ? 'выкл' : js.vent_night + ' мин';
  });
  // Температура display: "выкл" при 0, иначе "X°C"
  document.querySelectorAll('[data-field="temp_day_display"]').forEach(el=>{
    if('temp_day' in js) el.textContent = (js.temp_day === 0 || js.temp_day === '0') ? 'выкл' : js.temp_day + '°C';
  });
  document.querySelectorAll('[data-field="temp_night_display"]').forEach(el=>{
    if('temp_night' in js) el.textContent = (js.temp_night === 0 || js.temp_night === '0') ? 'выкл' : js.temp_night + '°C';
  });
  // Влажность почвы display: "выкл" при 0, иначе "X%"
  document.querySelectorAll('[data-field="humgr_day_display"]').forEach(el=>{
    if('humgr_day' in js) el.textContent = (js.humgr_day === 0 || js.humgr_day === '0') ? 'выкл' : js.humgr_day + '%';
  });
  document.querySelectorAll('[data-field="humgr_night_display"]').forEach(el=>{
    if('humgr_night' in js) el.textContent = (js.humgr_night === 0 || js.humgr_night === '0') ? 'выкл' : js.humgr_night + '%';
  });
  // Влажность воздуха display: "выкл" при 0, иначе "X%"
  document.querySelectorAll('[data-field="humair_day_display"]').forEach(el=>{
    if('humair_day' in js){
      let text = (js.humair_day === 0 || js.humair_day === '0') ? 'выкл' : js.humair_day + '%';
      if(isFlagActive(js.smart_humair)) text += ' (авто)';
      el.textContent = text;
    }
  });
  document.querySelectorAll('[data-field="humair_night_display"]').forEach(el=>{
    if('humair_night' in js){
      let text = (js.humair_night === 0 || js.humair_night === '0') ? 'выкл' : js.humair_night + '%';
      if(isFlagActive(js.smart_humair)) text += ' (авто)';
      el.textContent = text;
    }
  });

  // UI rule: show either Growth Stage (auto) OR Manual VPD target.
  // When vpd_target_x10 > 0: user manually set VPD target, hide growth stage, show VPD target.
  // When vpd_target_x10 = 0: use stage-based VPD, show growth stage, hide VPD target row.
  const stageRow = document.getElementById('growth-stage-row');
  const vpdRow = document.getElementById('vpd-target-row');
  if(stageRow || vpdRow){
    const vpdX10 = Number(js.vpd_target_x10);
    const hasManualVpd = Number.isFinite(vpdX10) && vpdX10 > 0;
    if(stageRow) stageRow.style.display = hasManualVpd ? 'none' : '';
    if(vpdRow) vpdRow.style.display = hasManualVpd ? '' : 'none';
  }
  // Update control values if user not dragging AND UI not locked
  if(!locked){
    syncInputIfIdle(inputs.lig_type, js.lig_type);
    syncInputIfIdle(inputs.lig_hours, js.lig_hours);
    syncInputIfIdle(inputs.lig_pwm, js.lig_pwm);
    syncInputIfIdle(inputs.temp_day, js.temp_day);
    syncInputIfIdle(inputs.temp_night, js.temp_night);
    syncInputIfIdle(inputs.humgr_day, js.humgr_day);
    syncInputIfIdle(inputs.humgr_night, js.humgr_night);
    syncInputIfIdle(inputs.humair_day, js.humair_day);
    syncInputIfIdle(inputs.humair_night, js.humair_night);
    syncInputIfIdle(inputs.vent_day, js.vent_day);
    syncInputIfIdle(inputs.vent_night, js.vent_night);
    syncInputIfIdle(inputs.vent_interval, js.vent_interval);
    syncCheckbox(inputs.vent_day_always, js.vent_day_always, inputs.vent_day);
    syncCheckbox(inputs.vent_night_always, js.vent_night_always, inputs.vent_night);
  }
  
  // Синхронизация режима чередования полива (только если UI не заблокирован)
  if(!locked && inputs.alternate_watering && js.alternate_watering !== undefined){
    inputs.alternate_watering.checked = isFlagActive(js.alternate_watering);
    // Активируем кнопку "Полив выполнен" если режим включён
    if(inputs.btn_watered){
      inputs.btn_watered.disabled = !inputs.alternate_watering.checked;
    }
  }
  // Синхронизация режима осушения
  if(!locked && inputs.dehumidify && js.dehumidify !== undefined){
    inputs.dehumidify.checked = isFlagActive(js.dehumidify);
  }
  // Синхронизация режима охлаждения (state/json: cooling_enabled)
  if(!locked && inputs.cooling && js.cooling_enabled !== undefined){
    inputs.cooling.checked = isFlagActive(js.cooling_enabled);
  }
  // Синхронизация фазы роста (VPD)
  if(!locked && js.growth_stage !== undefined){
    const stage = parseInt(js.growth_stage);
    const radioMap = {
      0: inputs.growth_stage_0,
      1: inputs.growth_stage_1,
      2: inputs.growth_stage_2,
      3: inputs.growth_stage_3
    };
    if(radioMap[stage]){
      radioMap[stage].checked = true;
    }
  }

  // Синхронизация цели VPD (vpd_target_x10)
  if(js.vpd_target_x10 !== undefined){
    const disp = inputs.vpd_target_display;
    if(disp) disp.textContent = formatVpdTargetX10(js.vpd_target_x10);
    if(!locked && inputs.vpd_target_x10 && document.activeElement !== inputs.vpd_target_x10){
      inputs.vpd_target_x10.value = String(js.vpd_target_x10);
    }
  }
  // Синхронизация умного контроля влажности воздуха
  if(!locked && js.smart_humair !== undefined){
    const dayBox = inputs.smart_humair_day;
    const nightBox = inputs.smart_humair_night;
    if(dayBox) syncCheckbox(dayBox, js.smart_humair, inputs.humair_day);
    if(nightBox) syncCheckbox(nightBox, js.smart_humair, inputs.humair_night);
    const lock = isFlagActive(js.smart_humair);
    if(inputs.humair_day){ inputs.humair_day.classList.toggle('locked', lock); inputs.humair_day.disabled = lock; }
    if(inputs.humair_night){ inputs.humair_night.classList.toggle('locked', lock); inputs.humair_night.disabled = lock; }
  }
  // Показываем статус ожидания полива (всегда обновляем - это не мешает настройке)
  const wateringStatus = document.getElementById('watering-status');
  const wateringStatusText = document.getElementById('watering-status-text');
  if(wateringStatus){
    const showStatus = isFlagActive(js.alternate_watering) && isFlagActive(js.watering_notification_pending);
    wateringStatus.style.display = showStatus ? 'block' : 'none';
  }
  
  if(!locked && typeof updateSliderValue === 'function'){
    if(inputs.vent_day) updateSliderValue(inputs.vent_day);
    if(inputs.vent_night) updateSliderValue(inputs.vent_night);
    if(inputs.humair_day) updateSliderValue(inputs.humair_day);
    if(inputs.humair_night) updateSliderValue(inputs.humair_night);
  }
  // Sync AP mode select (только если не в фокусе и UI не заблокирован)
  if(!locked && js.ap_mode !== undefined){
    const apSelect = document.querySelector('select[name="ap_mode"]');
    if(apSelect && document.activeElement !== apSelect){
      apSelect.value = String(js.ap_mode);
    }
  }
  // Badges
  if(badgesEl) badgesEl.innerHTML='';
  if(badgesEl){
    const badge = (txt, cls)=>{ const b=document.createElement('div'); b.className='badge '+cls; b.textContent=txt; badgesEl.appendChild(b); };
    badge(js.day_time? 'DAY':'NIGHT', js.day_time? 'day':'night');
  }
  // День/Ночь режим на странице состояния
  const dayNightEls = document.querySelectorAll('[data-field="day_night_mode"]');
  if(dayNightEls.length){
    const modeText = js.day_time ? 'День' : 'Ночь';
    dayNightEls.forEach(el=> el.textContent = modeText);
  }
  const typeEls = document.querySelectorAll('[data-field="lig_type_name"]');
  if(typeEls.length){
    const typeMap = {0:'Авто',1:'Рост',2:'Цветение'};
    const typeValue = (js.lig_type !== undefined && js.lig_type in typeMap) ? typeMap[js.lig_type] : js.lig_type;
    typeEls.forEach(el=> el.textContent = typeValue ?? '—');
  }
  // AP mode derived fields
  const apModeLabelEls = document.querySelectorAll('[data-field="ap_mode_label"]');
  if(apModeLabelEls.length && js.ap_mode !== undefined){
    const apModeText = js.ap_mode === 1 ? 'Всегда включена' : 'Автоматическое переключение';
    apModeLabelEls.forEach(el=> el.textContent = apModeText);
  }
  const apStateEls = document.querySelectorAll('[data-field="ap_state"]');
  if(apStateEls.length && js.ap_started !== undefined){
    const apStateText = js.ap_started === 1 ? 'Включена' : 'Выключена';
    apStateEls.forEach(el=> el.textContent = apStateText);
  }

  // Hide growth-stage UI for stage preset profiles (Рассада/Вегетация/Цветение)
  applyStagePresetUi(js.profile_name);

  // Alerts - always process all alerts to ensure proper hide/show
  if(alertsBox){
    let hasActiveAlerts = false;
    const wrapper = alertsBox.closest('.alerts-section');
    
    alertsBox.querySelectorAll('[data-alert]').forEach(el=>{
      const key = el.getAttribute('data-alert');
      const isActive = key in alertStates ? alertStates[key] : isFlagActive(js[key]);
      // Always update display to ensure state is fresh
      el.style.display = isActive ? 'flex' : 'none';
      if(isActive) hasActiveAlerts = true;
    });
    
    // Hide/show entire alerts section based on active alerts
    if(wrapper){
      wrapper.style.display = hasActiveAlerts ? 'block' : 'none';
    }
  }
  if(ackBox){
  const showWater = alertStates.alert_water;
  const showHumid = alertStates.alert_humid;
    ackBox.classList.toggle('hidden', !(showWater || showHumid));
    if(ackButtons.water) ackButtons.water.classList.toggle('hidden', !showWater);
    if(ackButtons.humid) ackButtons.humid.classList.toggle('hidden', !showHumid);
  }
  if(js.profile_id !== undefined){
    const curIdStr = String(js.profile_id);
    const customSel = document.getElementById('profile_custom');
    if(customSel){
      if(js.profile_id >= 0 && js.profile_id <= 4){
        customSel.value = curIdStr;
      }
    }
    document.querySelectorAll('select[data-plant-select]').forEach(sel=>{
      const has = Array.from(sel.options).some(opt=> opt.value === curIdStr);
      if(has) sel.value = curIdStr;
    });
  }
  if(lastUpdateEl) lastUpdateEl.textContent = 'Обновлено: ' + new Date().toLocaleTimeString();
}

function syncInputIfIdle(input, value){
  if(!input) return;
  if(document.activeElement === input) return; // user editing
  if(String(input.value) !== String(value)) input.value = value;
  const live = document.querySelector(`[data-live="${input.id.replace('inp_','')}"]`);
  if(live) live.textContent = value;
}

function syncCheckbox(input, value, slider){
  if(!input) return;
  const desired = isFlagActive(value);
  if(input.checked !== desired) input.checked = desired;
  if(slider && typeof updateSliderValue === 'function') updateSliderValue(slider);
}

function publish(key, val){
  if(!manager) return false;
  const now = Date.now();
  if(lastPubMap[key] && (now - lastPubMap[key] < PUB_THROTTLE_MS)) return true; // throttled but treated as success
  lastPubMap[key] = now;
  const result = manager.publish(key, String(val));
  if(result) flashPub(`${key}=${val}`);
  return result;
}
// Expose for inline forms on other pages
window.ghPublish = publish;

// Helper function to show "Saved" state on buttons
function showSavedState(button, savedText = 'Сохранено ✓', originalText = null, duration = 2000, isError = false){
  if(!button) return;
  
  // Determine if it's an input or button element
  const isInput = button.tagName === 'INPUT';
  const textProp = isInput ? 'value' : 'textContent';
  
  if(!originalText) originalText = button[textProp];
  button[textProp] = savedText;
  button.disabled = true;

  // Сохраняем исходный цвет
  const originalColor = button.style.color;
  if(isError) {
    button.style.color = '#ff4444';
  }

  const wrap = button.closest('[data-save-wrap]');
  const status = wrap ? wrap.querySelector('.save-status') : null;
  if(status){
    status.textContent = isError ? 'ошибка' : 'сохранено';
    status.classList.add('active');
    if(isError) {
      status.style.color = '#ff4444';
    }
    if(status._hideTimer) clearTimeout(status._hideTimer);
    status._hideTimer = setTimeout(()=>{
      status.classList.remove('active');
      status.textContent = '';
      status.style.color = '';
      status._hideTimer = null;
    }, duration);
  }
  
  setTimeout(() => {
    button[textProp] = originalText;
    button.disabled = false;
    button.style.color = originalColor;
  }, duration);
}
// Expose for inline forms on other pages
window.ghShowSaved = showSavedState;

// Helper function to show feedback next to checkboxes
function showCheckboxFeedback(checkbox, success, duration = 2000){
  if(!checkbox) return;
  const label = checkbox.closest('.toggle-option') || checkbox.parentNode;
  if(!label) return;
  
  // Удаляем старый feedback если есть
  const existingFeedback = label.querySelector('.feedback-msg');
  if(existingFeedback) existingFeedback.remove();
  
  const feedback = document.createElement('span');
  feedback.className = 'feedback-msg';
  feedback.style.fontSize = '12px';
  feedback.style.marginLeft = '5px';
  if(success){
    feedback.textContent = ' ✓';
    feedback.style.color = '#44ff44';
  } else {
    feedback.textContent = ' ✗ нет связи';
    feedback.style.color = '#ff4444';
  }
  label.appendChild(feedback);
  setTimeout(() => feedback.remove(), duration);
}
// Expose for inline checkbox handlers
window.ghShowCheckboxFeedback = showCheckboxFeedback;

function flashPub(msg){
  if(!pubStatusEl) return;
  pubStatusEl.textContent = 'Отправлено: ' + msg;
  pubStatusEl.classList.add('fade');
  setTimeout(()=> pubStatusEl.classList.remove('fade'), 600);
}

function bindControls(){
  const ranged = [
    ['lig_hours','inp_lig_hours'],
    ['lig_pwm','inp_lig_pwm'],
    ['temp_day','inp_temp_day'],
    ['temp_night','inp_temp_night'],
    ['humgr_day','inp_humgr_day'],
    ['humgr_night','inp_humgr_night'],
    ['humair_day','inp_humair_day'],
    ['humair_night','inp_humair_night']
    ,['vent_interval','inp_vent_interval']
  ];
  ranged.forEach(([key,id])=>{
    const el = document.getElementById(id);
    if(!el) return;
    // Отслеживаем взаимодействие пользователя с слайдерами
    el.addEventListener('input', ()=>{
      markUserInteraction();
      const live = document.querySelector(`[data-live="${key}"]`); if(live) live.textContent = el.value;
    });
    el.addEventListener('mousedown', markUserInteraction);
    el.addEventListener('touchstart', markUserInteraction);
    el.addEventListener('focus', markUserInteraction);
    // Убрана автоматическая отправка - только при нажатии кнопки "Сохранить"
  });
  
  // Отслеживаем взаимодействие с другими контролами
  if(inputs.lig_type){
    inputs.lig_type.addEventListener('change', ()=>{
      markUserInteraction();
      publish('lig_type', inputs.lig_type.value);
    });
    inputs.lig_type.addEventListener('focus', markUserInteraction);
  }
  
  // Отслеживаем вентиляцию
  if(inputs.vent_day){
    inputs.vent_day.addEventListener('input', markUserInteraction);
    inputs.vent_day.addEventListener('mousedown', markUserInteraction);
    inputs.vent_day.addEventListener('touchstart', markUserInteraction);
  }
  if(inputs.vent_night){
    inputs.vent_night.addEventListener('input', markUserInteraction);
    inputs.vent_night.addEventListener('mousedown', markUserInteraction);
    inputs.vent_night.addEventListener('touchstart', markUserInteraction);
  }
  if(inputs.vent_day_always) inputs.vent_day_always.addEventListener('change', markUserInteraction);
  if(inputs.vent_night_always) inputs.vent_night_always.addEventListener('change', markUserInteraction);

  // VPD target (x10)
  if(inputs.vpd_target_x10){
    inputs.vpd_target_x10.addEventListener('input', ()=>{
      markUserInteraction();
      if(inputs.vpd_target_display) inputs.vpd_target_display.textContent = formatVpdTargetX10(inputs.vpd_target_x10.value);

      // Явный VPD -> фаза роста игнорируется (визуально отключаем радиокнопки)
      const raw = String(inputs.vpd_target_x10.value || '').trim();
      let vv = raw.length ? parseInt(raw, 10) : 0;
      if(Number.isNaN(vv)) vv = 0;
      const disable = vv > 0;
      const radios = document.querySelectorAll('input[name="growth_stage"]');
      radios.forEach(r => { r.disabled = disable; });
    });
    inputs.vpd_target_x10.addEventListener('focus', markUserInteraction);

    // initial state
    const raw0 = String(inputs.vpd_target_x10.value || '').trim();
    let vv0 = raw0.length ? parseInt(raw0, 10) : 0;
    if(Number.isNaN(vv0)) vv0 = 0;
    const disable0 = vv0 > 0;
    const radios0 = document.querySelectorAll('input[name="growth_stage"]');
    radios0.forEach(r => { r.disabled = disable0; });
  }
  if(inputs.btn_save_vpd_target){
    inputs.btn_save_vpd_target.addEventListener('click', ()=>{
      markUserInteraction();

      if(isStagePresetProfileId(lastState && lastState.profile_id)){
        showSavedState(inputs.btn_save_vpd_target, 'Заблокировано профилем', null, 2200, true);
        return;
      }

      // Единая форма: если указан VPD > 0 -> публикуем только VPD (фаза игнорируется)
      // иначе (VPD пустой/0) -> публикуем growth_stage (а VPD берётся прошивкой по фазе)
      const raw = String(inputs.vpd_target_x10 ? inputs.vpd_target_x10.value : '').trim();
      let v = raw.length ? parseInt(raw, 10) : 0;
      if(Number.isNaN(v)) v = 0;
      v = Math.max(0, Math.min(25, v));
      if(inputs.vpd_target_x10) inputs.vpd_target_x10.value = String(v);
      if(inputs.vpd_target_display) inputs.vpd_target_display.textContent = formatVpdTargetX10(v);

      let ok = true;
      if(v > 0){
        ok = publish('vpd_target', v);
      } else {
        // Exit manual VPD mode: explicitly clear manual target first.
        ok = publish('vpd_target', 0);

        const checked = document.querySelector('input[name="growth_stage"]:checked');
        if(!checked){
          showSavedState(inputs.btn_save_vpd_target, 'Выберите фазу', null, 2000, true);
          return;
        }
        ok = ok && publish('growth_stage', checked.value);
      }

      showSavedState(inputs.btn_save_vpd_target, ok ? 'Сохранено ✓' : 'Ошибка: нет связи ✗', null, 2000, !ok);
    });
  }

  const hasAdvancedSave = !!inputs.btn_save_advanced;
  // Для settings.html: если есть кнопка "Сохранить" в дополнительных опциях,
  // то не публикуем изменения сразу (как в локальном site_settings).
  if(inputs.cooling){
    inputs.cooling.addEventListener('change', function(){
      markUserInteraction();
      if(!hasAdvancedSave){
        const success = publish('cooling', this.checked ? 1 : 0);
        showCheckboxFeedback(this, success);
      }
    });
  }
  if(inputs.dehumidify){
    inputs.dehumidify.addEventListener('change', function(){
      markUserInteraction();
      if(!hasAdvancedSave){
        const success = publish('dehumidify', this.checked ? 1 : 0);
        showCheckboxFeedback(this, success);
      }
    });
  }
  if(inputs.alternate_watering){
    inputs.alternate_watering.addEventListener('change', function(){
      markUserInteraction();
      if(!hasAdvancedSave){
        const success = publish('alternate_watering', this.checked ? 1 : 0);
        showCheckboxFeedback(this, success);
      }
    });
  }
  const smartHumBoxes = [inputs.smart_humair_day, inputs.smart_humair_night].filter(Boolean);
  if(smartHumBoxes.length){
    smartHumBoxes.forEach(box=>{
      box.addEventListener('change', function(){
        markUserInteraction();
        const checked = this.checked;
        // Держим оба переключателя в одном состоянии
        smartHumBoxes.forEach(other=>{ if(other !== this) other.checked = checked; });
        const success = publish('smart_humair', checked ? 1 : 0);
        showCheckboxFeedback(this, success);
        if(typeof updateSliderValue === 'function'){
          if(inputs.humair_day) updateSliderValue(inputs.humair_day);
          if(inputs.humair_night) updateSliderValue(inputs.humair_night);
        }
        // Лочим/разлочим слайдеры при переключении чекбокса
        const lock = checked;
        if(inputs.humair_day){ inputs.humair_day.classList.toggle('locked', lock); inputs.humair_day.disabled = lock; }
        if(inputs.humair_night){ inputs.humair_night.classList.toggle('locked', lock); inputs.humair_night.disabled = lock; }
      });
    });
  }
  
  // Отслеживаем select элементы
  const apModeSelect = document.querySelector('select[name="ap_mode"]');
  if(apModeSelect){
    apModeSelect.addEventListener('focus', markUserInteraction);
    apModeSelect.addEventListener('change', markUserInteraction);
  }
  
  if(inputs.btn_profile) inputs.btn_profile.addEventListener('click', ()=>{ const v = inputs.profile.value.trim(); if(v) publish('profile', v); });
  if(inputs.sync_now) inputs.sync_now.addEventListener('click', requestSyncHint);
  if(inputs.disconnect) inputs.disconnect.addEventListener('click', ()=>{ if(manager){ manager.disconnect(); } });
  if(ackButtons.water) ackButtons.water.addEventListener('click', function(){
    const btn = this;
    const success = publish('refill','water');
    if(success){
      btn.textContent = 'Сохранено ✓';
      btn.disabled = true;
      setTimeout(() => {
        btn.classList.add('hidden');
        btn.disabled = false;
        btn.textContent = '💧 Бак залит';
      }, 2000);
    } else {
      const originalText = btn.textContent;
      btn.textContent = 'Ошибка: нет связи ✗';
      btn.style.color = '#ff4444';
      btn.disabled = true;
      setTimeout(() => {
        btn.textContent = originalText;
        btn.style.color = '';
        btn.disabled = false;
      }, 2000);
    }
  });
  if(ackButtons.humid) ackButtons.humid.addEventListener('click', function(){
    const btn = this;
    const success = publish('refill','humid');
    if(success){
      btn.textContent = 'Сохранено ✓';
      btn.disabled = true;
      setTimeout(() => {
        btn.classList.add('hidden');
        btn.disabled = false;
        btn.textContent = '💨 Увлажнитель залит';
      }, 2000);
    } else {
      const originalText = btn.textContent;
      btn.textContent = 'Ошибка: нет связи ✗';
      btn.style.color = '#ff4444';
      btn.disabled = true;
      setTimeout(() => {
        btn.textContent = originalText;
        btn.style.color = '';
        btn.disabled = false;
      }, 2000);
    }
  });
}

function requestSyncHint(){
  // There is no explicit sync topic; rely on retained state and firmware periodic publish.
  // We can force re-subscribe to provoke broker to resend retained message.
  if(manager && connected){ manager.resubscribe(); }
}

// Config UI toggle
// Config toggle
if(cfgToggle && cfgBox){
  cfgToggle.addEventListener('click', ()=>{
    cfgBox.classList.toggle('visible');
  });
}

if(formCfg.save){
  formCfg.save.addEventListener('click', ()=>{
    const cfg = {
      host: formCfg.host.value.trim(),
      port: formCfg.port.value.trim(),
      user: formCfg.user.value.trim(),
      pass: formCfg.pass.value.trim(),
      base: formCfg.base.value.trim()
    };
    
    // Проверяем есть ли уже такая теплица
    const existing = greenhouses.find(g => g.host === cfg.host && g.base === cfg.base);
    if(existing){
      // Обновляем существующую
      updateGreenhouse(existing.id, cfg);
      setActiveGreenhouse(existing.id);
    } else if(cfg.host && cfg.base){
      // Добавляем новую теплицу
      const newGh = addGreenhouse({
        name: 'Теплица ' + (greenhouses.length + 1),
        ...cfg
      });
      setActiveGreenhouse(newGh.id);
    }
    
    if(cfgBox) cfgBox.classList.remove('visible');
    connect(cfg);
    // Для настроек подключения всегда успешно (сохраняем локально)
    showSavedState(formCfg.save, false);
    
    // Обновляем селектор теплиц
    setTimeout(initGreenhouseSelector, 100);
  });
}
if(formCfg.clear){
  formCfg.clear.addEventListener('click', ()=>{
    localStorage.removeItem(LS_KEY);
    Object.values(formCfg).forEach(v=>{ if(v && v.tagName==='INPUT') v.value=''; });
    if(statusLine) statusLine.textContent = 'Настройки очищены';
  });
}

function periodic(){
  const now = Date.now();
  if(statusLine && lastStateTs && now - lastStateTs > FORCE_STATE_INTERVAL){
    statusLine.textContent = connected ? 'Подключено (старая телеметрия, запрос обновления...)' : statusLine.textContent;
    if(connected) requestSyncHint();
  }
  requestAnimationFrame(()=> setTimeout(periodic, 3000));
}

function init(){
  // Загружаем логи из localStorage
  loadLogs();
  
  // Определяем текущую страницу для управления блокировкой UI
  const pathname = window.location.pathname;
  isOnSettingsPage = pathname.endsWith('settings.html');
  if(isOnSettingsPage){
    console.log('[GrowHub:UI] Settings page detected - UI lock enabled');
  }
  
  addLog('PWA запущено', 'system', 'info');
  
  const rawParams = extractUrlRaw();
  const cfg = loadConfig();
  // Force fill from URL (prefer long names) before merging display
  if(formCfg.host && (rawParams.host || rawParams.h)) formCfg.host.value = rawParams.host || rawParams.h || '';
  if(formCfg.port && (rawParams.port || rawParams.p)) formCfg.port.value = rawParams.port || rawParams.p || '';
  if(formCfg.user && (rawParams.user || rawParams.u)) formCfg.user.value = rawParams.user || rawParams.u || '';
  if(formCfg.pass && (rawParams.pass || rawParams.pw)) formCfg.pass.value = rawParams.pass || rawParams.pw || '';
  if(formCfg.base && (rawParams.topic || rawParams.b)) formCfg.base.value = (rawParams.topic || rawParams.b || '');
  // Now overwrite with merged cfg only for fields still empty (avoid clobbering URL intention)
  if(formCfg.host && !formCfg.host.value) formCfg.host.value = cfg.host || '';
  if(formCfg.port && !formCfg.port.value) formCfg.port.value = cfg.port || '';
  if(formCfg.user && !formCfg.user.value) formCfg.user.value = cfg.user || '';
  if(formCfg.pass && !formCfg.pass.value) formCfg.pass.value = cfg.pass || '';
  if(formCfg.base && !formCfg.base.value) formCfg.base.value = cfg.base || '';
  // Reflect final cfg object for connection logic (safely handle null elements)
  if(formCfg.host) cfg.host = formCfg.host.value.trim();
  if(formCfg.port) cfg.port = formCfg.port.value.trim();
  if(formCfg.user) cfg.user = formCfg.user.value.trim();
  if(formCfg.pass) cfg.pass = formCfg.pass.value.trim();
  if(formCfg.base) cfg.base = formCfg.base.value.trim();
  if(configFromUrl){
    saveConfig(cfg);
    if(cfgBox) cfgBox.classList.remove('visible');
  }
  
  // Initialize alerts section as hidden on page load
  const alertsSection = document.querySelector('.alerts-section');
  if(alertsSection){
    alertsSection.style.display = 'none';
    // Hide all individual alerts initially
    const alertsBox = document.getElementById('alerts');
    if(alertsBox){
      alertsBox.querySelectorAll('[data-alert]').forEach(el=>{
        el.style.display = 'none';
      });
    }
  }
  
  // Если нет сохраненной конфигурации - показать форму или предупреждение
  const isMainPage = window.location.pathname.endsWith('index.html') || 
                     window.location.pathname.endsWith('/') ||
                     window.location.pathname === '';
  if(!ensureValidConfig(cfg)) {
    if(isMainPage) {
      // На главной странице показать форму настроек
      if(cfgBox) cfgBox.classList.add('visible');
      logStatus('MQTT не настроен', true);
    } else {
      // На остальных страницах просто показать статус
      logStatus('MQTT не настроен', true);
      return; // не подключаемся
    }
  } else {
    logStatus('Автозагрузка конфигурации...');
    // Проверяем сохраненный статус MQTT
    const storedStatus = getStoredMqttStatus();
    if(storedStatus === 'connected'){
      logStatus('Подключено');
    }
    connect(cfg);
  }
  bindControls();
  periodic();
  if('serviceWorker' in navigator){
    navigator.serviceWorker.register('service-worker.js').catch(()=>{});
  }
}

// Handle browser alerts from MQTT
function handleBrowserAlert(alertData){
  const {type, message, timestamp} = alertData;
  console.log('[GrowHub:Alert]', type, message);

  // Показываем push-уведомление если доступно
  if(window.pushManager && window.pushManager.config && window.pushManager.config.enabled){
    window.pushManager.showGrowHubAlert(type, alertData);
  }

  // Также показываем в статус-строке
  logStatus(`⚠️ ${message}`, true);
}

// Инициализация push-уведомлений при изменении состояния
function checkAlertsForPush(state, previousState){
  if(!window.pushManager || !window.pushManager.config || !window.pushManager.config.enabled) return;
  if(!previousState) return; // Первый рендер - пропускаем
  
  const alertKeys = ['alert_water', 'alert_humid', 'alert_high_temp', 'alert_low_temp', 
                     'err_sensor_temp', 'err_sensor_hg', 'err_sensor_hg2', 'err_sensor_dht'];
  
  const alertNames = {
    alert_water: 'Пустой бак для полива',
    alert_humid: 'Пустой бак увлажнителя',
    alert_high_temp: 'Высокая температура',
    alert_low_temp: 'Низкая температура',
    err_sensor_temp: 'Ошибка датчика температуры',
    err_sensor_hg: 'Ошибка датчика влажности почвы №1',
    err_sensor_hg2: 'Ошибка датчика влажности почвы №2',
    err_sensor_dht: 'Ошибка датчика DHT22'
  };
  
  alertKeys.forEach(key => {
    const wasActive = isFlagActive(previousState[key]);
    const isActive = isFlagActive(state[key]);
    
    // Отправляем уведомление только при переходе из неактивного в активное
    if(!wasActive && isActive){
      console.log('[GrowHub:Push] Alert activated:', key);
      addLog(`Алерт: ${alertNames[key] || key}`, 'alert', 'warning');
      window.pushManager.showGrowHubAlert(key, {
        temp: state.temp_now,
        humgr: state.humgr_now,
        humair: state.humair_now
      });
    }
  });
  
  // Обработка уведомления о необходимости ручного полива (чередование)
  const wasWateringPending = isFlagActive(previousState.watering_notification_pending);
  const isWateringPending = isFlagActive(state.watering_notification_pending);
  if(!wasWateringPending && isWateringPending){
    console.log('[GrowHub:Push] Manual watering turn (alternate mode)');
    window.pushManager.showGrowHubAlert('watering_notification_pending', {
      humgr: state.humgr_now
    });
  }
  
  // Специальная обработка rebooted (инвертированная логика)
  const wasRebooted = !isFlagActive(previousState.rebooted);
  const isRebooted = !isFlagActive(state.rebooted);
  const ligHours = Number(state.lig_hours);
  
  if(!wasRebooted && isRebooted && ligHours !== 0 && ligHours !== 24){
    console.log('[GrowHub:Push] Reboot detected');
    window.pushManager.showGrowHubAlert('rebooted', {});
  }
}

// Обработка сообщений от Service Worker
if('serviceWorker' in navigator){
  navigator.serviceWorker.addEventListener('message', (event) => {
    const data = event.data;
    
    if(data.type === 'REFILL_ACTION'){
      // Обработка нажатия кнопки "Залито" в уведомлении
      const refillType = data.payload.refillType;
      console.log('[GrowHub:SW] Refill action:', refillType);
      if(window.ghPublish){
        window.ghPublish('refill', refillType);
      }
    }
    
    if(data.type === 'NOTIFICATION_CLICKED'){
      console.log('[GrowHub:SW] Notification clicked:', data.payload);
      // Можно добавить навигацию к нужной странице
    }
  });
}

// Обновление индикатора кнопки уведомлений
function updateNotificationButtonBadge(){
  const btn = document.getElementById('btn-notifications');
  if(!btn || !window.pushManager) return;
  
  const config = window.pushManager.loadConfig();
  const caps = window.pushManager.getCapabilities();
  
  // Удаляем существующий badge
  const existingBadge = btn.querySelector('.badge-dot');
  if(existingBadge) existingBadge.remove();
  
  btn.classList.add('has-badge');
  
  if(config.enabled){
    // Уведомления включены - зеленый индикатор
    const badge = document.createElement('span');
    badge.className = 'badge-dot';
    btn.appendChild(badge);
  } else if(caps.supported && caps.permission !== 'denied'){
    // Уведомления доступны, но не включены - оранжевый индикатор
    const badge = document.createElement('span');
    badge.className = 'badge-dot pending';
    btn.appendChild(badge);
  }
}

// Вызываем обновление badge после инициализации pushManager
setTimeout(updateNotificationButtonBadge, 500);

// Инициализация селектора теплиц на главной странице
function initGreenhouseSelector(){
  const selectorWrap = document.getElementById('greenhouse-selector');
  const selectEl = document.getElementById('greenhouse-select');
  const countEl = document.getElementById('greenhouse-count');
  
  if(!selectorWrap || !selectEl) return;
  
  const greenhouses = window.ghGreenhouses.getAll();
  const activeId = window.ghGreenhouses.getActiveId();
  
  // Показываем селектор только если есть теплицы
  if(greenhouses.length === 0){
    selectorWrap.style.display = 'none';
    return;
  }
  
  selectorWrap.style.display = 'block';
  
  // Заполняем select
  selectEl.innerHTML = greenhouses.map(gh => {
    const displayName = gh.name || 'Новая теплица';
    return `<option value="${gh.id}" ${gh.id === activeId ? 'selected' : ''}>${escapeHtmlSelector(displayName)}</option>`;
  }).join('');
  
  // Показываем количество теплиц
  if(countEl){
    countEl.textContent = `${greenhouses.length} ${pluralize(greenhouses.length, 'теплица', 'теплицы', 'теплиц')}`;
  }
  
  // Обработчик переключения
  selectEl.addEventListener('change', ()=>{
    const newId = selectEl.value;
    const currentActiveId = window.ghGreenhouses.getActiveId();
    if(newId && newId !== currentActiveId){
      window.ghGreenhouses.switch(newId);
      // Обновляем счётчик и UI
      if(countEl){
        const activeGh = window.ghGreenhouses.getActive();
        const displayName = activeGh && activeGh.name ? activeGh.name : 'Новая теплица';
        countEl.textContent = activeGh ? `Подключено к: ${displayName}` : '';
      }
    }
  });
}

function escapeHtmlSelector(str){
  if(!str) return '';
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function pluralize(n, one, few, many){
  const mod10 = n % 10;
  const mod100 = n % 100;
  if(mod100 >= 11 && mod100 <= 19) return many;
  if(mod10 === 1) return one;
  if(mod10 >= 2 && mod10 <= 4) return few;
  return many;
}

// Вызываем инициализацию селектора после загрузки
setTimeout(initGreenhouseSelector, 100);

init();
