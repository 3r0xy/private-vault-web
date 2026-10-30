# Вход в Luna через GitHub

Luna развёрнута на бесплатном Cloudflare Workers:
https://luna-private-vault.k-media-circle.workers.dev/

OAuth App зарегистрирован в аккаунте 3r0xy. Настоящий вход и восстановление
сессии после обновления страницы проверены. По явному запросу пользователя
редактирование и сохранение включены (`VAULT_WRITE_ENABLED=true`). Настройка
и проверки не изменяли заметки в `my-private-vault`.

Фактическое имя приватного репозитория подтверждено через GitHub и пользователем:
`3r0xy/my-private-vault`. Имя `my-vault` в исходном описании было неточным.

## Что изменилось

В серверной версии вместо owner / repository / token показывается «Войти через GitHub».
Backend на Node.js 24 одновременно отдаёт Luna и обслуживает `/auth/*`, `/api/github/*`.
Фронтенд не получает GitHub access token, refresh token или client secret.
Настройки vault задаются один раз на сервере: `3r0xy/my-private-vault`.

GitHub Pages остаётся рабочим резервным вариантом с прежним входом по PAT.
На нём показано, что OAuth требует серверную версию. Нет поддельной работающей
кнопки OAuth, обмена через случайный публичный сервис или отката на PAT при сбое backend.
После проверки нового адреса можно отдельно заменить Pages страницей со ссылкой на него.
Не настраивайте перенаправление на неизвестный адрес заранее.

## Почему такой backend

GitHub Pages исполняет только статические файлы и не может хранить client secret.
Обмен кода выполняется сервером. Он же обращается к GitHub: простая выдача токена
JavaScript-коду снова оставила бы токен в браузере.

Нужен **один origin**, например `https://luna.example.com`, для приложения и API.
Схема `github.io → api.example.com` с cookie `SameSite=None` ненадёжна для Safari:
WebKit блокирует сторонние cookies. Эта реализация не использует CORS, popup,
сторонние cookies, localStorage или sessionStorage для авторизации OAuth.
Можно использовать любой постоянный HTTPS-адрес хостинга, если он обслуживает
весь Node backend с постоянным диском. Это не serverless-функция с временной SQLite.

## Ограничение прав OAuth App

Для приватных файлов OAuth App запрашивает **`repo`**. Этот scope даёт широкие права
на доступные пользователю публичные и приватные репозитории, включая запись.
У OAuth App нет scope «только чтение только my-private-vault». `public_repo`, `read:user`
или отсутствие scope не решают доступ к приватным заметкам.

Backend ограничивает маршруты одним настроенным vault и проверяет неизменяемый
числовой GitHub user ID (`60850311` для подключённого аккаунта `3r0xy`). Другой
пользователь не получает сессию, даже если авторизует приложение. Нет API для
других репозиториев, управления аккаунтом, Actions, secrets, collaborators и webhooks.
Однако серверное ограничение **не сужает сам токен GitHub**: компрометация backend
с его ключом создаёт риск для всех прав scope `repo`.

Если такие права неприемлемы, используйте **GitHub App** с установкой только на
`my-private-vault`, `Contents: Read-only` (или `Read and write` для редактора), Metadata: Read.
Это отдельный адаптер авторизации/установки, не настройка OAuth App и не реализован
в этой ветке. Не регистрируйте GitHub App вместо OAuth App, ожидая совместимости.

## Регистрация OAuth App

1. Сначала выберите постоянный адрес backend, например `https://luna.example.com`.
2. В аккаунте `3r0xy`: Settings → Developer settings → OAuth Apps → New OAuth App.
3. Application name: `Luna`.
4. Homepage URL: `https://luna.example.com/`.
5. Authorization callback URL: **`https://luna.example.com/auth/callback`**.
   Укажите точный адрес, выключите wildcard matching, если эта настройка предлагается.
6. Device Flow не нужен. Если доступна настройка Expire user access tokens,
   оставьте её включённой: backend поддерживает обновление и ротацию refresh token.
7. Получите Client ID и создайте Client Secret. Сохраните secret только в защищённом
   файле окружения backend. Не присылайте его в чат, не добавляйте в GitHub Actions
   для сборки Pages, JS, manifest, URL, скриншоты или репозиторий.

Отдельное OAuth App рекомендуется для локальной разработки с callback
`http://127.0.0.1:8787/auth/callback`; production-приложение должно использовать HTTPS.

## Конкретный вариант размещения: Linux VPS + Node 24 + Nginx

Потребуется сервер с постоянным диском, доступом к GitHub, DNS-именем и TLS.
Backend не требует npm-зависимостей: SQLite и криптография встроены в Node 24.
Библиотеки редактора уже лежат в `vendor/`. Не отдавайте корень checkout через Nginx:
все публичные файлы отдаёт backend по явному списку.

1. На сервере установите поддерживаемый Node.js 24 и Nginx. Проверьте `node --version`
   и расположение `node` командой `command -v node`.
2. Создайте системного пользователя `luna` без shell и поместите проверенную ветку
   репозитория в `/opt/luna`. Каталог кода должен принадлежать администратору;
   процесс Luna должен иметь право читать код, но не изменять его.
3. Скопируйте `.env.example` в `/etc/luna.env` с правами `600`, владельцем `root`.
   Заполните `PUBLIC_ORIGIN` **без завершающего `/`**, Client ID и Client Secret.
   Сгенерируйте `TOKEN_ENCRYPTION_KEY` локально на сервере: 32 случайных байта в hex,
   например `openssl rand -hex 32`. Сохраните результат прямо в защищённый файл;
   не копируйте вывод в логи или чат. Значения не должны попадать в историю команд.
4. Оставьте `VAULT_WRITE_ENABLED=false` для первого запуска. Это реальный запрет
   записи на backend, а не только скрытая кнопка. Для обычной работы редактора и
   планера после проверки чтения установите `true` и перезапустите сервис.
   Авторизация сама по себе ничего не записывает в vault.
5. Установите `deploy/luna.service` в `/etc/systemd/system/luna.service`.
   При необходимости исправьте `/usr/bin/node` в `ExecStart`.
   `StateDirectory=luna` создаст закрытый `/var/lib/luna` для SQLite и WAL.
   Выполните `systemctl daemon-reload`, затем `systemctl enable --now luna`.
6. Выпустите сертификат для выбранного DNS-имени (например, ACME/Let's Encrypt).
   Для standalone-выпуска порт 80 должен быть свободен; после выпуска включите Nginx
   и настройте автоматическое продление с reload Nginx. Не включайте шаблон TLS
   до появления указанных файлов сертификата.
7. Установите `deploy/nginx.conf` в конфигурацию `http` Nginx, заменив домен и пути
   сертификата. Проверьте `nginx -t`, затем перезагрузите Nginx. Firewall должен
   пропускать HTTPS, а порт 8787 оставьте доступным только на loopback.
8. На всех дополнительных прокси/хостингах отключите захват query, headers и body
   для `/auth/*` и `/api/*`; отключите APM session replay, кэширование, debug/trace.
   Шаблон Nginx отключает access/error request logs для этого виртуального хоста.
   Node не логирует запросы, коды OAuth, токены и ответы GitHub.

В production запускайте **один процесс** backend с одним постоянным SQLite-диском.
Ротация refresh token сериализована внутри процесса. Несколько реплик/cluster/PM2
workers требуют общей транзакционной сессии и распределённой блокировки обновления,
которых эта небольшая персональная версия не предоставляет.
Не включайте load balancer replicas с этой конфигурацией.

Для локальной разработки скопируйте `.env.example` в `.env`, укажите тестовое OAuth App,
`PUBLIC_ORIGIN=http://127.0.0.1:8787`, `ALLOW_HTTP_LOCALHOST=true`,
`SESSION_DB=./data/sessions.sqlite`, затем `npm start`. Используйте только loopback;
локальная cookie без `Secure` не предназначена для публичного сервера.

## Бесплатное размещение Cloudflare Workers

Добавлен адаптер `cloudflare/worker.mjs` и конфигурация `wrangler.jsonc`.
Приложение и API обслуживаются одним Worker на адресе `workers.dev`; свой домен
и VPS не обязательны. Защищённые сессии сохраняются в SQLite Durable Object,
а не в временной файловой системе Worker. Один Durable Object координирует
обновление refresh token для всех экземпляров. Используется тот же код OAuth,
шифрования и ограничений API, что в серверной версии.

Cloudflare поддерживает SQLite Durable Objects на Workers Free. При исчерпании
лимитов бесплатного тарифа запросы завершаются ошибкой; переходить на платный
тариф для личной Luna не требуется. Доступность зависит также от сети пользователя.

1. `npm ci`, затем `npx wrangler login --use-keyring` (Windows потребует официальный
   адаптер `@napi-rs/keyring`). Для публикации нужны account:read, user:read,
   workers:write и workers_scripts:write. Остальные scopes не добавляйте без причины.
2. `npx wrangler deploy` публикует закрытую заготовку. Production не читает `.dev.vars`.
   Пока обязательные параметры не настроены, Worker возвращает 503 и не начинает OAuth.
3. Укажите реальный `PUBLIC_ORIGIN` и Client ID в переменных Worker, Client Secret
   и `TOKEN_ENCRYPTION_KEY` — только в зашифрованных Secrets Cloudflare. Новый ключ:
   32 криптографически случайных байта в hex. Не вводите секреты в аргументы CLI.
4. Callback OAuth App: `<PUBLIC_ORIGIN>/auth/callback`, без wildcard.
5. Оставьте `VAULT_WRITE_ENABLED=false` до проверки чтения. Бесплатный тариф не
   требует включения записи. Включение редактора выполняется отдельной настройкой.

Сборка копирует только явный список публичных файлов в `work/worker-assets`.
Исходники backend, `.env`, тестовые ключи, база сессий и Git-метаданные туда не
попадают. Observability и preview URLs выключены. OAuth start ограничен 20
попытками за 10 минут на хеш адреса клиента. Ежедневный alarm удаляет истёкшие
сессии и одноразовые flow. Секреты локальной проверки — искусственные и не публикуются.

[Условия Workers Free](https://developers.cloudflare.com/workers/platform/pricing/)
и [SQLite Durable Objects Free](https://developers.cloudflare.com/durable-objects/platform/pricing/).

## Сессии, токены и устройства

- На каждом устройстве создаётся своя сессия. По умолчанию она действует 30 дней
  с момента входа, без бесконечного продления. `SESSION_DAYS` допускает 1–90 дней.
- Cookie содержит случайный идентификатор: `__Host-luna-session`, `Secure`,
  `HttpOnly`, `SameSite=Lax`, `Path=/`, без `Domain`. В базе хранится его SHA-256.
  Идентификатор не доступен JavaScript, но физический доступ к разблокированному
  устройству даёт доступ к открытой Luna.
- Access/refresh tokens в SQLite зашифрованы AES-256-GCM с уникальным nonce.
  Ключ хранится отдельно от базы. Бэкап базы и ключ нельзя размещать вместе в
  общедоступном месте. Компрометация работающего сервера не устраняется шифрованием.
- OAuth использует state, PKCE S256 и отдельную HttpOnly-cookie привязки к браузеру.
  Callback одноразовый, срок 10 минут, redirect обратно фиксированный.
  В URL callback неизбежно приходит временный **код авторизации**, как требует GitHub;
  это не access/refresh token. Сервер сразу обменивает его и отправляет на чистый `/`.
  `Referrer-Policy: no-referrer`, отключённые request logs и отсутствие аналитики
  уменьшают утечки кода. Сам GitHub управляет своим экраном и журналами авторизации.
- Короткоживущие токены обновляются сервером. При обновлении повторно проверяется
  GitHub user ID. При 401 сессия удаляется; пользователь снова входит через GitHub.
- «Выйти» удаляет серверную сессию и cookie этого устройства. Это не отзыв всех
  разрешений OAuth App на GitHub и не выход на других устройствах.
  Для полного отзыва: GitHub Settings → Applications → Authorized OAuth Apps → Luna → Revoke.
  Для немедленного сброса всех локальных сессий администратор может остановить сервис,
  удалить записи таблиц `sessions` и `flows` и запустить его снова.
- Очистка cookies, приватный режим, истечение сессии и отзыв GitHub потребуют нового
  входа. Обещания «вход навсегда» нет. Настройки старого PAT на другом origin не
  переносятся; backend удаляет старый `pv_token` только со своего origin, если он был.
- Backend не сохраняет тексты заметок в базе сессий, ответы API не кэшируются.
  В приложении остаётся существующее сохранение путей открытых вкладок и настроек в
  localStorage; тексты вкладок этой функцией не сохраняются. OAuth не добавляет
  зашифрованное offline-хранилище.
  CSP запрещает внешние скрипты и произвольные внешние изображения/соединения.

## iPad Safari, PWA, телефон и ПК

Откройте **новый адрес Luna** и войдите один раз на каждом устройстве. Ручные
owner, repository и PAT больше не нужны. Разрешите cookies первого сайта.
Вход открывается обычным переходом, без popup; запрещённый Web Storage не мешает сессии.

Для PWA удалите старый ярлык Pages и добавьте новый адрес через Safari →
«На экран Домой». Safari и установленная PWA могут иметь отдельные хранилища:
проверьте вход именно из того контекста, которым будете пользоваться.
Если конкретная версия iPadOS переносит OAuth в отдельный Safari-контекст без
cookie привязки, вход безопасно отклонится. Используйте Safari с новым адресом;
не выключайте проверку state/cookie и не переносите токены между контекстами.
Поддержка такого отдельного PWA-контекста требует отдельной проверки/адаптации на
устройстве. В этой среде физический iPad и настоящий Safari недоступны;
эмуляция размеров экрана в Chromium не подтверждает поведение iPadOS PWA.

Проверка после размещения (сначала при `VAULT_WRITE_ENABLED=false`):

1. Вход, список файлов и чтение существующей заметки. Никакого сохранения/импорта.
2. Полное закрытие браузера и повторное открытие — vault открывается без PAT.
3. Отдельно Safari и PWA после закрытия, перезапуска iPad и возврата из GitHub.
4. «Выйти», обновление страницы — заметки недоступны до нового входа.
5. Отказ на экране GitHub, другой аккаунт, истечение cookie, отзыв приложения —
   понятная ошибка, нет доступа и нет перехода на ввод токена.
6. В DevTools нет GitHub-токенов в localStorage/sessionStorage, URL, console;
   браузер обращается за заметками только к `/api/github` собственного origin.

## Автоматические проверки

```sh
npm ci
npm test
npm run test:oauth
npm run test:login
npm run test:browser
npm run test:oauth-browser
```

Для браузерных тестов нужен Chromium/Edge; установка и переменные описаны в README.
Все запросы GitHub подменяются. Проверены PKCE, state/cookie binding, replay/race,
истечение, чужой аккаунт, недостаточные scopes, CSRF/Origin, ротация сессии,
шифрование и перезапуск хранилища, отзыв, обновление токена, ограничения proxy,
cookie после перезапуска браузерного контекста, запрет Web Storage и отсутствие
реальных записей при входе/чтении. Существующие сценарии редактора/планера проверяются
на искусственных данных. Настоящий GitHub OAuth App ими не проверяется.

## Официальные источники

- [Создание OAuth App](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/creating-an-oauth-app)
- [GitHub OAuth: обмен, PKCE, state и refresh](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps)
- [Scopes и права repo](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/scopes-for-oauth-apps)
- [WebKit: сторонние cookies и хранилища Home Screen apps](https://webkit.org/blog/10218/full-third-party-cookie-blocking-and-more/)
- [Nginx access_log off](https://nginx.org/en/docs/http/ngx_http_log_module.html)
