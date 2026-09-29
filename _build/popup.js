// popup.js — renders captured items, supports search/sort, export, clear,
// and runs a bulk download queue with a configurable per-file delay.

const STORAGE_KEY = 'capturedItems';
const QUEUE_KEY = 'downloadQueue';
const SETTINGS_KEY = 'downloadSettings';

const els = {
  list: document.getElementById('list'),
  count: document.getElementById('count'),
  status: document.getElementById('status'),
  search: document.getElementById('search'),
  source: document.getElementById('source'),
  sort: document.getElementById('sort'),
  export: document.getElementById('export'),
  clear: document.getElementById('clear'),
  // bulk
  delayMs: document.getElementById('delayMs'),
  dlAudio: document.getElementById('dlAudio'),
  dlVideo: document.getElementById('dlVideo'),
  download: document.getElementById('download'),
  pause: document.getElementById('pause'),
  resume: document.getElementById('resume'),
  stop: document.getElementById('stop'),
  dlCount: document.getElementById('dlCount'),
  progress: document.getElementById('progress'),
  progressFill: document.getElementById('progressFill'),
  progressText: document.getElementById('progressText'),
  errorsRow: document.getElementById('errorsRow'),
  toggleErrors: document.getElementById('toggleErrors'),
  errorCount: document.getElementById('errorCount'),
  clearErrors: document.getElementById('clearErrors'),
  errors: document.getElementById('errors'),
};

let currentItems = [];
let currentQueue = null;
let currentSettings = null;
let lastSeen = 0;
let errorsVisible = false;

// ===== Render helpers ==================================================

function fmtTime(ts) {
  if (!ts) return '';
  return new Date(ts).toLocaleString();
}

function fmtDuration(s) {
  if (typeof s !== 'number' || !isFinite(s)) return null;
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${String(sec).padStart(2, '0')}`;
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function statusClass(s) {
  if (!s) return '';
  return 'status-' + String(s).toLowerCase().replace(/[^a-z0-9-]/g, '-');
}

function visibleItems() {
  const q = (els.search.value || '').trim().toLowerCase();
  const src = els.source.value || 'all';
  let out = currentItems.slice();
  if (src !== 'all') {
    out = out.filter((it) => (it.source || 'other') === src);
  }
  if (q) {
    out = out.filter((it) => {
      const hay = [
        it.title,
        it.modelName,
        it.status,
        it.tags && (Array.isArray(it.tags) ? it.tags.join(' ') : String(it.tags)),
        it.prompt,
      ].filter(Boolean).join(' ').toLowerCase();
      return hay.includes(q);
    });
  }
  const sort = els.sort.value;
  const cmp = {
    'capturedAt-desc': (a, b) => (b.capturedAt || 0) - (a.capturedAt || 0),
    'createdAt-desc': (a, b) => {
      const ax = Date.parse(a.createdAt) || 0;
      const bx = Date.parse(b.createdAt) || 0;
      return bx - ax;
    },
    'title-asc': (a, b) => String(a.title).localeCompare(String(b.title)),
    'duration-desc': (a, b) => (b.duration || 0) - (a.duration || 0),
  }[sort] || (() => 0);
  out.sort(cmp);
  return out;
}

function render() {
  refreshSourceDropdown();
  const items = visibleItems();
  els.count.textContent = String(currentItems.length);

  if (currentItems.length === 0) {
    els.list.innerHTML = `
      <div class="empty">
        No captures yet.<br />
        Open <code>https://suno.com</code>, sign in, and scroll your feed.<br />
        Each <code>/api/feed/v3</code> response will be saved automatically.
      </div>`;
  } else if (items.length === 0) {
    els.list.innerHTML = `<div class="empty">No matches for "${escapeHtml(els.search.value)}"</div>`;
  } else {
    const frag = document.createDocumentFragment();
    for (const it of items) frag.appendChild(card(it));
    els.list.innerHTML = '';
    els.list.appendChild(frag);
  }

  renderBulk();
}

function card(it) {
  const el = document.createElement('div');
  el.className = 'card';

  const thumb = document.createElement('div');
  thumb.className = 'thumb';
  if (it.imageUrl) {
    const img = document.createElement('img');
    img.src = it.imageUrl;
    img.alt = '';
    img.referrerPolicy = 'no-referrer';
    img.loading = 'lazy';
    img.addEventListener('error', () => { thumb.innerHTML = '🎵'; });
    thumb.appendChild(img);
  } else {
    thumb.textContent = '🎵';
  }

  const info = document.createElement('div');
  info.className = 'info';

  const titleRow = document.createElement('div');
  titleRow.className = 'title-row';
  const title = document.createElement('div');
  title.className = 'title';
  title.textContent = it.title;
  title.title = it.title;
  titleRow.appendChild(title);
  const audioOrVideoUrl = it.audioUrl || it.videoUrl;
  if (audioOrVideoUrl) {
    const open = document.createElement('a');
    open.className = 'open';
    open.href = audioOrVideoUrl;
    open.target = '_blank';
    open.rel = 'noreferrer noopener';
    open.textContent = '↗';
    open.title = 'Open audio/video URL in new tab';
    titleRow.appendChild(open);
  }
  info.appendChild(titleRow);

  const meta = document.createElement('div');
  meta.className = 'meta-line';
  const dur = fmtDuration(it.duration);
  if (dur) meta.appendChild(chip(dur));
  if (it.status) meta.appendChild(chip(it.status, statusClass(it.status)));
  if (it.author) meta.appendChild(chip('by ' + it.author));
  if (it.modelName) meta.appendChild(chip(it.modelName));
  if (it.source) meta.appendChild(sourceChip(it.source));
  if (it.createdAt) meta.appendChild(chip('made ' + new Date(it.createdAt).toLocaleDateString()));
  meta.appendChild(chip('captured ' + fmtTime(it.capturedAt)));
  info.appendChild(meta);

  if (it.audioUrl) {
    const audio = document.createElement('audio');
    audio.controls = true;
    audio.preload = 'none';
    audio.src = it.audioUrl;
    info.appendChild(audio);
  } else if (it.videoUrl) {
    const v = document.createElement('video');
    v.controls = true;
    v.preload = 'none';
    v.src = it.videoUrl;
    v.style.maxHeight = '180px';
    info.appendChild(v);
  }

  if (it.id && String(it.id).startsWith('raw-')) {
    const note = document.createElement('div');
    note.className = 'meta-line';
    note.appendChild(chip('unparsed — see raw'));
    info.appendChild(note);
  }

  el.appendChild(thumb);
  el.appendChild(info);
  return el;
}

function chip(text, cls) {
  const s = document.createElement('span');
  s.className = 'chip' + (cls ? ' ' + cls : '');
  s.textContent = text;
  return s;
}

// Stable HSL color derived from the source name. Predefined sources
// (feed/unified/other) keep their CSS class colors; everything else
// gets a deterministic hash colour so the same feed title always
// renders the same.
function sourceColor(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) {
    h = ((h * 31) + name.charCodeAt(i)) >>> 0;
  }
  const hue = h % 360;
  return {
    color: `hsl(${hue}, 65%, 75%)`,
    border: `hsl(${hue}, 50%, 38%)`,
    background: `hsl(${hue}, 30%, 18%)`,
  };
}

function sourceChip(source) {
  if (source === 'feed') return chip(source, 'src-feed');
  if (source === 'unified') return chip(source, 'src-unified');
  if (source === 'other') return chip(source, 'src-other');
  const s = document.createElement('span');
  s.className = 'chip src-dynamic';
  s.textContent = source;
  const c = sourceColor(source);
  s.style.color = c.color;
  s.style.borderColor = c.border;
  s.style.background = c.background;
  return s;
}

// Rebuild the source <select> from the items we actually have.
// Keeps the previously chosen value if it's still present, else resets to 'all'.
function refreshSourceDropdown() {
  const counts = new Map();
  for (const it of currentItems) {
    const s = it.source || 'other';
    counts.set(s, (counts.get(s) || 0) + 1);
  }
  const known = ['feed', 'unified', 'other'];
  const dynamic = Array.from(counts.keys())
    .filter((s) => !known.includes(s))
    .sort((a, b) => (counts.get(b) - counts.get(a)) || a.localeCompare(b));
  const order = [...known.filter((s) => counts.has(s)), ...dynamic];

  const current = els.source.value || 'all';
  els.source.innerHTML = '';
  const allOpt = document.createElement('option');
  allOpt.value = 'all';
  allOpt.textContent = 'All sources';
  els.source.appendChild(allOpt);
  for (const s of order) {
    const opt = document.createElement('option');
    opt.value = s;
    opt.textContent = `${s} (${counts.get(s)})`;
    els.source.appendChild(opt);
  }
  if (current === 'all' || counts.has(current)) {
    els.source.value = current;
  } else {
    els.source.value = 'all';
  }
}

// ===== Bulk download rendering =========================================

function countDownloadable() {
  const inc = els.dlAudio.checked;
  const vid = els.dlVideo.checked;
  if (!inc && !vid) return 0;
  let n = 0;
  for (const it of currentItems) {
    if (inc && it.audioUrl) n++;
    if (vid && it.videoUrl) n++;
  }
  return n;
}

function renderBulk() {
  const dlCount = countDownloadable();
  els.dlCount.textContent = String(dlCount);
  const q = currentQueue;
  const active = q && q.active;
  const paused = q && q.paused;
  const remaining = q ? q.pending.length + (q.currentTitle ? 1 : 0) : 0;
  const processed = q ? q.completed + q.failed : 0;
  const total = q ? Math.max(q.total, processed + remaining) : 0;
  const errors = q ? (q.errors || []) : [];

  // Buttons
  els.download.hidden = !!active;
  els.pause.hidden = !(active && !paused);
  els.resume.hidden = !(active && paused);
  els.stop.hidden = !active;
  els.download.disabled = dlCount === 0;

  // Delay/audio/video are locked while running
  els.delayMs.disabled = !!active;
  els.dlAudio.disabled = !!active;
  els.dlVideo.disabled = !!active;

  // Progress
  if (!active && !q) {
    els.progress.hidden = true;
  } else {
    els.progress.hidden = false;
    const pct = total > 0 ? Math.min(100, Math.round((processed / total) * 100)) : 0;
    els.progressFill.style.width = pct + '%';
    let stateLabel = '';
    if (paused) stateLabel = 'paused';
    else if (q && q.currentTitle) stateLabel = `downloading “${q.currentTitle}”…`;
    else if (active) stateLabel = 'queued';
    else stateLabel = total > 0 && processed >= total ? 'done' : 'idle';
    els.progressText.innerHTML = `
      <span><b>${processed}</b> / ${total} done · <b style="color:#fca5a5">${q ? q.failed : 0}</b> failed</span>
      <span class="pct">${pct}% · ${escapeHtml(stateLabel)}</span>
    `;
    // Errors
    if (errors.length > 0) {
      els.errorsRow.hidden = false;
      els.errorCount.textContent = String(errors.length);
      if (errorsVisible) {
        els.errors.hidden = false;
        els.errors.innerHTML = '';
        for (const e of errors) {
          const li = document.createElement('li');
          li.innerHTML = `<span class="err-title">${escapeHtml(e.title)}</span> — ${escapeHtml(e.error || '')}`;
          els.errors.appendChild(li);
        }
      } else {
        els.errors.hidden = true;
      }
    } else {
      els.errorsRow.hidden = true;
      els.errors.hidden = true;
    }
  }
}

// ===== Storage / state ================================================

async function loadCaptured() {
  const got = await chrome.storage.local.get(STORAGE_KEY);
  const items = got[STORAGE_KEY] || [];
  const wasEmpty = currentItems.length === 0;
  currentItems = items;
  render();
  if (!wasEmpty && items.length > lastSeen) flashStatus(`+${items.length - lastSeen} new`);
  lastSeen = items.length;
}

async function loadQueue() {
  const got = await chrome.storage.local.get([QUEUE_KEY, SETTINGS_KEY]);
  currentQueue = got[QUEUE_KEY] || null;
  currentSettings = got[SETTINGS_KEY] || null;
  if (currentSettings) {
    if (typeof currentSettings.delayMs === 'number') els.delayMs.value = currentSettings.delayMs;
    if (typeof currentSettings.includeAudio === 'boolean') els.dlAudio.checked = currentSettings.includeAudio;
    if (typeof currentSettings.includeVideo === 'boolean') els.dlVideo.checked = currentSettings.includeVideo;
  }
  renderBulk();
}

function flashStatus(text) {
  els.status.textContent = text;
  clearTimeout(flashStatus._t);
  flashStatus._t = setTimeout(() => (els.status.textContent = ''), 2000);
}

function send(type, payload) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(Object.assign({ type }, payload || {}), (resp) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message });
      } else {
        resolve(resp || { ok: true });
      }
    });
  });
}

// ===== Event wiring ===================================================

els.export.addEventListener('click', async () => {
  const got = await chrome.storage.local.get(STORAGE_KEY);
  const data = got[STORAGE_KEY] || [];
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `suno-feed-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

els.clear.addEventListener('click', async () => {
  if (currentItems.length === 0) return;
  if (!confirm(`Clear all ${currentItems.length} captured items? This cannot be undone.`)) return;
  await chrome.storage.local.set({ [STORAGE_KEY]: [] });
  currentItems = [];
  lastSeen = 0;
  render();
  flashStatus('cleared');
});

els.search.addEventListener('input', render);
els.source.addEventListener('change', render);
els.sort.addEventListener('change', render);

els.dlAudio.addEventListener('change', persistSettingsAndRefresh);
els.dlVideo.addEventListener('change', persistSettingsAndRefresh);
els.delayMs.addEventListener('change', persistSettingsAndRefresh);
els.delayMs.addEventListener('input', () => {
  // Re-render only the count + disabled state, no need to persist on every keystroke
  renderBulk();
});

async function persistSettingsAndRefresh() {
  await chrome.storage.local.set({
    [SETTINGS_KEY]: {
      delayMs: clampInt(els.delayMs.value, 0, 60000, 1500),
      includeAudio: els.dlAudio.checked,
      includeVideo: els.dlVideo.checked,
    },
  });
  renderBulk();
}

function clampInt(v, min, max, fallback) {
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

els.download.addEventListener('click', async () => {
  const settings = {
    delayMs: clampInt(els.delayMs.value, 0, 60000, 1500),
    includeAudio: els.dlAudio.checked,
    includeVideo: els.dlVideo.checked,
  };
  if (!settings.includeAudio && !settings.includeVideo) {
    flashStatus('pick audio or video');
    return;
  }
  if (countDownloadable() === 0) {
    flashStatus('nothing to download');
    return;
  }
  const resp = await send('START_DOWNLOADS', { items: currentItems, settings });
  if (!resp || !resp.ok) {
    flashStatus('error: ' + (resp && resp.error || 'unknown'));
  }
});

els.stop.addEventListener('click', async () => {
  await send('STOP_DOWNLOADS');
  flashStatus('stopped');
});

els.pause.addEventListener('click', async () => {
  await send('PAUSE_DOWNLOADS');
  flashStatus('paused');
});

els.resume.addEventListener('click', async () => {
  await send('RESUME_DOWNLOADS');
  flashStatus('resumed');
});

els.toggleErrors.addEventListener('click', () => {
  errorsVisible = !errorsVisible;
  renderBulk();
});

els.clearErrors.addEventListener('click', async () => {
  await send('CLEAR_DOWNLOAD_ERRORS');
  errorsVisible = false;
  renderBulk();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes[STORAGE_KEY]) {
    loadCaptured();
  }
  if (changes[QUEUE_KEY] || changes[SETTINGS_KEY]) {
    loadQueue();
  }
});

// Initial load
loadCaptured();
loadQueue();
