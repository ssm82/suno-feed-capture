---
name: browser-extension-network-interceptor
description: Build a Chrome MV3 extension that intercepts specific network responses from a web app, parses them, stores in chrome.storage.local, and provides a popup UI. Use this when the user wants to capture, browse, export, or bulk-download data from a third-party web app's API (like Suno, Spotify, etc.) without reverse-engineering auth.
---

# Browser Extension: Network Response Interceptor (MV3)

Практический скилл по созданию Chrome-расширения, которое перехватывает конкретные API-ответы прямо в браузере пользователя и сохраняет их локально. Конкретный кейс — Suno Feed Capture, но паттерны применимы к любому «хочу достать свои данные из чужого веб-приложения».

## TL;DR — 6 критичных паттернов

1. **Content scripts в Chrome живут в ISOLATED world по умолчанию** — `window.fetch = patched` оттуда НЕ действует на код страницы. Нужен `world: "MAIN"` для override + `world: "ISOLATED"` для моста к background через `postMessage`.
2. **Перехватывай по списку needles**, а не одному regex. Полный URL + по домену + по пути. Сайты переезжают.
3. **Response body читается один раз** — клонируй до того, как отдашь оригинал странице.
4. **Парсер делай рекурсивный с эвристикой + fallback в raw**. Не угадаешь формат payload заранее.
5. **Service worker умирает** — любое долгоживущее состояние (очереди, прогресс) пиши в `chrome.storage.local` и подписывайся на `chrome.storage.onChanged` из popup.
6. **Permissions сразу все доменные пропиши** — `host_permissions` для всех возможных вариантов домена, не только для текущего.

## Архитектура (4 файла, всё что нужно)

```
extension/
├── manifest.json
├── content_main.js      # MAIN world: patch fetch/XHR
├── content_bridge.js    # ISOLATED world: postMessage → chrome.runtime.sendMessage
├── background.js        # service worker: parse, store, queue
├── popup.html/css/js    # UI
```

## Паттерн 1: MAIN + ISOLATED content scripts

### Проблема

Content scripts по умолчанию в `world: "ISOLATED"`. Это отдельный JS-контекст с общим DOM, но **своим `window`**. Если сделать `window.fetch = patched` оттуда, страница продолжает звать оригинальный fetch.

### Решение

Два content-скрипта в манифесте:

```json
"content_scripts": [
  {
    "matches": ["https://example.com/*"],
    "js": ["content_main.js"],
    "run_at": "document_start",
    "all_frames": true,
    "world": "MAIN"
  },
  {
    "matches": ["https://example.com/*"],
    "js": ["content_bridge.js"],
    "run_at": "document_start",
    "all_frames": true,
    "world": "ISOLATED"
  }
]
```

`content_main.js` патчит `window.fetch` и `XMLHttpRequest`. `content_bridge.js` слушает `postMessage` и шлёт в background.

### Код: content_main.js (MAIN world)

```js
(() => {
  'use strict';
  const TARGET = ['api.example.com/v1/feed', '/api/feed'];  // несколько needles

  const isTarget = (u) => u && TARGET.some(n => String(u).includes(n));

  const post = (msg) => {
    try { window.postMessage({ __interceptor: true, v: 1, ...msg }, '*'); }
    catch {}
  };

  // fetch override
  if (!window.__patchedFetch) {
    window.__patchedFetch = true;
    const orig = window.fetch.bind(window);
    window.fetch = function(input, init) {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      const p = orig(input, init);
      if (isTarget(url)) {
        p.then(res => {
          // КЛОНИРУЕМ — body читается один раз
          const clone = res.clone();
          clone.json().then(payload => post({ kind: 'captured', url, payload, capturedAt: Date.now() }))
            .catch(() => clone.text().then(t => post({ kind: 'captured', url, payload: { _raw: t }, capturedAt: Date.now() })));
        }, err => post({ kind: 'captured', url, payload: { _error: String(err.message || err) }, capturedAt: Date.now() }));
      }
      return p;
    };
  }

  // XHR override (на случай если сайт ещё не переехал на fetch)
  if (!window.__patchedXHR && window.XMLHttpRequest) {
    window.__patchedXHR = true;
    const XHR = window.XMLHttpRequest;
    const origOpen = XHR.prototype.open, origSend = XHR.prototype.send;
    XHR.prototype.open = function(m, url) { this.__url = url; return origOpen.apply(this, arguments); };
    XHR.prototype.send = function() {
      if (isTarget(this.__url)) {
        this.addEventListener('loadend', function() {
          if (this.readyState !== 4) return;
          let payload; try { payload = JSON.parse(this.responseText); }
          catch { payload = { _raw: this.responseText }; }
          post({ kind: 'captured', url: this.__url, payload, capturedAt: Date.now() });
        });
      }
      return origSend.apply(this, arguments);
    };
  }
})();
```

### Код: content_bridge.js (ISOLATED world)

```js
(() => {
  'use strict';
  window.addEventListener('message', (e) => {
    if (e.source !== window) return;             // только своё окно
    const d = e.data;
    if (!d || d.__interceptor !== true) return;  // наш маркер
    if (d.kind !== 'captured') return;
    try {
      chrome.runtime.sendMessage(
        { type: 'INTERCEPTED', url: d.url, payload: d.payload, capturedAt: d.capturedAt },
        () => void chrome.runtime.lastError  // глотаем invalidated context
      );
    } catch {}
  });
})();
```

## Паттерн 2: Несколько needles для устойчивости

```js
const TARGET_NEEDLES = [
  'api.example.com/v1/feed',   // полный URL
  '/v1/feed',                  // только путь — работает при смене хоста
];
```

Suno за полгода переехал с `studio.suno.com` на `suno.com` и поменял `/api/feed/v3` на `/api/unified/feed`. С тремя needles (полный URL + по домену + по пути) ты переживаешь оба переезда.

## Паттерн 3: Рекурсивный парсер с эвристикой

Не угадаешь, под каким ключом лежат клипы. `clips`, `items`, `data`, `results`, `songs`, `tracks` — все варианты. Делай рекурсивный обход с эвристикой «объект с полем `id`» + поддержку обёрток.

```js
function looksLikeClip(x) {
  if (!x || typeof x !== 'object') return false;
  if ('id' in x) return true;                                    // прямой
  if (x.content_item && 'id' in x.content_item) return true;     // обёрнутый
  return false;
}

function unwrapItem(item) {
  // Suno playlist-feed оборачивает каждую запись в { content_id, content_item: {...} }
  if (item?.content_item && 'id' in item.content_item) {
    const ci = item.content_item;
    if (item.added_at) ci._added_at = item.added_at;
    return ci;
  }
  return item;
}

function findClipArrays(obj, path = '', depth = 0, sourceOverride = null) {
  if (depth > 8 || !obj || typeof obj !== 'object') return [];
  const out = [];
  // Source context: feed_title тянется вниз по дереву
  const ownTitle = typeof obj.feed_title === 'string' ? obj.feed_title.trim() : '';
  const localSource = sourceOverride || (ownTitle || null);

  if (Array.isArray(obj)) {
    if (obj.length > 0 && obj.every(looksLikeClip)) {
      out.push({ array: obj, path, source: localSource });
    }
    return out;
  }
  for (const [k, v] of Object.entries(obj)) {
    const next = path ? `${path}.${k}` : k;
    if (Array.isArray(v) && v.length > 0 && v.every(looksLikeClip)) {
      out.push({ array: v, path: next, source: localSource });
    } else if (v && typeof v === 'object') {
      out.push(...findClipArrays(v, next, depth + 1, localSource));
    }
  }
  return out;
}
```

**Главное**: если парсер ничего не нашёл — сохрани сырой payload в `raw` поле, чтобы потом можно было подкрутить эвристику по реальным данным. Никогда не теряй.

## Паттерн 4: Динамические source labels

Когда у payload есть `feed_title` (или похожее поле), используй его как label вместо URL-based. Это превращает «свалку из API» в читаемый «Best of Pop / Chill Vibes / My Mix».

```js
// В popup.js: динамический <select> из реальных источников
function refreshSourceDropdown() {
  const counts = new Map();
  for (const it of currentItems) {
    const s = it.source || 'other';
    counts.set(s, (counts.get(s) || 0) + 1);
  }
  // Предопределённые сначала, потом динамические по частоте
  const known = ['feed', 'unified', 'other'];
  const dynamic = [...counts.keys()].filter(s => !known.includes(s))
    .sort((a, b) => (counts.get(b) - counts.get(a)) || a.localeCompare(b));
  const order = [...known.filter(s => counts.has(s)), ...dynamic];

  const current = els.source.value || 'all';
  els.source.innerHTML = '<option value="all">All sources</option>';
  for (const s of order) {
    const opt = document.createElement('option');
    opt.value = s;
    opt.textContent = `${s} (${counts.get(s)})`;
    els.source.appendChild(opt);
  }
  els.source.value = (current === 'all' || counts.has(current)) ? current : 'all';
}
```

Для цвета динамических источников — детерминированный HSL из хеша имени:

```js
function sourceColor(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = ((h * 31) + name.charCodeAt(i)) >>> 0;
  const hue = h % 360;
  return { color: `hsl(${hue}, 65%, 75%)`, border: `hsl(${hue}, 50%, 38%)`, background: `hsl(${hue}, 30%, 18%)` };
}
```

Один и тот же `feed_title` всегда даёт один и тот же цвет, глаза привыкают.

## Паттерн 5: Persistent download queue

`chrome.downloads.download` живёт в background, но service worker умирает. Состояние очереди — в `chrome.storage.local`, восстанавливается на `chrome.runtime.onStartup`.

```js
const QUEUE_KEY = 'downloadQueue';

async function processNext() {
  if (stopping) return;
  const { q } = await getQueue();
  if (!q.active || q.paused) return;
  if (q.pending.length === 0) { q.active = false; await save(q); return; }

  const next = q.pending[0];
  q.currentTitle = next.title;
  await save(q);
  try {
    await chrome.downloads.download({ url: next.url, filename: `dir/${next.title}_${next.id.slice(0,8)}.mp3`, conflictAction: 'uniquify', saveAs: false });
    q.completed++;
  } catch (e) {
    q.failed++; q.errors.push({ id: next.id, error: String(e.message) });
  }
  q.pending.shift(); q.currentTitle = null;
  await save(q);

  if (q.active && !q.paused && q.pending.length > 0) {
    setTimeout(processNext, q.delayMs || 1500);
  }
}

chrome.runtime.onStartup.addListener(async () => {
  const { q } = await getQueue();
  if (q.active && !q.paused && q.pending.length > 0) processNext();
});
```

**Важно**: `delayMs < 30s` обычно ОК (текущая загрузка держит SW живым), `> 30s` хрупко — SW может уснуть. Для длинных пауз используй `chrome.alarms` (но он минимум 1 минута).

## Паттерн 6: Storage как координационный слой

Никакой общей памяти между popup, content scripts и SW нет. Всё через `chrome.storage.local`:

```js
// background.js: пишет
await chrome.storage.local.set({ capturedItems: items, downloadQueue: q });

// popup.js: подписан
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.capturedItems) loadCaptured();
  if (changes.downloadQueue) loadQueue();
});
```

Это даёт тебе автообновление UI «бесплатно» — новые захваты появляются в popup сами, без ручного refresh.

## Пошаговый workflow

1. **Скачай архив `suno-feed-capture.zip`** как референс (или `git clone` если есть). Открой `manifest.json` и `ARCH_README.md`.
2. **Определи target URL** через DevTools → Network на сайте. Фильтруй по XHR/fetch, ищи JSON-ответы с большими данными.
3. **Скопируй файлы**: манифест, два content-скрипта, background, popup. Впиши свои TARGET_NEEDLES, host_permissions.
4. **Загрузи unpacked**: `chrome://extensions/` → Developer mode → Load unpacked → выбери папку.
5. **Проверь что патч работает**: открой DevTools на сайте, в Console должно быть `[Interceptor] content_main.js installed`.
6. **Проверь что payload доходит**: Service worker (ссылка под расширением) → Console → ищи `INTERCEPTED`.
7. **Запусти парсер на сырых данных**: в popup → Export → посмотри структуру → подкрути `looksLikeClip`/`unwrapItem` под реальные ключи.
8. **Добавь UI**: сначала минимальный список, потом фильтры, потом bulk-операции.

## Чеклист типичных граблей

- [ ] Content script в ISOLATED world и не ловит fetch → добавить `world: "MAIN"` для патча
- [ ] Response body пустой / undefined → забыл `response.clone()` перед чтением
- [ ] Парсер ничего не нашёл → сохрани `raw`, посмотри реальную структуру, обнови `looksLikeClip`
- [ ] `chrome.runtime.sendMessage` из content script молча падает → всегда добавляй `() => void chrome.runtime.lastError` в callback
- [ ] Bulk-очередь зависла на середине → проверь `chrome.runtime.onStartup` и `setTimeout` цепочку
- [ ] Popup не обновляется при новых данных → забыл подписаться на `chrome.storage.onChanged`
- [ ] Cross-origin аудио не качается → 401/403 в errors[], нужен другой URL или cookies (но `chrome.downloads.download` cookies не передаёт)
- [ ] `host_permissions` не совпадает с реальным доменом → сайт переехал, обновить `matches` и `host_permissions`

## Отладка

- `chrome://extensions/` → **Service worker** (ссылка под карточкой расширения) — все логи background.js
- DevTools на сайте → **Console** — `[Interceptor] content_main.js installed` если патч загрузился
- В popup плашка `unparsed — see raw` → клик на raw response, или `Export` → посмотри JSON
- В popup плашка `↗` рядом с заголовком → ссылка на оригинальный media URL, можно открыть в новой вкладке
- Перед изменением TARGET_NEEDLES или matches — `chrome://extensions/` → Update (или Reload)

## Не покрыто (но пригодится)

- **WebSocket перехват** — сложнее, чем fetch, и MAIN world override нужен аккуратнее (некоторые сайты переподключаются при переопределении `WebSocket`). Для Suno не понадобилось.
- **Auth replay** — если API требует куки, `chrome.downloads.download` сам их не шлёт. Можно через `chrome.cookies.get` получить и подставить в заголовки при `fetch` (но тогда background.js должен сам качать, а не `chrome.downloads`).
- **Firefox** — нужен `manifest_version: 2` и `browser.*` API, не `chrome.*`. Структура та же.
- **Tampermonkey-версия** — если расширение не нужно, тот же override `window.fetch` в MAIN world работает из userscript (но `@grant none` обязателен).
