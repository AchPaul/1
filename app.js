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
const LS_LOGS_KEY = 'gh_logs_v1';
const LS_ESP32_LOGS_KEY = 'gh_esp32_logs_v1';
const MAX_LOGS = 500; // Максимальное количество записей в логах

let manager = null;
let connected = false;
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
  vent_interval: document.getElementById('inp_vent_interval'),
  dehumidify: document.getElementById('chk_dehumidify'),
  alternate_watering: document.getElementById('chk_alternate_watering'),
  btn_watered: document.getElementById('btn_watered'),
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

function loadConfig(){
  const url = new URL(window.location.href);
  const p = (k)=> url.searchParams.get(k) || '';
  let cfg = null;
  const stored = localStorage.getItem(LS_KEY);
  if(stored){ try { cfg = JSON.parse(stored); } catch(_){} }
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
  // Merge with stored config (URL params override stored when non-empty)
  const merged = Object.assign({}, cfg||{}, Object.fromEntries(Object.entries(chosen).filter(([,v])=>v)));
  return merged;
}

function saveConfig(cfg){
  localStorage.setItem(LS_KEY, JSON.stringify(cfg));
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
  });
}
let currentConfig = null; // Сохраняем конфиг для переподключения

function attachManagerEvents(){
  if(!manager) return;
  manager.on('status', (st)=>{
    connected = (st === 'connected');
    if(st === 'connected'){
      logStatus('Подключено');
      addLog('MQTT подключен к ' + currentConfig.host, 'connection', 'success');
      setTimeout(requestSyncHint, 300);
    } else if(st === 'reconnecting'){
      logStatus('Переподключение...');
      addLog('MQTT переподключение...', 'connection', 'warning');
    } else if(st === 'offline'){
      logStatus('Нет сети', true);
      addLog('Нет интернет-соединения', 'connection', 'error');
    } else if(st === 'disconnected'){
      logStatus('Отключено', true);
      addLog('MQTT отключен', 'connection', 'warning');
    }
  });
  manager.on('state', (js)=>{
    const previousState = lastState;
    lastState = js;
    lastStateTs = Date.now();
    renderState(js);
    // Логирование изменений состояния систем
    trackSystemChanges(js, previousState);
    // Проверяем алерты для push-уведомлений
    checkAlertsForPush(js, previousState);
    // Сохраняем логи из ESP32 если они есть (с дедупликацией по ID)
    if(js.logs && Array.isArray(js.logs)){
      console.log('[GrowHub] Получено логов из MQTT:', js.logs.length);
      // Инициализируем хранилище если его нет
      if(!window.esp32LogsMap){
        window.esp32LogsMap = new Map();
      }
      let newLogsAdded = 0;
      let duplicatesSkipped = 0;
      // Добавляем только уникальные логи по ID
      js.logs.forEach(log => {
        if(log.id){
          if(!window.esp32LogsMap.has(log.id)){
            window.esp32LogsMap.set(log.id, log);
            newLogsAdded++;
            console.log('[GrowHub] Новый лог ID=' + log.id + ':', log.msg);
          } else {
            duplicatesSkipped++;
          }
        } else {
          console.warn('[GrowHub] Лог без ID:', log);
        }
      });
      if(duplicatesSkipped > 0){
        console.log('[GrowHub] Пропущено дубликатов:', duplicatesSkipped);
      }
      // Обновляем массив для совместимости
      window.esp32Logs = Array.from(window.esp32LogsMap.values());
      // Ограничиваем размер
      if(window.esp32Logs.length > MAX_LOGS){
        window.esp32Logs = window.esp32Logs.slice(-MAX_LOGS); // Оставляем последние MAX_LOGS
        window.esp32LogsMap = new Map();
        window.esp32Logs.forEach(log => {
          if(log.id){
            window.esp32LogsMap.set(log.id, log);
          }
        });
      }
      // Сохраняем в localStorage
      try {
        localStorage.setItem(LS_ESP32_LOGS_KEY, JSON.stringify(window.esp32Logs));
      } catch(e) {
        console.warn('[GrowHub:Logs] Failed to save ESP32 logs to localStorage', e);
      }
      if(newLogsAdded > 0){
        console.log('[GrowHub] Добавлено новых логов:', newLogsAdded, '| Всего:', window.esp32Logs.length);
      }
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
    if(k === 'light_state'){
      el.textContent = (js.light_on || (js.lig_hours > 0 && js.day_time)) ? 'вкл' : 'выкл';
    } else if(k === 'heating_state'){
      el.textContent = js.heating_on ? 'вкл' : 'выкл';
    } else if(k === 'irrigation_state'){
      el.textContent = js.irrigation_on ? 'вкл' : 'выкл';
    } else if(k === 'humidifier_state'){
      el.textContent = js.humidifier_on ? 'вкл' : 'выкл';
    } else if(k === 'vent_state'){
      el.textContent = js.ventilation_on ? 'вкл' : 'выкл';
    } else if(k === 'cooling_state'){
      el.textContent = js.cooling_on ? 'вкл' : 'выкл';
    } else if(k in js){
      el.textContent = js[k];
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
        el.textContent = val + suffix;
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
    if('humair_day' in js) el.textContent = (js.humair_day === 0 || js.humair_day === '0') ? 'выкл' : js.humair_day + '%';
  });
  document.querySelectorAll('[data-field="humair_night_display"]').forEach(el=>{
    if('humair_night' in js) el.textContent = (js.humair_night === 0 || js.humair_night === '0') ? 'выкл' : js.humair_night + '%';
  });
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
  if(!manager) return;
  const now = Date.now();
  if(lastPubMap[key] && (now - lastPubMap[key] < PUB_THROTTLE_MS)) return; // throttle
  lastPubMap[key] = now;
  manager.publish(key, String(val));
  flashPub(`${key}=${val}`);
}
// Expose for inline forms on other pages
window.ghPublish = publish;

// Helper function to show "Saved" state on buttons
function showSavedState(button, savedText = 'Сохранено ✓', originalText = null, duration = 2000){
  if(!button) return;
  
  // Determine if it's an input or button element
  const isInput = button.tagName === 'INPUT';
  const textProp = isInput ? 'value' : 'textContent';
  
  if(!originalText) originalText = button[textProp];
  button[textProp] = savedText;
  button.disabled = true;

  const wrap = button.closest('[data-save-wrap]');
  const status = wrap ? wrap.querySelector('.save-status') : null;
  if(status){
    status.textContent = 'сохранено';
    status.classList.add('active');
    if(status._hideTimer) clearTimeout(status._hideTimer);
    status._hideTimer = setTimeout(()=>{
      status.classList.remove('active');
      status.textContent = '';
      status._hideTimer = null;
    }, duration);
  }
  
  setTimeout(() => {
    button[textProp] = originalText;
    button.disabled = false;
  }, duration);
}
// Expose for inline forms on other pages
window.ghShowSaved = showSavedState;

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
  if(inputs.dehumidify){
    inputs.dehumidify.addEventListener('change', ()=>{
      markUserInteraction();
      publish('dehumidify', inputs.dehumidify.checked ? 1 : 0);
    });
  }
  if(inputs.alternate_watering){
    inputs.alternate_watering.addEventListener('change', ()=>{
      markUserInteraction();
      publish('alternate_watering', inputs.alternate_watering.checked ? 1 : 0);
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
  if(ackButtons.water) ackButtons.water.addEventListener('click', ()=> publish('refill','water'));
  if(ackButtons.humid) ackButtons.humid.addEventListener('click', ()=> publish('refill','humid'));
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
    if(cfgBox) cfgBox.classList.remove('visible');
    connect(cfg);
    showSavedState(formCfg.save);
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

init();
