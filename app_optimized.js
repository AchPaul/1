/* GrowHub Remote UI - Optimized MQTT Architecture
 * 
 * КЛЮЧЕВЫЕ УЛУЧШЕНИЯ:
 * 1. Shared Worker - ОДНО постоянное MQTT соединение для всех вкладок
 * 2. Мгновенная загрузка - кэш состояния в localStorage
 * 3. Нет задержек при навигации - соединение НЕ пересоздаётся
 * 4. Автоматическое восстановление при потере связи
 * 5. Синхронизация между вкладками в реальном времени
 * 
 * ИСПОЛЬЗОВАНИЕ:
 * - Подключение происходит ОДИН раз при первой загрузке любой страницы
 * - При переходах между страницами данные загружаются МГНОВЕННО из кэша
 * - Фоновое обновление продолжается автоматически
 */

const LS_KEY = 'gh_remote_cfg_v1';
let mqttManager = null;
let connected = false;
let baseTopic = '';
let lastState = null;
let lastPubMap = {};
const PUB_THROTTLE_MS = 400;
const STALE_DATA_WARNING_MS = 60000; // Предупреждение о старых данных через 60 секунд

let configFromUrl = false;

const ALERT_KEYS = [
  'rebooted',
  'alert_water',
  'alert_humid',
  'alert_high_temp',
  'alert_low_temp',
  'err_sensor_temp',
  'err_sensor_hg',
  'err_sensor_hg2',
  'err_sensor_dht'
];

function publish(key, val){
  if(!mqttManager) {
    console.warn('[GrowHub] MQTT Manager not initialized');
    return false;
  }
  
  const now = Date.now();
  if(lastPubMap[key] && (now - lastPubMap[key] < PUB_THROTTLE_MS)) {
    console.log('[GrowHub] Throttling publish for', key);
    return false; // throttle
  }
  
  lastPubMap[key] = now;
  mqttManager.publish(key, String(val));
  
  // Визуальный фидбек придёт через события 'published' или 'queued'
  return true;
}

function syncInputIfIdle(input, value){
  if(!input) return;
  if(document.activeElement === input) return; // user editing
  if(String(input.value) !== String(value)) input.value = value;
  const live = document.querySelector(`[data-live="${input.id.replace('inp_','')}"]`);
  if(live) live.textContent = value;
}

function flashPub(msg){
  if(!pubStatusEl) return;
  pubStatusEl.textContent = 'Отправлено: ' + msg;
  pubStatusEl.classList.add('fade');
  setTimeout(()=> pubStatusEl.classList.remove('fade'), 600);
}

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

function renderState(js){
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
    if(k in js) el.textContent = js[k];
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
  // Update control values if user not dragging
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
  if(typeof updateSliderValue === 'function'){
    if(inputs.vent_day) updateSliderValue(inputs.vent_day);
    if(inputs.vent_night) updateSliderValue(inputs.vent_night);
  }
  // Sync AP mode select
  if(js.ap_mode !== undefined){
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
    el.addEventListener('input', ()=>{
      const live = document.querySelector(`[data-live="${key}"]`); if(live) live.textContent = el.value;
    });
    // Убрана автоматическая отправка - только при нажатии кнопки "Сохранить"
  });
  if(inputs.lig_type) inputs.lig_type.addEventListener('change', ()=> publish('lig_type', inputs.lig_type.value));
  if(inputs.btn_profile) inputs.btn_profile.addEventListener('click', ()=>{ const v = inputs.profile.value.trim(); if(v) publish('profile', v); });
  if(inputs.sync_now) inputs.sync_now.addEventListener('click', requestSyncHint);
  if(inputs.disconnect) inputs.disconnect.addEventListener('click', ()=>{ if(mqttManager){ mqttManager.disconnect(); } });
  if(ackButtons.water) ackButtons.water.addEventListener('click', ()=> publish('refill','water'));
  if(ackButtons.humid) ackButtons.humid.addEventListener('click', ()=> publish('refill','humid'));
}

function syncCheckbox(input, value, slider){
  if(!input) return;
  const desired = isFlagActive(value);
  if(input.checked !== desired) input.checked = desired;
  if(slider && typeof updateSliderValue === 'function') updateSliderValue(slider);
}

function requestSyncHint(){
  // Shared Worker автоматически поддерживает актуальное состояние
  // Принудительно запрашиваем свежие данные из кэша
  if(mqttManager && lastState){
    renderState(lastState);
  }
}

function showSavedState(button, savedText = 'Сохранено ✓', originalText = null, duration = 2000){
  if(!button) return;
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
window.ghShowSaved = showSavedState;



// Raw URL parameter dump
function extractUrlRaw(){
  const sp = new URLSearchParams(window.location.search);
  const raw = {
    host: sp.get('host'), port: sp.get('port'), user: sp.get('user'), pass: sp.get('pass'), topic: sp.get('topic'),
    h: sp.get('h'), p: sp.get('p'), u: sp.get('u'), pw: sp.get('pw'), b: sp.get('b')
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
  profile: document.getElementById('inp_profile'),
  btn_profile: document.getElementById('btn_profile'),
  sync_now: document.getElementById('btn_sync_now'),
  disconnect: document.getElementById('btn_disconnect')
};

function logStatus(msg){
  if(statusLine) statusLine.textContent = msg;
}

function loadConfig(){
  const url = new URL(window.location.href);
  const p = (k)=> url.searchParams.get(k) || '';
  let cfg = null;
  const stored = localStorage.getItem(LS_KEY);
  if(stored){ try { cfg = JSON.parse(stored); } catch(_){} }
  
  const longParams = {
    host: p('host'),
    port: p('port'),
    user: p('user'),
    pass: p('pass'),
    base: p('topic')
  };
  const shortParams = {
    host: p('h'),
    port: p('p'),
    user: p('u'),
    pass: p('pw'),
    base: p('b')
  };
  
  const chosen = {};
  ['host','port','user','pass','base'].forEach(k=>{
    if(longParams[k]) chosen[k] = longParams[k]; else if(shortParams[k]) chosen[k] = shortParams[k];
  });
  configFromUrl = Object.values(chosen).some(Boolean);
  
  if(chosen.base && !chosen.base.endsWith('/')) chosen.base += '/';
  
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
  if(!cfg.base.endsWith('/')) cfg.base += '/';
  return true;
}

function connect(cfg){
  if(!ensureValidConfig(cfg)) { 
    logStatus('Заполните настройки подключения'); 
    if(cfgBox) cfgBox.classList.add('show'); 
    return; 
  }
  
  console.log('[GrowHub] Connecting with config:', { host: cfg.host, port: cfg.port, base: cfg.base });
  
  saveConfig(cfg);
  baseTopic = cfg.base;
  
  logStatus('Подключение...');
  
  // Создаём MQTT manager с Shared Worker
  if (!mqttManager) {
    console.log('[GrowHub] Creating new MQTTManager');
    mqttManager = new MQTTManager();
    bindMqttEvents();
    
    // Ждём готовности (для fallback клиента)
    mqttManager.on('status', (status) => {
      if (status === 'ready') {
        console.log('[GrowHub] MQTT Manager ready, connecting...');
        mqttManager.connect(cfg);
      }
    });
    
    // Для SharedWorker подключаемся сразу (событие 'ready' не будет)
    // Fallback сам вызовет connect когда загрузится
    if (!mqttManager.usingFallback) {
      mqttManager.connect(cfg);
    }
  } else {
    console.log('[GrowHub] Reusing existing MQTTManager');
    mqttManager.connect(cfg);
  }
}

function bindMqttEvents(){
  if(!mqttManager) return;
  
  console.log('[GrowHub] Binding MQTT events');
  
  // Обработка изменения статуса подключения
  mqttManager.on('status', (status) => {
    // Игнорируем 'ready' - это только для fallback загрузки
    if (status === 'ready') return;
    
    connected = (status === 'connected');
    
    const statusMessages = {
      'connecting': 'Подключение...',
      'connected': '✓ Подключено',
      'reconnecting': 'Переподключение...',
      'disconnected': 'Отключено',
      'offline': 'Нет сети',
      'error': 'Ошибка подключения'
    };
    
    logStatus(statusMessages[status] || status);
  });
  
  // Обработка нового состояния
  mqttManager.on('state', (state) => {
    lastState = state;
    renderState(state);
  });
  
  // Обработка индикатора кэшированных данных
  mqttManager.on('cached', (isCached) => {
    if (isCached && statusLine) {
      statusLine.textContent += ' (кэш)';
    }
  });
  
  // Обработка подтверждения публикации
  mqttManager.on('published', ({ key, value }) => {
    flashPub(`${key}=${value}`);
  });
  
  // Обработка команд в очереди
  mqttManager.on('queued', ({ key, value }) => {
    flashPub(`${key}=${value} (в очереди)`);
  });
}

window.ghPublish = publish;

function init(){
  const rawParams = extractUrlRaw();
  const cfg = loadConfig();
  // Force fill from URL (prefer long names) before merging display
  if(formCfg.host && (rawParams.host || rawParams.h)) formCfg.host.value = rawParams.host || rawParams.h || '';
  if(formCfg.port && (rawParams.port || rawParams.p)) formCfg.port.value = rawParams.port || rawParams.p || '';
  if(formCfg.user && (rawParams.user || rawParams.u)) formCfg.user.value = rawParams.user || rawParams.u || '';
  if(formCfg.pass && (rawParams.pass || rawParams.pw)) formCfg.pass.value = rawParams.pass || rawParams.pw || '';
  if(formCfg.base && (rawParams.topic || rawParams.b)) formCfg.base.value = (rawParams.topic || rawParams.b || '');
  // Now overwrite with merged cfg only for fields still empty
  if(formCfg.host && !formCfg.host.value) formCfg.host.value = cfg.host || '';
  if(formCfg.port && !formCfg.port.value) formCfg.port.value = cfg.port || '';
  if(formCfg.user && !formCfg.user.value) formCfg.user.value = cfg.user || '';
  if(formCfg.pass && !formCfg.pass.value) formCfg.pass.value = cfg.pass || '';
  if(formCfg.base && !formCfg.base.value) formCfg.base.value = cfg.base || '';
  // Reflect final cfg object for connection logic
  if(formCfg.host) cfg.host = formCfg.host.value.trim();
  if(formCfg.port) cfg.port = formCfg.port.value.trim();
  if(formCfg.user) cfg.user = formCfg.user.value.trim();
  if(formCfg.pass) cfg.pass = formCfg.pass.value.trim();
  if(formCfg.base) cfg.base = formCfg.base.value.trim();
  if(configFromUrl){
    saveConfig(cfg);
    if(cfgBox) cfgBox.classList.remove('show');
  }
  // Initialize alerts section as hidden
  const alertsSection = document.querySelector('.alerts-section');
  if(alertsSection){
    alertsSection.style.display = 'none';
    const alertsBox = document.getElementById('alerts');
    if(alertsBox){
      alertsBox.querySelectorAll('[data-alert]').forEach(el=>{
        el.style.display = 'none';
      });
    }
  }
  // Check if config valid
  const isMainPage = window.location.pathname.endsWith('index.html') || 
                     window.location.pathname.endsWith('/') ||
                     window.location.pathname === '';
  if(!ensureValidConfig(cfg)) {
    if(isMainPage) {
      if(cfgBox) cfgBox.classList.add('show');
      if(statusLine) statusLine.textContent = 'Введите настройки подключения';
    } else {
      const mqttWarning = document.getElementById('mqtt-not-configured');
      if(mqttWarning) mqttWarning.style.display = 'block';
      if(statusLine) statusLine.textContent = 'MQTT не настроен';
      return;
    }
  } else {
    if(statusLine) statusLine.textContent = 'Автозагрузка конфигурации...';
    connect(cfg);
  }
  bindControls();
  if('serviceWorker' in navigator){
    navigator.serviceWorker.register('service-worker.js').catch(()=>{});
  }
}

// Config UI
if(cfgToggle && cfgBox){
  cfgToggle.addEventListener('click', ()=>{
    cfgBox.classList.toggle('show');
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
    if(cfgBox) cfgBox.classList.remove('show');
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

init();

