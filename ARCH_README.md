# Suno Feed Capture — техническая архитектура

Расширение Chrome (MV3), которое перехватывает сетевые ответы Suno (`/api/feed/v3`, `/api/unified/feed`, ...), нормализует их, хранит в `chrome.storage.local`, показывает в popup с фильтрами/поиском и умеет массово скачивать аудио с настраиваемой задержкой между загрузками.

## Структура

```
suno-feed-capture/
├── manifest.json          # MV3 манифест
├── content_main.js        # MAIN world: перехват fetch/XHR
├── content_bridge.js      # ISOLATED world: мост в background
├── background.js          # service worker: парсинг, storage, очередь загрузок
├── popup.html             # разметка popup
├── popup.css              # стили popup
└── popup.js               # логика popup
```

## Главный технический трюк: MAIN vs ISOLATED world

Content scripts в Chrome по умолчанию живут в **isolated world** — это отдельный JS-контекст с собственным глобалом, но с общим DOM. Если из него сделать `window.fetch = patched`, то страница (которая в **main world**) продолжит вызывать оригинальный `fetch`, потому что у неё свой собственный `window`. Это самая частая причина, почему «перехват не ловит».

Решение: объявить два content-скрипта с разными `world`:

- `content_main.js` с `world: "MAIN"` — патчит `window.fetch` и `XMLHttpRequest` так, что это реально влияет на код страницы
- `content_bridge.js` с `world: "ISOLATED"` — слушает `postMessage` от main-скрипта и шлёт в background через `chrome.runtime.sendMessage`

Без этого перехват молча не работает.

## Поток данных

```
┌─────────────────────┐  window.fetch   ┌──────────────────────┐
│  Suno page (MAIN)   │ ───────────────▶│  Original API server │
│  patched by         │ ◀───────────────│  (studio-api-...)    │
│  content_main.js    │   response      └──────────────────────┘
└──────────┬──────────┘
           │ postMessage (same window, main→main)
           ▼
┌─────────────────────┐  runtime.sendMessage
│  content_bridge.js  │ ───────────────────────────────────┐
│  (ISOLATED)         │                                    │
└─────────────────────┘                                    ▼
                                          ┌──────────────────────────┐
                                          │  background.js (SW)      │
                                          │  findClipArrays()        │
                                          │  normalizeClip()         │
                                          │  chrome.storage.local    │
                                          └────────┬─────────────────┘
                                                   │ storage.onChanged
                                                   ▼
                                          ┌──────────────────────────┐
                                          │  popup.html/js           │
                                          │  render + bulk download  │
                                          └──────────────────────────┘
```

## Компоненты подробно

### `manifest.json`

- `manifest_version: 3`, `minimum_chrome_version: 111` (нужен `world: "MAIN"` в content_scripts)
- `permissions: ["storage", "downloads"]` — `storage` для `chrome.storage.local`, `downloads` для `chrome.downloads.download`
- `host_permissions` — все возможные домены Suno, потому что Suno в какой-то момент переехал с `studio.suno.com` на `suno.com`, и не хочется угадывать
- `action.default_popup` — открывает popup по клику на иконку
- `background.service_worker` с `type: "module"` — для возможности использовать ES-модули
- `content_scripts` — два скрипта, оба с `all_frames: true` (на случай iframe) и `run_at: "document_start"` (патчить до того, как код страницы сохранит ссылку на оригинальный `fetch`)

### `content_main.js` (MAIN world)

IIFE, который:
1. Сохраняет оригинальные `window.fetch` и `XMLHttpRequest.prototype.open/send`
2. Заменяет их на обёртки, которые:
   - Определяют `url` из аргументов
   - Проверяют по списку `TARGET_NEEDLES` — точным URL-паттернам (полный домен + путь, по домену, по пути для устойчивости к смене хоста)
   - Если матч — после `response` клонируют тело (response body читается один раз, поэтому клонируем до отдачи оригинала странице), читают как JSON (с fallback на text) и отправляют через `window.postMessage` с маркером `__sunoFeed: true, v: 1`
3. Помечает `window.__sunoFeedPatchedFetch/XHR`, чтобы не патчить повторно (например, если скрипт инжектится несколько раз)

`TARGET_NEEDLES` сейчас:
- `studio-api-prod.suno.com/api/feed/v3` + варианты
- `studio-api-prod.suno.com/api/unified/feed` + варианты

### `content_bridge.js` (ISOLATED world)

IIFE, который вешает `window.addEventListener('message', ...)`:
- Фильтрует `event.source !== window` (только своё окно, не iframe чужих доменов)
- Проверяет маркер `__sunoFeed` и версию
- Форвардит в `chrome.runtime.sendMessage` с `type: 'FEED_CAPTURED'`
- Ловит `chrome.runtime.lastError` через callback-параметр, чтобы не падать при invalidated context

### `background.js` (service worker)

Три основные обязанности:

**1. Парсинг payload**

`findClipArrays(obj, path, depth, sourceOverride)`:
- Рекурсивно обходит payload (с лимитом `depth <= 8` чтобы не зациклиться)
- На каждом уровне вычисляет `localSource`:
  - Если у объекта есть непустой `feed_title` — берёт его
  - Иначе наследует `sourceOverride` от родителя
  - Если ничего — `null` (тогда `normalizeClip` подставит URL-based label)
- Находит массивы, где каждый элемент — объект с полем `id` (эвристика «это клип»)
- Возвращает `[{ array, path, source }, ...]`

`normalizeClip(raw, sourceUrl, capturedAt, sourceOverride)`:
- Достаёт поля по списку алиасов: `id`, `title`, `audio_url` / `playback_url` / ..., `image_url` / `cover_url` / ..., `duration`, `created_at`, `status`, `model_name`, `tags`, `prompt`
- Сохраняет `raw` (весь оригинальный объект клипа) — для отладки и будущих полей
- `source = sourceOverride || detectSource(sourceUrl)`
- `detectSource`:
  - URL содержит `/api/feed/v3` → `'feed'`
  - URL содержит `/api/unified/feed` → `'unified'`
  - иначе → `'other'`

**2. Хранение в `chrome.storage.local`**

- `capturedItems: Item[]` — все нормализованные клипы
- `downloadQueue: QueueState` — состояние очереди загрузок
- `downloadSettings: { delayMs, includeAudio, includeVideo }` — настройки пользователя

Дедуп: при добавлении нового клипа в `handleCapture` строится `Map<id, Item>`, для каждого id побеждает запись с самым свежим `capturedAt`. Это значит, что один и тот же клип из `/api/feed/v3` и из `/api/unified/feed` (если id совпадает) будет перезаписан свежим capture, а не задублирован.

**3. Очередь bulk-скачивания**

Состояние в `downloadQueue`:
```js
{
  active: bool,
  paused: bool,
  pending: [{ id, rawId, title, kind: 'audio'|'video', url }],
  completed: number,
  failed: number,
  currentTitle: string | null,
  currentId: string | null,
  errors: [{ id, title, url, error }],
  startedAt: number,
  total: number,
}
```

`processNextDownload()`:
1. Если `!active || paused || stopping` — выход
2. Если `pending` пуст — финиш (сброс `active`)
3. Берёт первый элемент, обновляет `currentTitle/currentId`, пишет в storage
4. `chrome.downloads.download({ url, filename: 'suno-feed/<title>_<id8>.<ext>', conflictAction: 'uniquify', saveAs: false })`
5. По `await` — инкрементит `completed` или `failed` (+ пушит в `errors`), сдвигает `pending`
6. Если есть ещё — `setTimeout(processNext, delayMs)`

`filename` строится в `sanitizeFilename` (убирает `< > : " / \ | ? *` и контрольные символы, обрезает до 80 символов) + короткий id клипа для уникальности + расширение из URL (с fallback на `.mp3`).

`stopDownloads()` дополнительно вызывает `inflight.cancel()` — отменяет текущую загрузку.

`pauseDownloads()` только сбрасывает `paused = true` и чистит таймер — текущая загрузка доезжает.

`chrome.runtime.onStartup` — если в storage лежит активная очередь с pending, рестартует её (на случай, если Chrome был закрыт в середине).

### `popup.html` / `popup.js` / `popup.css`

- При открытии: `loadCaptured()` и `loadQueue()` читают из storage
- Слушает `chrome.storage.onChanged` для `capturedItems`, `downloadQueue`, `downloadSettings` — popup обновляется автоматически
- `render()`:
  1. `refreshSourceDropdown()` — собирает уникальные `source` из `currentItems`, сортирует `[feed, unified, other, ...dynamic]`, добавляет счётчики в лейблы
  2. `visibleItems()` — применяет фильтр (source + search) и сортировку
  3. Перерисовывает список
- `renderBulk()`:
  - Считает `countDownloadable()` по выбранным audio/video
  - Переключает кнопки Download / Pause / Resume / Stop
  - Обновляет прогресс-бар и текст
  - Показывает раскрывающийся список ошибок
- Цвета чипов:
  - `feed` (фиолетовый), `unified` (зелёный), `other` (серый) — фиксированные CSS-классы
  - Динамические (названия лент) — `sourceColor(name)` детерминированно хеширует имя в HSL, цвет ставится inline-стилем. Один и тот же `feed_title` всегда даёт один и тот же цвет, глаза быстро привыкают

## Permissions — что и зачем

| Permission | Зачем |
|---|---|
| `storage` | `chrome.storage.local` для captured items, queue, settings |
| `downloads` | `chrome.downloads.download` для bulk-скачивания |
| `host_permissions: suno.com/*` и т.д. | Чтобы content scripts могли инжектиться на нужных доменах (manifest их требует даже если content script матчит по URL) |
| `host_permissions: studio-api-prod.suno.com/*` | На случай если Suno поменяет домен фронта обратно — content scripts сами по этому домену не нужны (они на suno.com), но host permission не помешает |

## Edge cases и ограничения

- **Service worker может быть выгружен** между загрузками. При `delayMs < 30s` это маловероятно (текущая загрузка держит SW живым), но при больших задержках очередь может зависнуть. На `onStartup` есть авто-resume.
- **Cross-origin audio URLs** (типа `cdn.suno.ai/...`). `chrome.downloads.download` шлёт запрос с cookies только если URL same-origin или cookies явно разрешены. Если Suno отдаёт подписанные URL с ограниченным сроком — всё ОК; если требует активную сессию — может вернуть 401/403. Ошибка попадёт в `errors[]`.
- **Парсер рекурсивный с эвристикой по `id`**. Если Suno поменяет структуру ответа так, что id окажется вложен глубже или будет называться иначе — клипы запишутся как raw response с плашкой `unparsed — see raw`, ничего не потеряется. Видно в popup.
- **Дедуп по `id`**: один и тот же трек из разных эндпоинтов (если у них совпадает `id`) схлопнется в одну запись, причём более свежий capture перезапишет старый. Это обычно желаемое поведение, но если пользователю важно видеть «откуда» именно был трек — теряется источник. Можно доработать до `dedup key = id + source`, но текущая логика проще.
- **MAIN world content script не имеет доступа к Chrome API кроме ограниченного набора**. У нас он только шлёт `postMessage`, так что ограничение не мешает.
- **`all_frames: true`** — на случай если Suno что-то грузит в iframe. Патч работает в каждом фрейме независимо.

## Отладка

- `chrome://extensions/` → **Service worker** (под именем расширения) — логи `background.js`, в том числе ошибки нормализации и очереди
- DevTools на suno.com → **Console** — должно быть два сообщения уровня Debug:
  - `[SunoFeed] content_main.js installed, watching /api/feed/v3`
  - `[SunoFeed] content_bridge.js installed`
  Если их нет — content scripts не загрузились (проверить `matches` и `host_permissions`)
- В popup: карточка с плашкой `unparsed — see raw` означает что payload сохранился, но клипы не распарсились. Можно через **Export** выгрузить JSON и посмотреть реальную структуру

## Версионирование

Каждое изменение эндпоинтов или крупной логики → bump в `manifest.json` + новый zip. Текущая версия — 1.6.0.
