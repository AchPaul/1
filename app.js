/* GrowHub Remote UI - Simple MQTT Client
 * Работает на ВСЕХ браузерах без Worker'ов
 */

const LS_KEY = 'gh_remote_cfg_v1';
let mqttClient = null;
let connected = false;
let lastState = null;
let lastPubMap = {};
const PUB_THROTTLE_MS = 400;

const ALERT_KEYS = [
  'rebooted', 'alert_water', 'alert_humid', 'alert_high_temp', 'alert_low_temp',
  'err_sensor_temp', 'err_sensor_hg', 'err_sensor_hg2', 'err_sensor_dht'
];

function publish(key, val){
  if(!mqttClient) {
    console.warn('[GrowHub] MQTT not initialized');
    return false;
  }
  
  const now = Date.now();
  if(lastPubMap[key] && (now - lastPubMap[key] < PUB_THROTTLE_MS)) {
    return false;
  }
  
  lastPubMap[key] = now;
  return mqttClient.publish(key, String(val));
}

function syncInputIfIdle(input, value){
  if(!input) return;
  if(document.activeElement === input) return;
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
    if(key === 'rebooted'){
      const ligHours = Number(js.lig_hours);
      alertStates[key] = !isFlagActive(js[key]) && ligHours !== 0 && ligHours !== 24;
    } else {
      alertStates[key] = isFlagActive(js[key]);
    }
  });
  
  const ventDayAlways = isFlagActive(js.vent_day_always);
  const ventNightAlways = isFlagActive(js.vent_night_always);
  
  document.querySelectorAll('[data-field]').forEach(el=>{
    const k = el.getAttribute('data-field');
    if(k in js) el.textContent = js[k];
  });
  
  if(js.name && deviceNameEls.length){
    deviceNameEls.forEach(el=> el.textContent = js.name);
  }
  
  document.querySelectorAll('[data-live]').forEach(el=>{
    const k = el.getAttribute('data-live');
    if(k in js){
      const suffix = el.getAttribute('data-suffix') || '';
      const val = js[k];
      if ((k === 'vent_day' && ventDayAlways) || (k === 'vent_night' && ventNightAlways)) {
        el.textContent = 'вкл';
      } else if (suffix && (val === 0 || val === '0')) {
        el.textContent = 'выкл';
      } else if (suffix) {
        el.textContent = val + suffix;
      } else {
        el.textContent = val;
      }
    }
  });
  
  document.querySelectorAll('input[type="range"], input[type="number"]').forEach(inp=>{
    const k = inp.id.replace('inp_', '');
    if(k in js) syncInputIfIdle(inp, js[k]);
  });
  
  document.querySelectorAll('input[type="checkbox"]').forEach(chk=>{
    const k = chk.id.replace('chk_', '');
    if(k in js){
      const isActive = isFlagActive(js[k]);
      if(chk.checked !== isActive) chk.checked = isActive;
    }
  });
  
  const anyAlert = Object.values(alertStates).some(v => v);
  const alertsArr = [];
  if(alertStates.alert_water) alertsArr.push('💧 Низкий уровень воды');
  if(alertStates.alert_humid) alertsArr.push('💨 Бак увлажнителя пуст');
  if(alertStates.alert_high_temp) alertsArr.push('🔥 Превышена температура');
  if(alertStates.alert_low_temp) alertsArr.push('❄️ Низкая температура');
  if(alertStates.err_sensor_temp) alertsArr.push('⚠️ Ошибка датчика температуры');
  if(alertStates.err_sensor_hg || alertStates.err_sensor_hg2) alertsArr.push('⚠️ Ошибка датчика влажности почвы');
  if(alertStates.err_sensor_dht) alertsArr.push('⚠️ Ошибка DHT датчика');
  if(alertStates.rebooted) alertsArr.push('⚙️ Требуется установка времени');
  
  if(badgesEl){
    badgesEl.innerHTML = anyAlert ? '<span class="badge error">⚠️ Требуется внимание</span>' : '<span class="badge ok">✓ Всё в порядке</span>';
  }
  
  if(alertsBox){
    alertsBox.innerHTML = anyAlert ? alertsArr.map(txt => `<div class="alert">${txt}</div>`).join('') : '';
  }
  
  if(lastUpdateEl){
    const now = new Date();
    lastUpdateEl.textContent = now.toLocaleTimeString('ru-RU');
  }
  
  lastState = js;
}

function logStatus(txt){
  if(statusLine) statusLine.textContent = txt;
  console.log('[GrowHub] Status:', txt);
}

function saveConfig(cfg){
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(cfg));
  } catch(e){}
}

function loadConfig(){
  try {
    const str = localStorage.getItem(LS_KEY);
    if(str) return JSON.parse(str);
  } catch(e){}
  return {};
}

function extractUrlRaw(){
  const params = new URLSearchParams(window.location.search);
  return {
    host: params.get('host') || params.get('h'),
    port: params.get('port') || params.get('p'),
    user: params.get('user') || params.get('u'),
    pass: params.get('pass') || params.get('pw'),
    topic: params.get('topic') || params.get('b')
  };
}

function connectMQTT(){
  const rawParams = extractUrlRaw();
  let cfg = loadConfig();
  
  if(rawParams.host) cfg.host = rawParams.host;
  if(rawParams.port) cfg.port = rawParams.port;
  if(rawParams.user) cfg.user = rawParams.user;
  if(rawParams.pass) cfg.pass = rawParams.pass;
  if(rawParams.topic) cfg.base = rawParams.topic;
  
  if(formCfg.host) cfg.host = formCfg.host.value.trim() || cfg.host;
  if(formCfg.port) cfg.port = formCfg.port.value.trim() || cfg.port;
  if(formCfg.user) cfg.user = formCfg.user.value.trim() || cfg.user;
  if(formCfg.pass) cfg.pass = formCfg.pass.value.trim() || cfg.pass;
  if(formCfg.base) cfg.base = formCfg.base.value.trim() || cfg.base;
  
  if(!cfg.host || !cfg.port || !cfg.base){
    logStatus('⚠️ Заполните настройки подключения');
    if(cfgBox) cfgBox.classList.add('visible');
    return;
  }
  
  console.log('[GrowHub] Connecting:', cfg.host);
  saveConfig(cfg);
  
  logStatus('Подключение...');
  
  if(!mqttClient){
    mqttClient = new SimpleMQTTClient();
    
    mqttClient.on('status', (status) => {
      connected = (status === 'connected');
      const msgs = {
        'connecting': 'Подключение...',
        'connected': '✓ Подключено',
        'reconnecting': 'Переподключение...',
        'disconnected': 'Отключено',
        'error': 'Ошибка подключения'
      };
      logStatus(msgs[status] || status);
    });
    
    mqttClient.on('state', (state) => {
      renderState(state);
    });
    
    mqttClient.on('cached', () => {
      if(statusLine) statusLine.textContent += ' (кэш)';
    });
    
    mqttClient.on('published', ({ key, value }) => {
      flashPub(`${key}=${value}`);
    });
    
    mqttClient.on('queued', ({ key, value }) => {
      flashPub(`${key}=${value} (в очереди)`);
    });
    
    mqttClient.loadCachedState();
  }
  
  mqttClient.connect(cfg);
}

window.ghPublish = publish;

function init(){
  const rawParams = extractUrlRaw();
  const cfg = loadConfig();
  
  if(formCfg.host) formCfg.host.value = rawParams.host || cfg.host || '';
  if(formCfg.port) formCfg.port.value = rawParams.port || cfg.port || '';
  if(formCfg.user) formCfg.user.value = rawParams.user || cfg.user || '';
  if(formCfg.pass) formCfg.pass.value = rawParams.pass || cfg.pass || '';
  if(formCfg.base) formCfg.base.value = rawParams.topic || cfg.base || '';
  
  if(cfgToggle){
    cfgToggle.addEventListener('click', () => {
      cfgBox?.classList.toggle('visible');
    });
  }
  
  if(formCfg.save){
    formCfg.save.addEventListener('click', () => {
      connectMQTT();
      cfgBox?.classList.remove('visible');
    });
  }
  
  if(formCfg.clear){
    formCfg.clear.addEventListener('click', () => {
      localStorage.removeItem(LS_KEY);
      location.reload();
    });
  }
  
  document.querySelectorAll('input[type="range"]').forEach(slider => {
    slider.addEventListener('input', (e) => {
      const key = e.target.id.replace('inp_', '');
      const live = document.querySelector(`[data-live="${key}"]`);
      if(live) live.textContent = e.target.value;
    });
    
    slider.addEventListener('change', (e) => {
      const key = e.target.id.replace('inp_', '');
      publish(key, e.target.value);
    });
  });
  
  document.querySelectorAll('input[type="number"]').forEach(inp => {
    inp.addEventListener('change', (e) => {
      const key = e.target.id.replace('inp_', '');
      publish(key, e.target.value);
    });
  });
  
  document.querySelectorAll('input[type="checkbox"]').forEach(chk => {
    chk.addEventListener('change', (e) => {
      const key = e.target.id.replace('chk_', '');
      publish(key, e.target.checked ? '1' : '0');
    });
  });
  
  document.querySelectorAll('select').forEach(sel => {
    sel.addEventListener('change', (e) => {
      const key = e.target.id.replace('sel_', '');
      publish(key, e.target.value);
    });
  });
  
  connectMQTT();
}

if(document.readyState === 'loading'){
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
