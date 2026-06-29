/**
 * PWA handoff — переход с локальной сети теплицы на облачную PWA.
 */
(function(global){
  'use strict';

  var probeTimer = null;
  var probeBound = false;
  var state = { online: false, lastUrl: '' };
  var activeCfg = null;

  function isPrivateHost(h){
    if(!h || h === 'localhost' || h.indexOf('.local') > 0) return true;
    var p = h.split('.').map(function(x){ return parseInt(x, 10); });
    if(p.length !== 4 || p.some(function(n){ return !Number.isFinite(n); })) return false;
    if(p[0] === 10) return true;
    if(p[0] === 192 && p[1] === 168) return true;
    if(p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true;
    if(p[0] === 169 && p[1] === 254) return true;
    return false;
  }

  function probeInternet(probeBase){
    var base = String(probeBase || 'https://achpaul.github.io/1/').replace(/\/?$/, '/');
    return new Promise(function(resolve){
      var img = new Image();
      var done = false;
      var finish = function(ok){
        if(done) return;
        done = true;
        clearTimeout(timer);
        resolve(!!ok);
      };
      var timer = setTimeout(function(){ finish(false); }, 4500);
      img.onload = function(){ finish(true); };
      img.onerror = function(){ finish(false); };
      img.src = base + 'favicon-plant.svg?_=' + Date.now();
    });
  }

  function copyText(text){
    if(navigator.clipboard && navigator.clipboard.writeText){
      return navigator.clipboard.writeText(text);
    }
    return new Promise(function(resolve, reject){
      try{
        var ta = document.createElement('textarea');
        ta.value = text;
        ta.setAttribute('readonly', '');
        ta.style.position = 'fixed';
        ta.style.left = '-9999px';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        resolve();
      }catch(e){ reject(e); }
    });
  }

  function toast(el, text, ok){
    if(!el) return;
    el.textContent = text;
    el.style.color = ok ? '#a8f0b9' : (text ? '#ffb3b3' : '#caa2d4');
  }

  function updateUrlDisplay(url){
    var inp = document.getElementById('pwa-url-display');
    if(inp) inp.value = url || '';
  }

  function refreshUI(cfg){
    cfg = cfg || activeCfg || {};
    var getUrl = cfg.getUrl;
    var container = document.getElementById('pwa-container');
    if(!container) return;

    var url = getUrl ? getUrl() : '';
    state.lastUrl = url;

    var offlineBlock = document.getElementById('pwa-handoff-offline');
    var onlineBlock = document.getElementById('pwa-handoff-online');
    var link = document.getElementById('pwa-link');
    var netStatus = document.getElementById('pwa-net-status');
    var local = isPrivateHost(global.location.hostname);

    updateUrlDisplay(url);
    if(link) link.href = url || '#';

    if(local && !state.online){
      if(offlineBlock) offlineBlock.style.display = '';
      if(onlineBlock) onlineBlock.style.display = 'none';
      if(netStatus){
        netStatus.textContent = '⏳ Ожидаем интернет… Не закрывайте эту вкладку';
        netStatus.style.color = '#caa2d4';
      }
    } else {
      if(offlineBlock) offlineBlock.style.display = local ? '' : 'none';
      if(onlineBlock) onlineBlock.style.display = '';
      if(netStatus){
        if(local && state.online){
          netStatus.textContent = '🌐 Интернет доступен — можно открыть PWA';
          netStatus.style.color = '#a8f0b9';
        } else if(!local){
          netStatus.textContent = '';
        }
      }
    }
  }

  function startProbe(cfg){
    if(probeTimer) return;
    var probeBase = cfg.probeBase || 'https://achpaul.github.io/1/';
    var tick = function(){
      probeInternet(probeBase).then(function(ok){
        if(ok !== state.online){
          state.online = ok;
          refreshUI(cfg);
        }
      });
    };
    tick();
    probeTimer = setInterval(tick, 3500);
    if(!probeBound){
      probeBound = true;
      global.addEventListener('online', tick);
    }
  }

  function init(cfg){
    cfg = cfg || {};
    activeCfg = cfg;
    var container = document.getElementById('pwa-container');
    if(!container) return;

    var shareBtn = document.getElementById('pwa-btn-share');
    var copyBtn = document.getElementById('pwa-btn-copy');
    var copyStatus = document.getElementById('pwa-copy-status');
    var link = document.getElementById('pwa-link');
    var urlDisplay = document.getElementById('pwa-url-display');

    if(shareBtn && !shareBtn.dataset.bound){
      shareBtn.dataset.bound = '1';
      shareBtn.style.display = (navigator.share ? '' : 'none');
      shareBtn.addEventListener('click', function(){
        var url = state.lastUrl || (cfg.getUrl && cfg.getUrl());
        if(!url) return;
        navigator.share({
          title: 'GrowHub PWA',
          text: 'Ссылка для удалённого доступа к теплице',
          url: url
        }).catch(function(){});
      });
    }

    if(copyBtn && !copyBtn.dataset.bound){
      copyBtn.dataset.bound = '1';
      copyBtn.addEventListener('click', function(){
        var url = state.lastUrl || (cfg.getUrl && cfg.getUrl());
        if(!url) return;
        copyText(url).then(function(){
          toast(copyStatus, 'Ссылка скопирована', true);
          setTimeout(function(){ toast(copyStatus, '', true); }, 2500);
        }).catch(function(){
          toast(copyStatus, 'Не удалось скопировать', false);
        });
      });
    }

    if(urlDisplay && !urlDisplay.dataset.bound){
      urlDisplay.dataset.bound = '1';
      urlDisplay.addEventListener('focus', function(){ urlDisplay.select(); });
      urlDisplay.addEventListener('click', function(){ urlDisplay.select(); });
    }

    if(link && !link.dataset.bound){
      link.dataset.bound = '1';
      link.addEventListener('click', function(e){
        if(isPrivateHost(global.location.hostname) && !state.online){
          e.preventDefault();
          toast(document.getElementById('pwa-net-status'), 'Сначала переключитесь на домашний Wi‑Fi или мобильный интернет', false);
        }
      });
    }

    global.GHPwaHandoffRefresh = function(){ refreshUI(cfg); };
    startProbe(cfg);
    refreshUI(cfg);
  }

  global.GHPwaHandoff = { init: init, probeInternet: probeInternet, isPrivateHost: isPrivateHost };
})(window);
