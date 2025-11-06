# GrowHub Remote UI (Static PWA)

Статическая веб-страница для удалённого управления теплицей через облачный MQTT брокер (WebSockets). Развёртывается на GitHub Pages или Netlify без серверного backend.

## Возможности
- Отображение текущего состояния (температура, влажность почвы/воздуха, освещение, профиль, алерты).
- Управление: lig_type, lig_hours, lig_pwm, temp_day/night, humgr_day/night, humair_day/night, profile.
- Автоматическое переподключение.
- PWA (иконка, оффлайн-кэш только статики).
- Локальное сохранение параметров подключения (localStorage).

## Требования к прошивке
- Публикация retained JSON в `<base>state/json` с полями (см. mqtt.cpp):
  `name, profile_id, profile_name, day_time, lig_type, lig_hours, lig_pwm, temp_day, temp_night, humgr_day, humgr_night, humair_day, humair_night, temp_now, humgr_now, humair_now, alert_water, alert_humid, alert_high_temp, alert_low_temp`.
- Обработка команд в темах `<base>set/<key>` где `<key>` ∈ `lig_type, lig_hours, lig_pwm, temp_day, temp_night, humgr_day, humgr_night, humair_day, humair_night, profile`.

## Использование
1. Откройте страницу с параметрами в URL:
```
https://<ваш-домен>/?h=<host>&p=<wssPort>&u=<user>&pw=<pass>&b=growhub/<mac>/
```
2. При первом входе можно также ввести данные вручную в блоке "Настройка" и нажать "Сохранить и подключиться".
3. Изменяйте слайдеры или тип освещения — значения публикуются в MQTT.
4. Поле профиля: id или точное имя → кнопка OK.

## Безопасность
- Креды хранятся в localStorage открытым текстом (браузер пользователя). Не вставляйте ссылку с паролем в публичных местах.
- Для отзыва доступа выполните ротацию пароля на брокере и выдайте новый QR.

## Структура
```
index.html       – разметка и UI
app.js           – логика подключения, обновление DOM
manifest.json    – PWA метаданные
service-worker.js– кэш статики (без кэширования телеметрии)
icon-192.png     – иконка (добавить)
icon-512.png     – иконка (добавить)
```

## Деплой на GitHub Pages
1. Создайте репозиторий (публичный) и поместите файлы в корень или в папку `docs/`.
2. В Settings → Pages выберите ветку `main` (или `/docs`).
3. Дождитесь генерации URL `<user>.github.io/<repo>/`.
4. Сформируйте QR с параметрами подключения.

## Деплой на Netlify (альтернатива)
1. Netlify → New site from Git → выбрать репозиторий.
2. Build command: (пусто), Publish directory: `remote_ui` или корень.
3. После деплоя домен `*.netlify.app`. (Добавьте custom домен при желании.)

## Кастомизация
- Цветовую схему можно править через CSS переменные в `index.html`.
- PUB_THROTTLE_MS в `app.js` определяет троттлинг публикаций при перетаскивании.

## TODO (возможные улучшения)
- Ack топик для мгновенного подтверждения изменений.
- Pairing код / временный токен вместо прямого пароля в URL.
- Графики (добавить исторический буфер в прошивке + отдельные темы).
- Темная/светлая тема переключатель.

## Лицензия
Оставьте уведомление об авторстве по необходимости.
