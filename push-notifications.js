/**
 * GrowHub Push Notifications Module
 * Реализует надежную систему push-уведомлений с поддержкой:
 * - Web Push API (Chrome, Firefox, Edge, Safari 16+)
 * - Fallback для iOS (до Safari 16.4) через local notifications
 * - VAPID аутентификация
 * - Управление подписками
 */

const PUSH_CONFIG_KEY = 'gh_push_config_v1';
const PUSH_SUBSCRIPTION_KEY = 'gh_push_subscription_v1';

// VAPID публичный ключ - замените на свой сгенерированный ключ
// Генерация: npx web-push generate-vapid-keys
const VAPID_PUBLIC_KEY = 'BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U';

class PushNotificationManager {
  constructor() {
    this.supported = false;
    this.permission = 'default';
    this.subscription = null;
    this.swRegistration = null;
    this.iosInstalled = false;
    this.config = this.loadConfig();
    this.callbacks = {
      onPermissionChange: null,
      onSubscriptionChange: null,
      onNotification: null,
      onError: null
    };
    
    this.init();
  }

  /**
   * Инициализация модуля push-уведомлений
   */
  async init() {
    // Проверка поддержки
    this.checkSupport();
    
    // Проверка iOS PWA установки
    this.iosInstalled = this.isIOSPWA();
    
    // Получение текущего разрешения
    if ('Notification' in window) {
      this.permission = Notification.permission;
    }
    
    // Регистрация service worker если еще не зарегистрирован
    if ('serviceWorker' in navigator) {
      try {
        this.swRegistration = await navigator.serviceWorker.ready;
        console.log('[Push] Service Worker ready');
        
        // Проверка существующей подписки
        if (this.swRegistration.pushManager) {
          this.subscription = await this.swRegistration.pushManager.getSubscription();
          if (this.subscription) {
            console.log('[Push] Existing subscription found');
            this.saveSubscription(this.subscription);
          }
        }
      } catch (err) {
        console.error('[Push] Service Worker registration failed:', err);
      }
    }
    
    // Слушаем сообщения от Service Worker
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.addEventListener('message', (event) => {
        this.handleSWMessage(event.data);
      });
    }
  }

  /**
   * Проверка поддержки Push API
   */
  checkSupport() {
    const hasSW = 'serviceWorker' in navigator;
    const hasNotification = 'Notification' in window;
    const hasPushManager = 'PushManager' in window;
    
    // Полная поддержка Web Push
    if (hasSW && hasNotification && hasPushManager) {
      this.supported = true;
      this.supportLevel = 'full';
      return;
    }
    
    // Частичная поддержка (только notifications, без push)
    if (hasNotification) {
      this.supported = true;
      this.supportLevel = 'notifications-only';
      return;
    }
    
    // iOS Safari до 16.4 - специальная обработка
    if (this.isIOS() && !hasPushManager) {
      this.supported = false;
      this.supportLevel = 'ios-limited';
      return;
    }
    
    this.supported = false;
    this.supportLevel = 'none';
  }

  /**
   * Определение iOS устройства
   */
  isIOS() {
    return /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
  }

  /**
   * Проверка запуска как PWA на iOS
   */
  isIOSPWA() {
    return this.isIOS() && 
           ('standalone' in window.navigator) && 
           window.navigator.standalone;
  }

  /**
   * Проверка поддержки уведомлений в текущем браузере
   */
  getCapabilities() {
    return {
      supported: this.supported,
      supportLevel: this.supportLevel,
      permission: this.permission,
      isSubscribed: !!this.subscription,
      isIOS: this.isIOS(),
      isIOSPWA: this.iosInstalled,
      canRequestPermission: this.permission === 'default',
      browserInfo: this.getBrowserInfo()
    };
  }

  /**
   * Получение информации о браузере
   */
  getBrowserInfo() {
    const ua = navigator.userAgent;
    if (ua.includes('Firefox')) return { name: 'Firefox', supportsWebPush: true };
    if (ua.includes('Edg')) return { name: 'Edge', supportsWebPush: true };
    if (ua.includes('Chrome')) return { name: 'Chrome', supportsWebPush: true };
    if (ua.includes('Safari')) {
      const version = ua.match(/Version\/(\d+)/);
      const versionNum = version ? parseInt(version[1]) : 0;
      return { 
        name: 'Safari', 
        version: versionNum,
        supportsWebPush: versionNum >= 16 
      };
    }
    return { name: 'Unknown', supportsWebPush: false };
  }

  /**
   * Запрос разрешения на уведомления
   */
  async requestPermission() {
    if (!('Notification' in window)) {
      throw new Error('Уведомления не поддерживаются в этом браузере');
    }
    
    if (this.permission === 'denied') {
      throw new Error('Уведомления заблокированы. Разрешите их в настройках браузера.');
    }
    
    if (this.permission === 'granted') {
      return 'granted';
    }
    
    try {
      // Запрос разрешения
      const result = await Notification.requestPermission();
      this.permission = result;
      
      if (this.callbacks.onPermissionChange) {
        this.callbacks.onPermissionChange(result);
      }
      
      console.log('[Push] Permission result:', result);
      return result;
    } catch (err) {
      console.error('[Push] Permission request failed:', err);
      throw err;
    }
  }

  /**
   * Подписка на push-уведомления
   */
  async subscribe() {
    if (!this.supported || this.supportLevel === 'none') {
      throw new Error('Push-уведомления не поддерживаются');
    }
    
    // Сначала запрашиваем разрешение
    const permission = await this.requestPermission();
    if (permission !== 'granted') {
      throw new Error('Разрешение на уведомления не получено');
    }
    
    // Для iOS без Web Push - используем local notifications
    if (this.supportLevel === 'notifications-only' || this.supportLevel === 'ios-limited') {
      console.log('[Push] Using local notifications fallback');
      this.saveConfig({ enabled: true, fallback: true });
      return { fallback: true };
    }
    
    if (!this.swRegistration || !this.swRegistration.pushManager) {
      throw new Error('Push Manager недоступен');
    }
    
    try {
      // Конвертация VAPID ключа
      const applicationServerKey = this.urlBase64ToUint8Array(VAPID_PUBLIC_KEY);
      
      // Подписка на push
      this.subscription = await this.swRegistration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: applicationServerKey
      });
      
      console.log('[Push] Subscription successful:', this.subscription.endpoint);
      
      // Сохраняем подписку
      this.saveSubscription(this.subscription);
      this.saveConfig({ enabled: true, fallback: false });
      
      if (this.callbacks.onSubscriptionChange) {
        this.callbacks.onSubscriptionChange(this.subscription);
      }
      
      return this.subscription;
    } catch (err) {
      console.error('[Push] Subscription failed:', err);
      throw err;
    }
  }

  /**
   * Отписка от push-уведомлений
   */
  async unsubscribe() {
    if (this.subscription) {
      try {
        await this.subscription.unsubscribe();
        console.log('[Push] Unsubscribed successfully');
      } catch (err) {
        console.error('[Push] Unsubscribe failed:', err);
      }
    }
    
    this.subscription = null;
    localStorage.removeItem(PUSH_SUBSCRIPTION_KEY);
    this.saveConfig({ enabled: false });
    
    if (this.callbacks.onSubscriptionChange) {
      this.callbacks.onSubscriptionChange(null);
    }
  }

  /**
   * Показать локальное уведомление (fallback для iOS и тестирования)
   */
  async showLocalNotification(title, options = {}) {
    if (this.permission !== 'granted') {
      console.warn('[Push] Cannot show notification - permission not granted');
      return false;
    }
    
    const defaultOptions = {
      icon: 'favicon-plant.svg',
      badge: 'favicon-plant.svg',
      vibrate: [200, 100, 200],
      requireInteraction: false,
      silent: false,
      tag: 'growhub-notification',
      renotify: true,
      data: { 
        url: window.location.origin,
        timestamp: Date.now()
      }
    };
    
    const mergedOptions = { ...defaultOptions, ...options };
    
    // Используем Service Worker для показа уведомления если возможно
    if (this.swRegistration) {
      try {
        await this.swRegistration.showNotification(title, mergedOptions);
        console.log('[Push] Notification shown via SW');
        return true;
      } catch (err) {
        console.warn('[Push] SW notification failed, trying fallback:', err);
      }
    }
    
    // Fallback - прямое создание уведомления
    try {
      const notification = new Notification(title, mergedOptions);
      
      notification.onclick = () => {
        window.focus();
        notification.close();
        if (mergedOptions.data && mergedOptions.data.url) {
          window.location.href = mergedOptions.data.url;
        }
      };
      
      console.log('[Push] Notification shown directly');
      return true;
    } catch (err) {
      console.error('[Push] Direct notification failed:', err);
      return false;
    }
  }

  /**
   * Показать уведомление о критическом событии теплицы
   */
  async showGrowHubAlert(alertType, alertData = {}) {
    const alerts = {
      alert_water: {
        title: '⚠️ Бак для воды пуст!',
        body: 'Требуется дозаправка бака для полива.',
        tag: 'growhub-water'
      },
      alert_humid: {
        title: '⚠️ Увлажнитель пуст!',
        body: 'Требуется дозаправка увлажнителя.',
        tag: 'growhub-humid'
      },
      alert_high_temp: {
        title: '🌡️ Слишком жарко!',
        body: `Температура: ${alertData.temp || '?'}°C`,
        tag: 'growhub-temp-high'
      },
      alert_low_temp: {
        title: '❄️ Слишком холодно!',
        body: `Температура: ${alertData.temp || '?'}°C`,
        tag: 'growhub-temp-low'
      },
      err_sensor_temp: {
        title: '⚠️ Ошибка датчика температуры',
        body: 'Датчик температуры не отвечает.',
        tag: 'growhub-sensor-temp'
      },
      err_sensor_hg: {
        title: '⚠️ Ошибка датчика влажности почвы',
        body: 'Верхний датчик влажности почвы не отвечает.',
        tag: 'growhub-sensor-hg'
      },
      err_sensor_hg2: {
        title: '⚠️ Ошибка датчика влажности почвы',
        body: 'Нижний датчик влажности почвы не отвечает.',
        tag: 'growhub-sensor-hg2'
      },
      err_sensor_dht: {
        title: '⚠️ Ошибка датчика влажности воздуха',
        body: 'Датчик влажности воздуха не отвечает.',
        tag: 'growhub-sensor-dht'
      },
      rebooted: {
        title: '⚡ Теплица перезагружена',
        body: 'Требуется настройка времени.',
        tag: 'growhub-reboot'
      },
      watering_notification_pending: {
        title: '💧 Ваша очередь поливать!',
        body: `Влажность почвы: ${alertData.humgr || '?'}%. Режим чередования - сейчас ручной полив.`,
        tag: 'growhub-alternate-watering'
      }
    };
    
    const alertConfig = alerts[alertType];
    if (!alertConfig) {
      console.warn('[Push] Unknown alert type:', alertType);
      return false;
    }
    
    // Проверяем настройки уведомлений для данного типа
    if (!this.isAlertEnabled(alertType)) {
      console.log('[Push] Alert type disabled:', alertType);
      return false;
    }
    
    return await this.showLocalNotification(alertConfig.title, {
      body: alertConfig.body,
      tag: alertConfig.tag,
      data: {
        type: alertType,
        url: window.location.origin + '/index.html',
        ...alertData
      }
    });
  }

  /**
   * Проверка включен ли тип уведомления
   */
  isAlertEnabled(alertType) {
    const config = this.loadConfig();
    if (!config.enabled) return false;
    
    // Если нет специфических настроек - все включены
    if (!config.alertTypes) return true;
    
    return config.alertTypes[alertType] !== false;
  }

  /**
   * Установка настроек для типов уведомлений
   */
  setAlertPreferences(preferences) {
    const config = this.loadConfig();
    config.alertTypes = { ...config.alertTypes, ...preferences };
    this.saveConfig(config);
  }

  /**
   * Получение настроек уведомлений
   */
  getAlertPreferences() {
    const config = this.loadConfig();
    return config.alertTypes || {
      alert_water: true,
      alert_humid: true,
      alert_high_temp: true,
      alert_low_temp: true,
      err_sensor_temp: true,
      err_sensor_hg: true,
      err_sensor_hg2: true,
      err_sensor_dht: true,
      rebooted: true
    };
  }

  /**
   * Обработка сообщений от Service Worker
   */
  handleSWMessage(data) {
    if (data.type === 'PUSH_RECEIVED') {
      console.log('[Push] Push received via SW:', data.payload);
      if (this.callbacks.onNotification) {
        this.callbacks.onNotification(data.payload);
      }
    }
    
    if (data.type === 'NOTIFICATION_CLICKED') {
      console.log('[Push] Notification clicked:', data.payload);
      // Навигация обрабатывается в SW
    }
  }

  /**
   * Установка колбэков
   */
  on(event, callback) {
    if (event in this.callbacks) {
      this.callbacks[event] = callback;
    }
  }

  /**
   * Конвертация VAPID ключа из base64
   */
  urlBase64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - base64String.length % 4) % 4);
    const base64 = (base64String + padding)
      .replace(/-/g, '+')
      .replace(/_/g, '/');
    
    const rawData = window.atob(base64);
    const outputArray = new Uint8Array(rawData.length);
    
    for (let i = 0; i < rawData.length; ++i) {
      outputArray[i] = rawData.charCodeAt(i);
    }
    return outputArray;
  }

  /**
   * Сохранение конфигурации
   */
  saveConfig(config) {
    const current = this.loadConfig();
    const merged = { ...current, ...config };
    localStorage.setItem(PUSH_CONFIG_KEY, JSON.stringify(merged));
    this.config = merged;
  }

  /**
   * Загрузка конфигурации
   */
  loadConfig() {
    try {
      const stored = localStorage.getItem(PUSH_CONFIG_KEY);
      return stored ? JSON.parse(stored) : { enabled: false };
    } catch (e) {
      return { enabled: false };
    }
  }

  /**
   * Сохранение подписки
   */
  saveSubscription(subscription) {
    if (subscription) {
      localStorage.setItem(PUSH_SUBSCRIPTION_KEY, JSON.stringify(subscription.toJSON()));
    }
  }

  /**
   * Получение сохраненной подписки
   */
  getSavedSubscription() {
    try {
      const stored = localStorage.getItem(PUSH_SUBSCRIPTION_KEY);
      return stored ? JSON.parse(stored) : null;
    } catch (e) {
      return null;
    }
  }

  /**
   * Проверка и отправка подписки на сервер
   * Вызывается после успешной подписки для регистрации на backend
   */
  async sendSubscriptionToServer(subscription) {
    // Если есть MQTT подключение - отправляем через него
    if (window.manager && window.ghPublish) {
      const subJson = subscription.toJSON();
      window.ghPublish('push_subscription', JSON.stringify(subJson));
      console.log('[Push] Subscription sent via MQTT');
      return true;
    }
    
    console.warn('[Push] No MQTT connection to send subscription');
    return false;
  }

  /**
   * Получение статуса для отображения в UI
   */
  getStatusText() {
    if (!this.supported) {
      if (this.supportLevel === 'ios-limited') {
        return 'Добавьте приложение на главный экран для уведомлений';
      }
      return 'Уведомления не поддерживаются';
    }
    
    if (this.permission === 'denied') {
      return 'Уведомления заблокированы в настройках браузера';
    }
    
    if (this.permission === 'default') {
      return 'Нажмите для включения уведомлений';
    }
    
    if (this.config.enabled) {
      if (this.subscription) {
        return 'Уведомления включены (Web Push)';
      }
      if (this.config.fallback) {
        return 'Уведомления включены (локальные)';
      }
      return 'Уведомления включены';
    }
    
    return 'Уведомления отключены';
  }
}

// Глобальный экземпляр
window.pushManager = new PushNotificationManager();

// Экспорт для модульного использования
if (typeof module !== 'undefined' && module.exports) {
  module.exports = PushNotificationManager;
}
