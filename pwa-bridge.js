/**
 * GrowHub PWA bridge: maps MQTT state to local /api/* responses and routes
 * dashboard fetch() calls to MQTT publish via ghPublish().
 */
(function(){
  'use strict';

  var MQTT_CMD_TOKEN = 'pwa';
  var lastMqttState = null;
  var lastApiState = null;
  var lastMqttHistory = null;

  function flag(v){ return v === 1 || v === true || v === '1' || v === 'true'; }
  function num(v, fb){ var n = Number(v); return Number.isFinite(n) ? n : (fb || 0); }

  function isStagePresetProfileId(id){
    if(typeof window.isStagePresetProfileId === 'function'){
      return window.isStagePresetProfileId(id);
    }
    var n = Number(id);
    var total = Number(window.GH_PLANT_NUMS);
    if(!Number.isFinite(n) || !Number.isFinite(total)) return false;
    return n === total - 3 || n === total - 2 || n === total - 1;
  }

  function fmtTempDisplay(js){
    if(flag(js.err_sensor_soil)) return { display: 'Ошибка', unit: '' };
    return { display: String(num(js.temp_soil, 0)), unit: '°C' };
  }

  function fmtTempPeriod(v){
    var n = num(v, 0);
    return n === 0 ? 'выкл' : String(n) + '°C';
  }

  function fmtHumPeriod(v){
    var n = num(v, 0);
    return n === 0 ? 'выкл' : String(n) + '%';
  }

  function fmtHumAirDayNight(js, period){
    var smart = flag(js.smart_humair) && flag(js.humair_vpd_valid);
    if(period === 'day'){
      if(smart) return String(num(js.humair_vpd_day, js.humair_day)) + '% (авто)';
      return fmtHumPeriod(js.humair_day);
    }
    if(smart) return String(num(js.humair_vpd_night, js.humair_night)) + '% (авто)';
    return fmtHumPeriod(js.humair_night);
  }

  function fmtHumAirRaw(js, period){
    var smart = flag(js.smart_humair) && flag(js.humair_vpd_valid);
    if(period === 'day'){
      return smart ? String(num(js.humair_vpd_day, js.humair_day)) : String(num(js.humair_day, 0));
    }
    return smart ? String(num(js.humair_vpd_night, js.humair_night)) : String(num(js.humair_night, 0));
  }

  function fmtVentDisplay(interval, always){
    if(flag(always)) return 'вкл';
    var n = num(interval, 0);
    return n === 0 ? 'выкл' : String(n);
  }

  function mqttToApiState(js){
    if(!js) return null;
    var temp = fmtTempDisplay(js);
    var ligHours = num(js.lig_hours, 0);
    var showReboot = !flag(js.rebooted) && ligHours !== 0 && ligHours !== 24;

    return {
      preset: js.profile_name || '',
      day_night: flag(js.day_time) ? 'День' : 'Ночь',
      light_h: String(ligHours),
      light_on: String(num(js.light_on_hour, 0)),
      temp_label: 'Темп. грунта',
      temp_display: temp.display,
      temp_unit: temp.unit,
      temp_day: String(num(js.temp_day, 0)),
      temp_nig: String(num(js.temp_night, 0)),
      temp_day_display: fmtTempPeriod(js.temp_day),
      temp_nig_display: fmtTempPeriod(js.temp_night),
      h_g_now: flag(js.err_sensor_hg) ? 'Ошибка' : String(num(js.humgr_now, 0)),
      h_g_unit: flag(js.err_sensor_hg) ? '' : '%',
      h_g_day: String(num(js.humgr_day, 0)),
      h_g_nig: String(num(js.humgr_night, 0)),
      h_g_day_display: fmtHumPeriod(js.humgr_day),
      h_g_nig_display: fmtHumPeriod(js.humgr_night),
      h_a_now: flag(js.err_sensor_dht) ? 'Ошибка' : String(num(js.humair_now, 0)),
      h_a_unit: flag(js.err_sensor_dht) ? '' : '%',
      h_a_day: fmtHumAirRaw(js, 'day'),
      h_a_nig: fmtHumAirRaw(js, 'night'),
      h_a_day_display: fmtHumAirDayNight(js, 'day'),
      h_a_nig_display: fmtHumAirDayNight(js, 'night'),
      vent_int_d: String(num(js.vent_day, 0)),
      vent_int_d_display: fmtVentDisplay(js.vent_day, js.vent_day_always),
      vent_day_suffix: flag(js.vent_day_always) ? '' : (num(js.vent_day, 0) > 0 ? ' мин' : ''),
      vent_int_n: String(num(js.vent_night, 0)),
      vent_int_n_display: fmtVentDisplay(js.vent_night, js.vent_night_always),
      vent_night_suffix: flag(js.vent_night_always) ? '' : (num(js.vent_night, 0) > 0 ? ' мин' : ''),
      vpd_stage_line: js.vpd_stage_line || js.growth_stage_name || '—',
      smart_humair_state: flag(js.smart_humair) ? 'вкл' : 'выкл',
      cooling_state: flag(js.cooling_enabled) ? 'вкл' : 'выкл',
      dehumidify_state: flag(js.dehumidify) ? 'вкл' : 'выкл',
      alt_watering_state: flag(js.alternate_watering) ? 'вкл' : 'выкл',
      smart_humair: flag(js.smart_humair) ? 1 : 0,
      cooling_enabled: flag(js.cooling_enabled) ? 1 : 0,
      dehumidify_enabled: flag(js.dehumidify) ? 1 : 0,
      alternate_watering: flag(js.alternate_watering) ? 1 : 0,
      vent_always_day: flag(js.vent_day_always) ? 1 : 0,
      vent_always_night: flag(js.vent_night_always) ? 1 : 0,
      temp_raw: num(js.temp_soil, 0),
      humair_raw: num(js.humair_now, 0),
      vpd_x100: num(js.vpd_x100, 0),
      vpd_zone: num(js.vpd_zone, 0),
      growth_stage: num(js.growth_stage, 0),
      vpd_target_x10: num(js.vpd_target_x10, 0),
      humair_vpd_day: js.humair_vpd_day,
      humair_vpd_night: js.humair_vpd_night,
      humair_vpd_valid: flag(js.humair_vpd_valid) ? 1 : 0,
      is_stage_preset: isStagePresetProfileId(js.profile_id) ? 1 : 0,
      _name: js.name || 'Теплица'
    };
  }

  function mqttToApiStatus(js){
    if(!js) js = {};
    var ligHours = num(js.lig_hours, 0);
    var pwaMqttOk = false;
    try { pwaMqttOk = typeof window.ghIsMqttConnected === 'function' && window.ghIsMqttConnected(); } catch(_e){}
    return {
      wifi_connected: flag(js.wifi_connected) || !!getDeviceHttpBase(),
      wifi_auth_failed: false,
      mqtt_connected: pwaMqttOk || flag(js.mqtt_connected),
      ap_started: flag(js.ap_started) || flag(js.ap_mode),
      hig_temp: flag(js.alert_high_temp),
      low_temp: flag(js.alert_low_temp),
      out_hg: flag(js.alert_water),
      out_ha: flag(js.alert_humid),
      err_sensor_hg: flag(js.err_sensor_hg),
      err_sensor_dht: flag(js.err_sensor_dht),
      err_sensor_soil: flag(js.err_sensor_soil),
      water_pending: flag(js.watering_notification_pending),
      reboot_alert: !flag(js.rebooted) && ligHours !== 0 && ligHours !== 24
    };
  }

  function mqttToSoilRaw(js){
    if(!js) js = {};
    return {
      raw_up: num(js.soil_raw_up, 0),
      calibrated: flag(js.soil_calibrated),
      air_up: num(js.soil_cal_staging_air, js.soil_cal_air_up),
      water_up: num(js.soil_cal_staging_water, js.soil_cal_water_up)
    };
  }

  function mqttHistoryToApi(raw){
    if(!raw) return { hours: 24, interval_sec: 60, points: [] };
    var pts = [];
    var src = raw.points || [];
    for(var i = 0; i < src.length; i++){
      var p = src[i];
      if(Array.isArray(p)){
        pts.push({
          t: num(p[0], 0),
          ta: p[1],
          tsl: p[2],
          ha: p[3],
          hg: p[4],
          al: p[5]
        });
      } else if(p && typeof p === 'object'){
        pts.push({
          t: num(p.t !== undefined ? p.t : p.ts, 0),
          ta: p.ta,
          tsl: p.tsl,
          ha: p.ha,
          hg: p.hg,
          al: p.al !== undefined ? p.al : 0
        });
      }
    }
    return {
      hours: num(raw.hours, 24),
      interval_sec: num(raw.interval_sec, 60),
      points: pts
    };
  }

  function parseHistoryHours(path){
    try {
      var u = new URL(path, window.location.href);
      var h = parseInt(u.searchParams.get('hours') || '12', 10);
      if(h === 6 || h === 12 || h === 24) return h;
    } catch(_e){}
    return 12;
  }

  function filterHistoryByHours(data, hours){
    var points = (data && data.points) ? data.points : [];
    if(!points.length){
      return { hours: hours, interval_sec: 60, points: [] };
    }
    var lastT = num(points[points.length - 1].t, 0);
    var cutoff = lastT - hours * 3600;
    var filtered = points.filter(function(p){ return num(p.t, 0) >= cutoff; });
    return {
      hours: hours,
      interval_sec: data.interval_sec || 60,
      points: filtered
    };
  }

  function settingsToMqttCommands(field, period, value){
    var v = String(Math.round(num(value, 0)));
    switch(field){
      case 'light': return [{ key: 'lig_hours', val: v }];
      case 'temp':
        if(period === 'day') return [{ key: 'temp_day', val: v }];
        if(period === 'night') return [{ key: 'temp_night', val: v }];
        return [];
      case 'soil':
        if(period === 'day') return [{ key: 'humgr_day', val: v }];
        if(period === 'night') return [{ key: 'humgr_night', val: v }];
        return [];
      case 'air':
        if(flag(lastMqttState && lastMqttState.smart_humair)) return null;
        if(period === 'day') return [{ key: 'humair_day', val: v }];
        if(period === 'night') return [{ key: 'humair_night', val: v }];
        return [];
      case 'vent':
        if(period === 'day') return [{ key: 'vent_day', val: v }];
        if(period === 'night') return [{ key: 'vent_night', val: v }];
        return [];
      case 'smart_humair': return [{ key: 'smart_humair', val: v }];
      case 'cooling_enabled': return [{ key: 'cooling', val: v }];
      case 'dehumidify_enabled': return [{ key: 'dehumidify', val: v }];
      case 'alternate_watering': return [{ key: 'alternate_watering', val: v }];
      case 'vent_always':
        if(period === 'night') return [{ key: 'vent_night_always', val: v }];
        return [{ key: 'vent_day_always', val: v }];
      default: return [];
    }
  }

  function publishCommands(commands){
    if(!commands || !commands.length) return Promise.reject(new Error('no commands'));
    if(!window.ghPublish) return Promise.reject(new Error('MQTT not ready'));
    var ok = true;
    commands.forEach(function(c){ ok = window.ghPublish(c.key, c.val) && ok; });
    return ok ? Promise.resolve('OK') : Promise.reject(new Error('publish failed'));
  }

  function parseFormBody(body){
    var out = {};
    if(body instanceof FormData){
      body.forEach(function(val, key){ out[key] = val; });
      return out;
    }
    if(typeof body === 'string'){
      body.split('&').forEach(function(pair){
        var p = pair.split('=');
        if(p.length >= 2) out[decodeURIComponent(p[0])] = decodeURIComponent(p[1].replace(/\+/g, ' '));
      });
    }
    return out;
  }

  function jsonResponse(obj, status){
    return new Response(JSON.stringify(obj), {
      status: status || 200,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  function textResponse(text, status){
    return new Response(text, { status: status || 200, headers: { 'Content-Type': 'text/plain' } });
  }

  function getDeviceHttpBase(){
    try {
      if(window.ghGreenhouses && window.ghGreenhouses.getActive){
        var gh = window.ghGreenhouses.getActive();
        if(gh && gh.deviceUrl) return String(gh.deviceUrl).replace(/\/$/, '');
      }
    } catch(_e){}
    return null;
  }

  function proxyToDevice(path, init){
    var base = getDeviceHttpBase();
    if(!base) return null;
    var url = base + (path.startsWith('/') ? path : '/' + path);
    return nativeFetch(url, init || {});
  }

  /** deviceUrl из теплицы или тот же хост, если PWA открыта с контроллера (AP). */
  function proxyToDeviceOrLocal(path, init){
    var proxied = proxyToDevice(path, init);
    if(proxied) return proxied;
    try {
      if(typeof window !== 'undefined' && window.location && window.location.protocol &&
          window.location.protocol.indexOf('http') === 0){
        return nativeFetch(path, init || {});
      }
    } catch(_e){}
    return null;
  }

  function deviceRequiredResponse(){
    return jsonResponse({ ok: false, error: 'deviceUrl_required' }, 503);
  }

  function handleSendPost(path, init){
    return Promise.resolve(init.body).then(function(body){
      var fd = parseFormBody(body);
      var cmds = [];

      if(path.indexOf('/send_profile') >= 0 && fd.profile !== undefined){
        cmds = [{ key: 'profile', val: String(fd.profile) }];
      } else if(path.indexOf('/send_plant') >= 0 && fd.plant !== undefined){
        cmds = [{ key: 'profile', val: String(fd.plant) }];
      } else if(path.indexOf('/send_ap') >= 0 && fd.ap_mode !== undefined){
        cmds = [{ key: 'ap_mode', val: String(fd.ap_mode) }];
      } else if(path.indexOf('/send_soil_cal') >= 0){
        var a = num(fd.air_up, 0);
        var w = num(fd.water_up, 0);
        cmds = [{ key: 'soil_cal_save', val: String(a) + ',' + String(w) }];
      } else {
        var proxied = proxyToDevice(path, init);
        if(proxied) return proxied.then(function(r){ return r.text().then(function(t){ return new Response(t, { status: r.status, headers: { 'Content-Type': r.headers.get('Content-Type') || 'text/plain' } }); }); });
        return deviceRequiredResponse();
      }

      return publishCommands(cmds).then(function(){ return textResponse('OK'); });
    });
  }

  function syncPageFromMqtt(js){
    if(!js) return;
    var pid = js.profile_id;
    if(pid !== undefined){
      document.querySelectorAll('select[name="plant"],select[name="profile"]').forEach(function(sel){
        sel.value = String(pid);
      });
    }
    if(js.name){
      var nameInp = document.querySelector('input[name="gh_name"]');
      if(nameInp && document.activeElement !== nameInp && !nameInp.value) nameInp.placeholder = js.name;
      var nameText = document.getElementById('device-name-text');
      if(nameText) nameText.textContent = js.name;
    }
    if(js.light_on_hour !== undefined){
      var lon = document.getElementById('light-on-hour');
      if(lon && document.activeElement !== lon) lon.value = js.light_on_hour;
      var lon2 = document.getElementById('light-on');
      if(lon2 && document.activeElement !== lon2) lon2.value = js.light_on_hour;
    }
    var airUp = document.getElementById('air_up');
    var waterUp = document.getElementById('water_up');
    if(airUp && js.soil_cal_staging_air !== undefined && document.activeElement !== airUp){
      airUp.value = js.soil_cal_staging_air;
    }
    if(waterUp && js.soil_cal_staging_water !== undefined && document.activeElement !== waterUp){
      waterUp.value = js.soil_cal_staging_water;
    }
    if(js.soil_calibrated !== undefined){
      var calStatus = document.getElementById('cal-status');
      if(calStatus){
        calStatus.classList.toggle('not-done', !flag(js.soil_calibrated));
      }
    }
    var apSel = document.querySelector('select[name="ap_mode"]');
    if(apSel && js.ap_mode !== undefined){
      apSel.value = flag(js.ap_mode) ? '1' : '0';
    }
    try {
      var gh = window.ghGreenhouses && window.ghGreenhouses.getActive && window.ghGreenhouses.getActive();
      if(gh && gh.base){
        document.querySelectorAll('[data-gh-topic]').forEach(function(el){ el.textContent = gh.base; });
      }
    } catch(_e){}
  }

  function updateServiceAcks(js){
    var wrap = document.getElementById('service-acks');
    if(!wrap) return;
    wrap.innerHTML = '';
    var has = false;
    if(flag(js.alert_water)){
      has = true;
      var bw = document.createElement('button');
      bw.type = 'button';
      bw.className = 'neon-buttom';
      bw.textContent = '💧 Бак залит';
      bw.onclick = function(){
        if(window.ghPublish) window.ghPublish('refill', 'water');
      };
      wrap.appendChild(bw);
    }
    if(flag(js.alert_humid)){
      has = true;
      var bh = document.createElement('button');
      bh.type = 'button';
      bh.className = 'neon-buttom';
      bh.textContent = '💨 Увлажнитель залит';
      bh.onclick = function(){
        if(window.ghPublish) window.ghPublish('refill', 'humid');
      };
      wrap.appendChild(bh);
    }
    wrap.style.display = has ? 'flex' : 'none';
  }

  function handleLocalFetch(input, init){
    init = init || {};
    var url = typeof input === 'string' ? input : (input && input.url) || '';
    var method = (init.method || 'GET').toUpperCase();
    var path = url;
    try {
      var u = new URL(url, window.location.href);
      path = u.pathname + u.search;
    } catch(_e){}

    if(method === 'GET' && (path.indexOf('/api/state') >= 0 || path.endsWith('/api/state'))){
      lastApiState = mqttToApiState(lastMqttState) || {};
      return Promise.resolve(jsonResponse(lastApiState));
    }

    if(method === 'GET' && path.indexOf('/api/status') >= 0){
      return Promise.resolve(jsonResponse(mqttToApiStatus(lastMqttState)));
    }

    if(method === 'GET' && path.indexOf('/api/history') >= 0){
      var histHours = parseHistoryHours(path);
      if(lastMqttHistory && lastMqttHistory.points && lastMqttHistory.points.length){
        return Promise.resolve(jsonResponse(filterHistoryByHours(mqttHistoryToApi(lastMqttHistory), histHours)));
      }
      var base = getDeviceHttpBase();
      if(!base) return Promise.resolve(jsonResponse({ hours: histHours, interval_sec: 60, points: [] }));
      var histUrl = base + (path.startsWith('/') ? path : '/' + path);
      return nativeFetch(histUrl, { cache: 'no-store' }).then(function(r){ return r.json(); }).catch(function(){
        return { hours: histHours, interval_sec: 60, points: [] };
      }).then(function(data){ return jsonResponse(data); });
    }

    if(method === 'GET' && path.indexOf('/api/soil_raw') >= 0){
      return Promise.resolve(jsonResponse(mqttToSoilRaw(lastMqttState)));
    }

    if(method === 'POST' && path.indexOf('/settings') >= 0){
      return Promise.resolve(init.body).then(function(body){
        var fd = parseFormBody(body);
        var cmds = settingsToMqttCommands(fd.field, fd.period || 'common', fd.value);
        if(cmds === null) return textResponse('SmartHum active', 409);
        return publishCommands(cmds).then(function(){ return textResponse('OK'); });
      });
    }

    if(method === 'POST' && path.indexOf('/send_name') >= 0){
      return Promise.resolve(init.body).then(function(body){
        var fd = parseFormBody(body);
        var name = String(fd.gh_name || '').trim();
        if(name.length > 22) return textResponse('Invalid name', 400);
        var val = name.length ? name : 'Теплица';
        return publishCommands([{ key: 'name', val: val }]).then(function(){ return textResponse('OK'); });
      });
    }

    if(method === 'POST' && path.indexOf('/send_day') >= 0){
      return Promise.resolve(init.body).then(function(body){
        var fd = parseFormBody(body);
        var onH = num(fd.light_on_hour, 0);
        var curH = num(fd.current_hour, 0);
        var val = String(onH) + ':' + String(curH);
        return publishCommands([{ key: 'set_time', val: val }]).then(function(){ return textResponse('OK'); });
      });
    }

    if(method === 'POST' && path.indexOf('/send_vpd_stage') >= 0){
      return Promise.resolve(init.body).then(function(body){
        var fd = parseFormBody(body);
        var cmds = [];
        var vpdRaw = String(fd.vpd_target_x10 || '').trim();
        if(vpdRaw.length && num(vpdRaw, 0) > 0){
          cmds.push({ key: 'vpd_stage', val: 'v:' + String(num(vpdRaw, 0)) });
        } else if(fd.growth_stage !== undefined && fd.growth_stage !== ''){
          cmds.push({ key: 'vpd_stage', val: 'g:' + String(num(fd.growth_stage, 0)) });
        }
        if(!cmds.length) return textResponse('Nothing to save', 400);
        return publishCommands(cmds).then(function(){ return textResponse('OK'); });
      });
    }

    if(method === 'POST' && (path.indexOf('/send_mqtt') >= 0 ||
        path.indexOf('/send_wifi') >= 0 || path.indexOf('/send_reset') >= 0 ||
        path.indexOf('/setup_complete') >= 0)){
      var devPost = proxyToDeviceOrLocal(path, init);
      if(devPost) return devPost.then(function(r){
        var ct = r.headers.get('Content-Type') || '';
        if(ct.indexOf('json') >= 0) return r.json().then(function(d){ return jsonResponse(d, r.status); });
        return r.text().then(function(t){ return new Response(t, { status: r.status }); });
      });
      return Promise.resolve(deviceRequiredResponse());
    }

    if(method === 'POST' && path.indexOf('/send_') >= 0){
      if(path.indexOf('/send_name') >= 0 || path.indexOf('/send_day') >= 0 || path.indexOf('/send_vpd_stage') >= 0 || path.indexOf('/settings') >= 0){
        /* handled above */
      } else {
        return handleSendPost(path, init);
      }
    }

    var devGet = proxyToDevice(path, init);
    if(devGet && method === 'GET' && path.indexOf('/api/') >= 0){
      return devGet.then(function(r){ return r.json(); }).then(function(d){ return jsonResponse(d); }).catch(function(){ return null; });
    }

    return null;
  }

  function onMqttHistory(raw){
    lastMqttHistory = raw;
    if(typeof window.fetchHistoryChart === 'function'){
      window.fetchHistoryChart();
    }
  }

  function onMqttState(js){
    lastMqttState = js;
    lastApiState = mqttToApiState(js);
    if(document.getElementById('device-name-text') && js && js.name){
      document.getElementById('device-name-text').textContent = js.name;
    }
    updateServiceAcks(js || {});
    syncPageFromMqtt(js);
    if(typeof window.syncDashboardState === 'function' && lastApiState){
      window.syncDashboardState(lastApiState);
    }
  }

  var nativeFetch = window.fetch.bind(window);
  window.fetch = function(input, init){
    var bridged = handleLocalFetch(input, init || {});
    if(bridged) return bridged;
    return nativeFetch(input, init);
  };

  window.__ghDashboardMode = !!document.querySelector('.dashboard-grid');
  window.ghMqttToApiState = mqttToApiState;
  window.ghMqttToApiStatus = mqttToApiStatus;
  window.ghUpdateServiceAcks = updateServiceAcks;
  window.ghOnMqttState = onMqttState;
  window.ghOnMqttHistory = onMqttHistory;
  window.ghMqttHistoryToApi = mqttHistoryToApi;
  window.ghFilterHistoryByHours = filterHistoryByHours;
  window.ghGetLastMqttState = function(){ return lastMqttState; };
  window.ghGetLastMqttHistory = function(){ return lastMqttHistory; };
  window.ghGetLastApiState = function(){ return lastApiState; };
  window.getDeviceHttpBase = getDeviceHttpBase;
  window.GH_MQTT_CMD_TOKEN = MQTT_CMD_TOKEN;
  window.ghFetchDeviceHtml = function(path){
    var p = proxyToDevice(path, { cache: 'no-store' });
    if(!p) return Promise.reject(new Error('deviceUrl_required'));
    return p.then(function(r){ return r.text(); });
  };

  window.addEventListener('gh-state-update', function(e){
    if(e && e.detail) onMqttState(e.detail);
  });

  window.addEventListener('gh-history-update', function(e){
    if(e && e.detail) onMqttHistory(e.detail);
  });

  if(typeof globalThis !== 'undefined' && globalThis.GH_SELFTEST){
    globalThis.__ghBridgeExports = {
      mqttToApiState: mqttToApiState,
      mqttToApiStatus: mqttToApiStatus,
      settingsToMqttCommands: settingsToMqttCommands,
      mqttHistoryToApi: mqttHistoryToApi,
      filterHistoryByHours: filterHistoryByHours,
      setLastMqttState: function(s){ lastMqttState = s; },
      setLastMqttHistory: function(h){ lastMqttHistory = h; }
    };
  }
})();
