// background.js — MV3 service worker
// Captures feed responses, normalises and stores them, and runs a
// persistent bulk-download queue with a configurable per-file delay.

const STORAGE_KEY = 'capturedItems';
const QUEUE_KEY = 'downloadQueue';
const SETTINGS_KEY = 'downloadSettings';
const BADGE_COLOR_IDLE = '#6366f1';
const BADGE_COLOR_BUSY = '#10b981';

// ====== Feed parsing helpers ===========================================

// Heuristic: an object looks like a Suno clip either directly (has `id`) or
// wrapped in a playlist/feed item (`content_item` has `id`).
function looksLikeClip(x) {
  if (!x || typeof x !== 'object') return false;
  if ('id' in x) return true;
  if (x.content_item && typeof x.content_item === 'object' && 'id' in x.content_item) return true;
  return false;
}

// Unwrap a playlist/feed-style item. Returns the song-shaped object and
// preserves wrapper-level fields under underscore-prefixed keys so we don't
// lose information.
function unwrapItem(item) {
  if (item && item.content_item && typeof item.content_item === 'object' && 'id' in item.content_item) {
    const ci = item.content_item;
    if (item.added_at) ci._added_at = item.added_at;
    if (item.content_id) ci._content_id = item.content_id;
    return ci;
  }
  return item;
}

function findClipArrays(obj, path = '', depth = 0, sourceOverride = null) {
  if (depth > 8) return [];
  if (!obj || typeof obj !== 'object') return [];
  const out = [];

  // The current "source" is whatever feed_title the nearest ancestor (or self)
  // has declared. Falls back to whatever the caller passed down.
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

function pick(obj, keys) {
  for (const k of keys) {
    if (obj && obj[k] != null && obj[k] !== '') return obj[k];
  }
  return null;
}

function detectSource(url) {
  if (!url) return 'other';
  const s = String(url);
  if (s.includes('/api/feed/v3')) return 'feed';
  if (s.includes('/api/unified/feed')) return 'unified';
  if (s.includes('/api/feed/')) return 'feed';
  return 'other';
}

function normalizeClip(raw, sourceUrl, capturedAt, sourceOverride) {
  const id = String(
    pick(raw, ['id', 'clip_id', 'uuid', 'hash']) ||
    `${sourceUrl}#${capturedAt}#${Math.random().toString(36).slice(2, 8)}`
  );
  // Note: NOT using `display_name` as a title fallback — in the unified/feed
  // response `display_name` is the author's username, not the song title.
  const title = String(pick(raw, ['title', 'name', 'prompt']) || '(untitled)');
  const audioUrl = pick(raw, ['audio_url', 'audioUrl', 'playback_url', 'playbackUrl', 'song_path', 'stream_url', 'mp3_url']) || null;
  const videoUrl = pick(raw, ['video_url', 'videoUrl', 'video_playback_url']) || null;
  const imageUrl = pick(raw, ['image_url', 'imageUrl', 'image_large_url', 'imageLargeUrl', 'cover_url', 'coverUrl', 'image', 'avatar_image_url']) || null;
  let duration = typeof raw.duration === 'number' ? raw.duration : null;
  if (duration == null && raw.metadata && typeof raw.metadata.duration === 'number') {
    duration = raw.metadata.duration;
  }
  const createdAt = pick(raw, ['created_at', 'createdAt', 'create_time', 'created', 'updated_at', '_added_at']) || null;
  const status = pick(raw, ['status', 'state', 'playback_status']) || null;
  // major_model_version ("v5.5") is the user-facing model label; model_name
  // ("chirp-fenix") is the internal name. Prefer the user-facing one.
  const modelName = pick(raw, ['major_model_version', 'model_name', 'modelName', 'model']) || null;
  // Tags can live at root (display_tags) or inside metadata.tags.
  const tags = pick(raw, ['display_tags', 'tags', 'genre', 'style', 'metadata_tags'])
    || (raw.metadata && (raw.metadata.tags || null))
    || null;
  // Prompt can also be at root or in metadata.
  const prompt = pick(raw, ['prompt', 'gpt_description_prompt', 'prompt_text'])
    || (raw.metadata && raw.metadata.prompt)
    || null;
  const author = pick(raw, ['display_name', 'handle', 'user_id']) || null;
  const playCount = typeof raw.play_count === 'number' ? raw.play_count : null;
  const upvoteCount = typeof raw.upvote_count === 'number' ? raw.upvote_count : null;
  return {
    id, title, audioUrl, videoUrl, imageUrl, duration, createdAt, status,
    modelName, tags, prompt, author, playCount, upvoteCount,
    raw, sourceUrl, source: sourceOverride || detectSource(sourceUrl), capturedAt,
  };
}

async function readAll() {
  const got = await chrome.storage.local.get(STORAGE_KEY);
  return got[STORAGE_KEY] || [];
}

async function writeAll(items) {
  await chrome.storage.local.set({ [STORAGE_KEY]: items });
  await refreshBadge();
}

async function handleCapture({ url, payload, capturedAt }) {
  const found = findClipArrays(payload);
  let items = found.flatMap(({ array, source }) =>
    array.map((raw) => normalizeClip(unwrapItem(raw), url, capturedAt, source))
  );
  if (items.length === 0) {
    // Try to at least surface a feed_title for the raw entry
    const fallbackSource = (payload && typeof payload.feed_title === 'string' && payload.feed_title.trim())
      || detectSource(url);
    items.push({
      id: `raw-${capturedAt}-${Math.random().toString(36).slice(2, 8)}`,
      title: `Raw response — ${safePath(url)}`,
      audioUrl: null, videoUrl: null, imageUrl: null, duration: null, createdAt: null,
      status: null, modelName: null, tags: null, prompt: null,
      raw: payload, sourceUrl: url, source: fallbackSource, capturedAt,
    });
  }
  const existing = await readAll();
  const byId = new Map();
  for (const it of existing) byId.set(it.id, it);
  for (const it of items) {
    const prev = byId.get(it.id);
    if (!prev || it.capturedAt > (prev.capturedAt || 0)) byId.set(it.id, it);
  }
  await writeAll(Array.from(byId.values()));
}

function safePath(url) {
  try { return new URL(url).pathname; } catch { return url || '?'; }
}

// ====== Badge ===========================================================

async function refreshBadge() {
  const got = await chrome.storage.local.get([STORAGE_KEY, QUEUE_KEY]);
  const captured = got[STORAGE_KEY] || [];
  const q = got[QUEUE_KEY];
  let text, color;
  if (q && q.active && !q.paused) {
    const remaining = q.pending.length + (q.currentTitle ? 1 : 0);
    text = remaining > 999 ? '999+' : String(remaining);
    color = BADGE_COLOR_BUSY;
  } else {
    text = captured.length > 999 ? '999+' : String(captured.length);
    color = BADGE_COLOR_IDLE;
  }
  try {
    await chrome.action.setBadgeText({ text });
    await chrome.action.setBadgeBackgroundColor({ color });
  } catch {
    /* action may not be available in some contexts */
  }
}

// ====== Download queue =================================================

const emptyQueue = () => ({
  active: false,
  paused: false,
  pending: [],
  completed: 0,
  failed: 0,
  currentTitle: null,
  currentId: null,
  errors: [],
  startedAt: null,
  total: 0,
});

const defaultSettings = { delayMs: 1500, includeAudio: true, includeVideo: false };

async function getQueue() {
  const got = await chrome.storage.local.get([QUEUE_KEY, SETTINGS_KEY]);
  const q = got[QUEUE_KEY] || emptyQueue();
  const s = got[SETTINGS_KEY] || defaultSettings;
  return { q, s };
}

async function saveQueue(q) {
  await chrome.storage.local.set({ [QUEUE_KEY]: q });
}

function sanitizeFilename(name) {
  const base = String(name || 'untitled')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80) || 'untitled';
  return base;
}

function extFromUrl(url) {
  try {
    const u = new URL(url);
    const m = u.pathname.match(/\.(mp3|m4a|wav|ogg|aac|flac|mp4|webm|mov|mpeg)(?=$|\?)/i);
    if (m) return '.' + m[1].toLowerCase();
  } catch {}
  return '.mp3';
}

let inflight = null;       // current chrome.downloads.download promise
let nextTimer = null;      // setTimeout handle for the next download
let stopping = false;      // set when user requested stop

function clearNextTimer() {
  if (nextTimer) {
    clearTimeout(nextTimer);
    nextTimer = null;
  }
}

async function processNextDownload() {
  if (stopping) return;
  const { q, s } = await getQueue();
  if (!q.active || q.paused) return;

  if (q.pending.length === 0) {
    q.active = false;
    q.currentTitle = null;
    q.currentId = null;
    await saveQueue(q);
    await refreshBadge();
    return;
  }

  const next = q.pending[0];
  q.currentTitle = next.title;
  q.currentId = next.id;
  q.currentKind = next.kind;
  await saveQueue(q);
  await refreshBadge();

  const filename = `suno-feed/${sanitizeFilename(next.title)}_${String(next.id).slice(0, 8)}${extFromUrl(next.url)}`;

  try {
    inflight = chrome.downloads.download({
      url: next.url,
      filename,
      conflictAction: 'uniquify',
      saveAs: false,
    });
    const downloadId = await inflight;
    inflight = null;
    q.completed += 1;
  } catch (e) {
    inflight = null;
    q.failed += 1;
    const msg = String((e && e.message) || e);
    q.errors.push({ id: next.id, title: next.title, url: next.url, error: msg });
    // Stop the queue on hard errors (e.g. permission) but keep partial state
    if (/user cancelled|permission|disabled/i.test(msg)) {
      q.active = false;
    }
  }
  // Remove the processed item from pending
  q.pending.shift();
  q.currentTitle = null;
  q.currentId = null;
  q.currentKind = null;
  await saveQueue(q);
  await refreshBadge();

  if (stopping) return;
  const again = await getQueue();
  if (!again.q.active || again.q.paused) return;
  if (again.q.pending.length === 0) {
    again.q.active = false;
    await saveQueue(again.q);
    await refreshBadge();
    return;
  }
  const delay = Math.max(0, Number(again.s.delayMs) || 0);
  nextTimer = setTimeout(() => {
    nextTimer = null;
    processNextDownload();
  }, delay);
}

async function startDownloads(items, settings) {
  stopping = false;
  clearNextTimer();
  const inc = (settings && settings.includeAudio !== false);
  const vid = !!(settings && settings.includeVideo);
  const wantKinds = [];
  if (inc) wantKinds.push('audio');
  if (vid) wantKinds.push('video');
  if (wantKinds.length === 0) throw new Error('Pick at least one of audio or video');

  const queue = [];
  for (const it of items) {
    for (const k of wantKinds) {
      const url = k === 'audio' ? it.audioUrl : it.videoUrl;
      if (!url) continue;
      queue.push({ id: it.id + ':' + k, rawId: it.id, title: it.title, kind: k, url });
    }
  }
  if (queue.length === 0) throw new Error('No items with the selected media type');

  const stored = await chrome.storage.local.get([QUEUE_KEY, SETTINGS_KEY]);
  // Append to any existing queue? For v1 we replace. Keep the old errors around
  // in storage under a separate key for posterity.
  const oldErrors = stored[QUEUE_KEY] ? (stored[QUEUE_KEY].errors || []) : [];
  const newQ = {
    active: true,
    paused: false,
    pending: queue,
    completed: 0,
    failed: 0,
    currentTitle: null,
    currentId: null,
    currentKind: null,
    errors: [],
    startedAt: Date.now(),
    total: queue.length,
  };
  const newS = {
    delayMs: clampInt(settings && settings.delayMs, 0, 60000, 1500),
    includeAudio: inc,
    includeVideo: vid,
  };
  await chrome.storage.local.set({
    [QUEUE_KEY]: newQ,
    [SETTINGS_KEY]: newS,
    [QUEUE_KEY + '.archive']: { errors: oldErrors, finishedAt: stored[QUEUE_KEY] && !stored[QUEUE_KEY].active ? Date.now() : null },
  });
  await refreshBadge();
  processNextDownload();
}

function clampInt(v, min, max, fallback) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

async function stopDownloads(opts = {}) {
  const cancelInflight = opts.cancelInflight !== false;
  stopping = true;
  clearNextTimer();
  if (cancelInflight && inflight && typeof inflight.cancel === 'function') {
    try { await inflight.cancel(); } catch {}
  }
  inflight = null;
  const { q } = await getQueue();
  q.active = false;
  q.paused = false;
  q.pending = [];
  q.currentTitle = null;
  q.currentId = null;
  q.currentKind = null;
  await saveQueue(q);
  await refreshBadge();
  stopping = false;
}

async function pauseDownloads() {
  clearNextTimer();
  const { q } = await getQueue();
  if (!q.active) return;
  q.paused = true;
  q.currentTitle = null;
  q.currentId = null;
  await saveQueue(q);
  await refreshBadge();
}

async function resumeDownloads() {
  const { q } = await getQueue();
  if (!q.active || !q.paused) return;
  q.paused = false;
  await saveQueue(q);
  await refreshBadge();
  stopping = false;
  processNextDownload();
}

async function clearQueueErrors() {
  const { q } = await getQueue();
  q.errors = [];
  q.failed = 0;
  await saveQueue(q);
  await refreshBadge();
}

// ====== Message routing =================================================

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg) return false;

  if (msg.type === 'FEED_CAPTURED') {
    handleCapture(msg).then(
      () => sendResponse({ ok: true }),
      (err) => sendResponse({ ok: false, error: String((err && err.message) || err) })
    );
    return true;
  }
  if (msg.type === 'START_DOWNLOADS') {
    startDownloads(msg.items || [], msg.settings || {}).then(
      () => sendResponse({ ok: true }),
      (err) => sendResponse({ ok: false, error: String((err && err.message) || err) })
    );
    return true;
  }
  if (msg.type === 'STOP_DOWNLOADS') {
    stopDownloads().then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg.type === 'PAUSE_DOWNLOADS') {
    pauseDownloads().then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg.type === 'RESUME_DOWNLOADS') {
    resumeDownloads().then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg.type === 'CLEAR_DOWNLOAD_ERRORS') {
    clearQueueErrors().then(() => sendResponse({ ok: true }));
    return true;
  }
  return false;
});

// ====== Lifecycle ======================================================

chrome.runtime.onInstalled.addListener(async () => {
  await refreshBadge();
});

chrome.runtime.onStartup.addListener(async () => {
  await refreshBadge();
  // If a queue was running when the browser closed, attempt to resume
  const { q } = await getQueue();
  if (q.active && !q.paused && q.pending.length > 0) {
    stopping = false;
    processNextDownload();
  }
});
