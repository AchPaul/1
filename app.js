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
let client = null;
let connected = false;
let baseTopic = '';
let stateTopic = '';
let setBase = '';
let reconnectTimer = null;
let lastState = null;
let lastPubMap = {}; // key -> timestamp
const PUB_THROTTLE_MS = 400; // minimal interval per key
const FORCE_STATE_INTERVAL = 20000; // if no state for this long -> show stale
let lastStateTs = 0;

const ALERT_KEYS = [
  'alert_water',
  'alert_humid',
  'alert_high_temp',
  'alert_low_temp',
  'err_sensor_temp',
  'err_sensor_hg',
  'err_sensor_dht'
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
  // URL overrides stored if present
  const urlCfg = {
    host: p('h'), port: p('p'), user: p('u'), pass: p('pw'), base: p('b')
  };
  if(urlCfg.base && !urlCfg.base.endsWith('/')) urlCfg.base += '/';
  // Merge preference: URL values if non-empty, else stored
  const merged = Object.assign({}, cfg||{}, Object.fromEntries(Object.entries(urlCfg).filter(([,v])=>v)));
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
  if(client){ try{ client.end(true); }catch(_){} client=null; }
  if(!ensureValidConfig(cfg)) { 
    logStatus('Заполните настройки подключения'); 
    if(cfgBox) cfgBox.classList.add('show'); 
    return; 
  }
  saveConfig(cfg);
  baseTopic = cfg.base;
  stateTopic = baseTopic + 'state/json';
  setBase = baseTopic + 'set/';
  const url = `wss://${cfg.host}:${cfg.port}/mqtt`;
  logStatus('Подключение...');
  client = mqtt.connect(url, {
    clientId: 'gh-web-' + Math.random().toString(16).slice(2),
    username: cfg.user || undefined,
    password: cfg.pass || undefined,
    reconnectPeriod: 4000,
    connectTimeout: 8000,
    keepalive: 30,
    clean: true
  });
  bindMqttEvents();
}

function bindMqttEvents(){
  if(!client) return;
  client.on('connect', ()=>{
    connected = true;
    logStatus('Подключено');
    client.subscribe(stateTopic, (err)=>{ if(err){ logStatus('Ошибка подписки'); } });
    requestSyncHint();
  });
  client.on('reconnect', ()=> logStatus('Переподключение...'));
  client.on('close', ()=>{ connected=false; logStatus('Отключено'); });
  client.on('error', (e)=> logStatus('Ошибка: '+ e.message));
  client.on('message', (topic,payload)=>{
    if(topic === stateTopic){
      try{
        const js = JSON.parse(payload.toString());
        lastState = js;
        lastStateTs = Date.now();
        renderState(js);
      }catch(e){ console.warn('State parse error', e); }
    }
  });
}

function renderState(js){
  const alertStates = {};
  ALERT_KEYS.forEach(key=>{ alertStates[key] = isFlagActive(js[key]); });
  // Debug alerts
  console.log('📦 Received JSON:', js);
  console.log('🚨 Alerts state:', {
    alert_water: alertStates.alert_water,
    alert_humid: alertStates.alert_humid,
    alert_high_temp: alertStates.alert_high_temp,
    alert_low_temp: alertStates.alert_low_temp,
    err_sensor_temp: alertStates.err_sensor_temp,
    err_sensor_hg: alertStates.err_sensor_hg,
    err_sensor_dht: alertStates.err_sensor_dht
  });
  
  // Primary numeric / text fields
  document.querySelectorAll('[data-field]').forEach(el=>{
    const k = el.getAttribute('data-field');
    if(k in js) el.textContent = js[k];
  });
  // Device name special case
  if(js.name && deviceNameEls.length){ deviceNameEls.forEach(el=> el.textContent = js.name); }
  // Live slider labels
  document.querySelectorAll('[data-live]').forEach(el=>{
    const k = el.getAttribute('data-live');
    if(k in js) el.textContent = js[k];
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
    
    console.log('🔍 Processing alerts...');
    alertsBox.querySelectorAll('[data-alert]').forEach(el=>{
      const key = el.getAttribute('data-alert');
      const isActive = key in alertStates ? alertStates[key] : isFlagActive(js[key]);
      console.log(`  ${key}: isActive=${isActive}, display will be: ${isActive ? 'flex' : 'none'}`);
      // Always update display to ensure state is fresh
      el.style.display = isActive ? 'flex' : 'none';
      if(isActive) hasActiveAlerts = true;
    });
    
    console.log(`✅ Total active alerts: ${hasActiveAlerts}, section display: ${hasActiveAlerts ? 'block' : 'none'}`);
    
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

function publish(key, val){
  if(!connected || !client) return;
  const now = Date.now();
  if(lastPubMap[key] && (now - lastPubMap[key] < PUB_THROTTLE_MS)) return; // throttle
  lastPubMap[key] = now;
  client.publish(setBase + key, String(val));
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
  if(inputs.disconnect) inputs.disconnect.addEventListener('click', ()=>{ if(client){ client.end(true); } });
  if(ackButtons.water) ackButtons.water.addEventListener('click', ()=> publish('refill','water'));
  if(ackButtons.humid) ackButtons.humid.addEventListener('click', ()=> publish('refill','humid'));
}

function requestSyncHint(){
  // There is no explicit sync topic; rely on retained state and firmware periodic publish.
  // We can force re-subscribe to provoke broker to resend retained message.
  if(client && connected){ client.unsubscribe(stateTopic, ()=>{ client.subscribe(stateTopic); }); }
}

// Config UI toggle
// Config toggle
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

function periodic(){
  const now = Date.now();
  if(statusLine && lastStateTs && now - lastStateTs > FORCE_STATE_INTERVAL){
    statusLine.textContent = connected ? 'Подключено (старая телеметрия)' : statusLine.textContent;
  }
  requestAnimationFrame(()=> setTimeout(periodic, 3000));
}

function init(){
  const cfg = loadConfig();
  fillConfigForm(cfg);
  
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
  
  // Если нет сохраненной конфигурации - показать форму
  if(!ensureValidConfig(cfg)) {
    if(cfgBox) cfgBox.classList.add('show');
    if(statusLine) statusLine.textContent = 'Введите настройки подключения';
  } else {
    connect(cfg);
  }
  bindControls();
  periodic();
  if('serviceWorker' in navigator){
    navigator.serviceWorker.register('service-worker.js').catch(()=>{});
  }
}

init();
