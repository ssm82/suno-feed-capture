// content_page_buttons.js — runs in the ISOLATED world at document_idle.
// Scans Suno's UI for song cards (links to /song/<uuid>) and injects a small
// "Save" button next to each one. Clicking the button fetches the actual
// (decrypted) audio bytes from Suno's own download endpoint
// (studio-api-prod.suno.com/api/download/clip/<id>?format=m4a) using the
// bearer token that content_main.js has been capturing from the page's
// outgoing fetches, then hands the blob to chrome.downloads.download.
//
// Note: the CDN URL pattern (d2lwuy8qc234o3.cloudfront.net/1/clip/<uuid>.m4a)
// used to be the right answer, but Suno now serves *encrypted* bytes from
// CloudFront and decrypts them in their custom "mango" player. So we have
// to go through Suno's API to get a usable file.

(() => {
  'use strict';

  const STORAGE_KEY = 'capturedItems';
  const SONG_HREF_RE = /\/song\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;
  const BUTTON_CLASS = '__suno_feed_save_btn__';
  const SCAN_THROTTLE_MS = 400;

  // Map<clipId, Set<HTMLButtonElement>> — tracks every button we've rendered
  // for a given clip so we don't attach twice.
  const buttonsByClip = new Map();
  let scanScheduled = false;
  let observer = null;
  let titleByClip = new Map();

  // ---- Shadow DOM button factory ---------------------------------------

  const BUTTON_HOST_HTML = `
    <style>
      :host { all: initial; }
      .wrap {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        font: 600 11px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", "Inter", Roboto, sans-serif;
        color: #e6e9f5;
        background: linear-gradient(135deg, rgba(99,102,241,0.95), rgba(139,92,246,0.95));
        border: 1px solid rgba(255,255,255,0.12);
        border-radius: 999px;
        padding: 5px 10px;
        cursor: pointer;
        user-select: none;
        box-shadow: 0 1px 4px rgba(0,0,0,0.4);
        transition: opacity 0.15s, transform 0.1s;
      }
      .wrap:hover { opacity: 0.9; }
      .wrap:active { transform: scale(0.97); }
      .wrap[data-state="saved"] {
        background: rgba(16,185,129,0.95);
      }
      .wrap[data-busy="1"] { opacity: 0.6; pointer-events: none; }
      .ico { font-size: 11px; line-height: 1; }
    </style>
    <span class="wrap" role="button" tabindex="0" title="Save this clip locally">
      <span class="ico">⬇</span><span class="lbl">Save</span>
    </span>
  `;

  // Global stylesheet: keep the Save button above every Suno overlay.
  // We inject one <style> element into <head> that targets our host by
  // class, so it wins against any sibling CSS that might try to clip or
  // mask it. We also re-anchor to <body> via position:fixed when the
  // card itself clips us (overflow:hidden), by lifting the host out of
  // the clipping ancestor with negative z-index stacking-context tricks.
  function ensureGlobalButtonStyles() {
    if (document.getElementById('__suno_feed_btn_css')) return;
    const s = document.createElement('style');
    s.id = '__suno_feed_btn_css';
    s.textContent = `
      .${BUTTON_CLASS}__host {
        z-index: 2147483647 !important;
        pointer-events: auto !important;
        position: absolute !important;
      }
      .${BUTTON_CLASS}__host * {
        pointer-events: auto !important;
      }
    `;
    (document.head || document.documentElement).appendChild(s);
  }

  function makeButton(clipId) {
    const host = document.createElement('span');
    host.className = BUTTON_CLASS;
    host.dataset.clipId = clipId;
    host.dataset.downloadUrl = `https://d2lwuy8qc234o3.cloudfront.net/1/clip/${clipId}.m4a`;
    host.style.cssText = 'display:inline-block;margin-left:6px;vertical-align:middle;';
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = BUTTON_HOST_HTML;
    const wrap = shadow.querySelector('.wrap');
    const lbl = shadow.querySelector('.lbl');

    const onClick = async (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      if (wrap.dataset.busy === '1') return;
      wrap.dataset.busy = '1';
      const prevLabel = lbl.textContent;
      const title = titleByClip.get(clipId);
      const filename = `suno-feed/${sanitizeFilename(title || 'clip')}_${clipId.slice(0, 8)}.m4a`;
      lbl.textContent = 'Saving…';
      try {
        const result = await downloadClipViaApi(clipId, filename);
        if (result.ok) {
          wrap.dataset.state = 'saved';
          lbl.textContent = 'Saved';
          setTimeout(() => {
            if (wrap.dataset.state === 'saved') {
              wrap.dataset.state = '';
              lbl.textContent = prevLabel;
            }
            wrap.dataset.busy = '';
          }, 1800);
        } else {
          lbl.textContent = result.label || 'Error';
          console.debug('[SunoFeed] download failed', result);
          setTimeout(() => { lbl.textContent = prevLabel; wrap.dataset.busy = ''; }, 2400);
        }
      } catch (e) {
        lbl.textContent = 'Error';
        console.debug('[SunoFeed] download error', e);
        setTimeout(() => { lbl.textContent = prevLabel; wrap.dataset.busy = ''; }, 2400);
      }
    };
    wrap.addEventListener('click', onClick);
    wrap.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') onClick(e);
    });
    return host;
  }

  // ---- Download helpers ------------------------------------------------

  function sanitizeFilename(name) {
    const base = String(name || 'untitled')
      .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 80) || 'untitled';
    return base;
  }

  // Fetch the decrypted audio bytes for a clip via Suno's own download
  // endpoint and save them through chrome.downloads.download. Requires
  // the page's bearer token (captured by content_main.js and exposed via
  // window.__sunoGetAuth() set up by content_bridge.js). The endpoint is
  // GET studio-api-prod.suno.com/api/download/clip/<id>?format=m4a.
  async function downloadClipViaApi(clipId, filename) {
    // Legacy direct-download endpoint — kept as a last-resort fallback for
    // users who somehow have an already-decrypted stream at the API. The
    // normal path is decryptViaMango() below.
    return decryptViaMango(clipId, filename);
  }

  // Reverse-engineered from suno.com JS chunks
  // (`_next/static/immutable/chunks/1r54r3aq4-jfn.js`):
  //
  //   Layer 1 — AES-GCM unwrap of the per-clip wrapped key/iv (Suno's
  //   "mango" rights response). The unwrap key is derived from the page's
  //   own Clerk session token: SHA-256(bearer_jwt_as_utf8) is imported as
  //   an AES-256-GCM key. The wrapped key and iv are base64-encoded blobs
  //   shaped `[12-byte nonce] [ciphertext] [16-byte tag]`; the additional
  //   data fed into GCM is the contentId string.
  //
  //     userKey   = importKey(SHA-256(bearer_jwt), 'AES-GCM')
  //     aesCtrKey = AES-GCM-decrypt(userKey, nonce = wrappedKey[0:12],
  //                                 additionalData = contentId,
  //                                 ciphertext = wrappedKey[12:])
  //     aesCtrIv  = same, on wrappedIv
  //
  //   Layer 2 — AES-CTR stream decryption of the CloudFront file.
  //   The counter base is the first 16 bytes of `aesCtrIv`; with
  //   `length: 128` WebCrypto increments the counter by 1 per 16-byte
  //   block automatically.
  //
  //     plaintext = AES-CTR-decrypt(aesCtrKey, ciphertext, counter=aesCtrIv[:16])
  async function decryptViaMango(clipId, filename) {
    const getAuth = window.__sunoGetAuth;
    if (typeof getAuth !== 'function') {
      return { ok: false, label: 'No bridge', error: 'auth bridge missing' };
    }
    const auth = getAuth();
    if (!auth || !auth.authorization) {
      return { ok: false, label: 'No auth', error: 'no Bearer token captured — scroll the feed first' };
    }
    if (!window.crypto || !window.crypto.subtle) {
      return { ok: false, label: 'No WebCrypto', error: 'crypto.subtle unavailable' };
    }

    const bearer = String(auth.authorization).replace(/^Bearer\s+/i, '');

    // Step 1: POST /api/mango/rights
    const rightsUrl = 'https://studio-api-prod.suno.com/api/mango/rights';
    const rightsHeaders = {
      accept: 'application/json',
      'content-type': 'application/json',
      authorization: auth.authorization,
      'device-id': auth.deviceId || '',
    };
    if (auth.browserToken) rightsHeaders['browser-token'] = auth.browserToken;
    let rightsResp;
    try {
      rightsResp = await fetch(rightsUrl, {
        method: 'POST',
        headers: rightsHeaders,
        credentials: 'include',
        body: JSON.stringify({
          content_params: { content_id: clipId, content_type: 'clip' },
        }),
      });
    } catch (e) {
      return { ok: false, label: 'Rights net', error: String(e && e.message || e) };
    }
    if (!rightsResp.ok) {
      let body = '';
      try { body = await rightsResp.text(); } catch (_) {}
      return { ok: false, label: 'Rights ' + rightsResp.status, error: body.slice(0, 200) };
    }
    let rights;
    try { rights = await rightsResp.json(); }
    catch (e) {
      return { ok: false, label: 'Rights JSON', error: String(e && e.message || e) };
    }
    if (!rights || !rights.key || !rights.iv) {
      return {
        ok: false,
        label: 'No key/iv',
        error: 'rights response missing key/iv: ' + JSON.stringify(rights).slice(0, 200),
      };
    }

    // Step 2: derive the per-user AES-GCM unwrap key from the Bearer JWT.
    let userKey;
    try {
      const bearerHash = new Uint8Array(
        await crypto.subtle.digest('SHA-256', new TextEncoder().encode(bearer))
      );
      userKey = await crypto.subtle.importKey(
        'raw', bearerHash, { name: 'AES-GCM' }, false, ['decrypt']
      );
    } catch (e) {
      return { ok: false, label: 'UserKey', error: String(e && e.message || e) };
    }

    // Step 3: AES-GCM-unwrap the per-clip AES-CTR key and counter base.
    let aesCtrKey, aesCtrIv;
    try {
      const wrappedKey = base64ToBytes(rights.key);
      const wrappedIv = base64ToBytes(rights.iv);
      if (wrappedKey.length < 28 || wrappedIv.length < 28) {
        return {
          ok: false,
          label: 'Sizes',
          error: 'wrapped key/iv too small: key=' + wrappedKey.length + ' iv=' + wrappedIv.length,
        };
      }
      const aad = new TextEncoder().encode(clipId);
      aesCtrKey = new Uint8Array(await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: wrappedKey.slice(0, 12), additionalData: aad },
        userKey,
        wrappedKey.slice(12)
      ));
      aesCtrIv = new Uint8Array(await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: wrappedIv.slice(0, 12), additionalData: aad },
        userKey,
        wrappedIv.slice(12)
      ));
    } catch (e) {
      return { ok: false, label: 'Unwrap', error: String(e && e.message || e) };
    }
    if (aesCtrKey.length < 16 || aesCtrIv.length < 16) {
      return {
        ok: false,
        label: 'Unwrap size',
        error: 'unwrapped key=' + aesCtrKey.length + ' iv=' + aesCtrIv.length,
      };
    }
    try {
      console.debug('[SunoFeed] unwrapped', {
        keyLen: aesCtrKey.length,
        ivLen: aesCtrIv.length,
      });
    } catch (_) {}

    // Step 4: GET the CloudFront encrypted stream. CloudFront replies
    // `Access-Control-Allow-Origin: *`, which forbids credentials, so we
    // use `credentials: 'omit'`. The bytes are public anyway.
    const cdnUrl = `https://d2lwuy8qc234o3.cloudfront.net/1/clip/${encodeURIComponent(clipId)}.m4a`;
    let cdnResp;
    try {
      cdnResp = await fetch(cdnUrl, { credentials: 'omit', cache: 'no-store' });
    } catch (e) {
      return { ok: false, label: 'CDN net', error: String(e && e.message || e) };
    }
    if (!cdnResp.ok) {
      return { ok: false, label: 'CDN ' + cdnResp.status, error: 'cloudfront returned ' + cdnResp.status };
    }
    let ciphertext;
    try {
      ciphertext = new Uint8Array(await cdnResp.arrayBuffer());
    } catch (e) {
      return { ok: false, label: 'CDN read', error: String(e && e.message || e) };
    }
    if (ciphertext.length === 0) {
      return { ok: false, label: 'Empty CDN', error: 'cloudfront returned no bytes' };
    }

    // Step 5: AES-CTR-decrypt the whole stream. With `length: 128` WebCrypto
    // increments the 16-byte counter by 1 per 16-byte block automatically.
    let plain;
    try {
      const ctrKey = await crypto.subtle.importKey(
        'raw', aesCtrKey.slice(0, 32), { name: 'AES-CTR' }, false, ['decrypt']
      );
      plain = new Uint8Array(await crypto.subtle.decrypt(
        { name: 'AES-CTR', counter: aesCtrIv.slice(0, 16), length: 128 },
        ctrKey,
        ciphertext
      ));
    } catch (e) {
      return { ok: false, label: 'CTR', error: String(e && e.message || e) };
    }
    if (plain.length < 12 ||
        plain[4] !== 0x66 || plain[5] !== 0x74 ||
        plain[6] !== 0x79 || plain[7] !== 0x70) {
      return {
        ok: false,
        label: 'Bad ftyp',
        error: 'decryption produced non-m4a (head=' + bytesToHex(plain.slice(0, 16)) + ')',
      };
    }

    // Step 6: save. Content scripts can't use chrome.downloads, so we
    // synthesize a click on a hidden <a download> link — the browser
    // handles the save via its own download UI/manager.
    let blobUrl = null;
    try {
      const blob = new Blob([plain], { type: 'audio/mp4' });
      blobUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = blobUrl;
      a.download = filename;
      a.rel = 'noopener';
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      // Detach immediately so the click handler finishes; the blob URL is
      // valid until revoked.
      setTimeout(() => {
        try { a.remove(); } catch (_) {}
        if (blobUrl) URL.revokeObjectURL(blobUrl);
      }, 30_000);
    } catch (e) {
      if (blobUrl) URL.revokeObjectURL(blobUrl);
      return { ok: false, label: 'Dl err', error: String(e && e.message || e) };
    }
    return { ok: true };
  }

  function base64ToBytes(b64) {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function bytesToHex(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i++) {
      s += (bytes[i] < 16 ? '0' : '') + bytes[i].toString(16);
    }
    return s;
  }

  // ---- Card discovery --------------------------------------------------

  // The song title in Suno's card lives in a row with the class
  //   "flex items-center gap-2 min-w-0"
  // — flex layout, centered children, with `min-w-0` so the title can
  // ellipsize. Append the Save button as the last flex child of that row
  // so it sits naturally next to the title (no absolute positioning, no
  // z-index fights with hover overlays).
  function findInjectionTarget(anchor) {
    if (!anchor) return null;
    if (anchor.querySelector && anchor.querySelector('.' + BUTTON_CLASS)) return null;
    const titleRow = anchor.closest('.flex.items-center.gap-2.min-w-0');
    if (titleRow) return titleRow;
    // Fallback: walk up to the nearest block container.
    let n = anchor.parentElement;
    for (let i = 0; i < 6 && n; i++) {
      const tag = n.tagName;
      if (tag === 'DIV' || tag === 'SECTION' || tag === 'ARTICLE' || tag === 'LI' || tag === 'MAIN') {
        const cs = window.getComputedStyle(n);
        if (cs.position === 'static') n.style.position = 'relative';
        return n;
      }
      n = n.parentElement;
    }
    return null;
  }

  function attachButtonToAnchor(anchor, clipId) {
    const btn = makeButton(clipId);
    const target = findInjectionTarget(anchor);
    if (!target) {
      if (anchor.parentNode) anchor.parentNode.insertBefore(btn, anchor.nextSibling);
      else return null;
    } else {
      const isFlexTitleRow = target.classList.contains('flex') &&
                             target.classList.contains('items-center');
      if (isFlexTitleRow) {
        // In flex layout we don't need absolute positioning — let flex
        // handle placement. `flex-shrink: 0` keeps the button at full
        // size when the title truncates.
        btn.style.position = 'static';
        btn.style.zIndex = '';
        btn.style.display = 'inline-flex';
        btn.style.flexShrink = '0';
        btn.style.marginLeft = '0';
      } else {
        btn.style.position = 'absolute';
        btn.style.bottom = '8px';
        btn.style.right = '8px';
        btn.style.zIndex = '2147483647';
        btn.style.pointerEvents = 'auto';
        btn.classList.add(BUTTON_CLASS + '__host');
      }
      target.appendChild(btn);
    }
    let set = buttonsByClip.get(clipId);
    if (!set) { set = new Set(); buttonsByClip.set(clipId, set); }
    set.add(btn);
    return btn;
  }

  // ---- Card discovery --------------------------------------------------

  // Suno renders the song list through a virtualized scroller: cards that
  // leave the viewport get unmounted from the DOM. The Save button is a
  // child of each card's title row, so it disappears with the card.
  //
  // Previous scan() blindly trusted the buttonsByClip Map and skipped
  // re-attaching when the Map said "already have one", so buttons on
  // cards that scrolled off and back on never came back.
  //
  // New design:
  //   * scan() prunes dead refs (btn.isConnected === false) from the Map,
  //     then discovers anchors that don't yet have a live button and
  //     hands them to an IntersectionObserver.
  //   * The IntersectionObserver attaches the button when the anchor
  //     enters (or is already in) the viewport, then unobserves it — a
  //     one-shot attach per anchor.
  //   * scheduleScan runs via requestIdleCallback so the
  //     querySelectorAll doesn't fight the rendering pipeline (the prior
  //     "Forced reflow" violation came from running this during a
  //     MutationObserver callback on a hot virtualizer).
  let visibilityObserver = null;
  function ensureVisibilityObserver() {
    if (visibilityObserver) return visibilityObserver;
    visibilityObserver = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        const anchor = entry.target;
        visibilityObserver.unobserve(anchor);
        if (!entry.isIntersecting) continue;
        if (!anchor.isConnected) continue;
        const m = anchor.getAttribute('href').match(SONG_HREF_RE);
        if (!m) continue;
        attachButtonToAnchor(anchor, m[1]);
      }
    }, { rootMargin: '100px 0px', threshold: 0.01 });
    return visibilityObserver;
  }

  function scan() {
    scanScheduled = false;
    // 1) Prune: drop tracked buttons whose DOM nodes have been unmounted
    //    by the virtualizer. Without this step, scan() would skip
    //    re-attaching because the Map still has an entry for that clip.
    let pruned = 0;
    for (const [clipId, set] of Array.from(buttonsByClip.entries())) {
      for (const btn of Array.from(set)) {
        if (!btn.isConnected) {
          set.delete(btn);
          pruned++;
        }
      }
      if (set.size === 0) buttonsByClip.delete(clipId);
    }
    // 2) Discover anchors that don't yet have a live button, and observe
    //    them. IO callback attaches the button when the anchor is (or
    //    becomes) visible.
    const anchors = document.querySelectorAll('a[href*="/song/"]');
    const io = ensureVisibilityObserver();
    let observed = 0;
    for (const a of anchors) {
      const m = a.getAttribute('href').match(SONG_HREF_RE);
      if (!m) continue;
      const clipId = m[1];
      const existing = buttonsByClip.get(clipId);
      if (existing) {
        let live = false;
        for (const b of existing) {
          if (b.isConnected) { live = true; break; }
        }
        if (live) continue; // already attached and still in the DOM
      }
      io.observe(a);
      observed++;
    }
    if (pruned > 0 || observed > 0) {
      console.debug('[SunoFeed] scan', { pruned, observed, total: anchors.length });
    }
  }

  function scheduleScan() {
    if (scanScheduled) return;
    scanScheduled = true;
    // requestIdleCallback avoids the "Forced reflow while executing
    // JavaScript" violation by deferring querySelectorAll until the
    // main thread is idle (with a hard timeout fallback for browsers
    // without rIC, and for cases where rIC never fires during a busy
    // scroll).
    if (typeof window.requestIdleCallback === 'function') {
      window.requestIdleCallback(() => scan(), { timeout: 1000 });
    } else {
      setTimeout(scan, SCAN_THROTTLE_MS);
    }
  }

  // ---- Storage sync ---------------------------------------------------

  async function loadCapturedTitles() {
    try {
      const got = await chrome.storage.local.get(STORAGE_KEY);
      const items = got[STORAGE_KEY] || [];
      titleByClip = new Map();
      for (const it of items) {
        if (it && it.id && it.title) titleByClip.set(it.id, it.title);
      }
    } catch (e) {
      console.debug('[SunoFeed] storage read failed', e);
    }
  }

  if (chrome.storage && chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      if (changes[STORAGE_KEY]) {
        loadCapturedTitles();
        scheduleScan();
      }
    });
  }

  // ---- Bulk download runner -------------------------------------------

  // Walk the queue passed from the background, fetch each clip via the API,
  // hand the blob to chrome.downloads.download, and report progress back.
  //
  // Single delivery path: chrome.runtime.onMessage fires only in the
  // targeted Suno tab, so there is no cross-tab duplication.
  //
  // We also do a one-time chrome.storage.local.get() at startup as a
  // fallback for the narrow race where the content script loads AFTER
  // background wrote the pending-bulk key (background fires sendMessage
  // at startDownloads time; if the listener isn't registered yet, the
  // message is lost — the startup get catches that case).
  //
  // NB: a chrome.storage.onChanged watcher was previously the fallback
  // here. It was removed because storage.onChanged fires globally in
  // EVERY extension context that has a listener — meaning every open
  // Suno tab would independently run BULK_DOWNLOAD_RUN, producing a
  // duplicate download per tab (dedup is per-IIFE, not cross-tab).
  const PENDING_BULK_KEY = '__sunoFeedPendingBulk';
  const processedBulk = new Set();

  const runBulkSafely = (queue, settings) => {
    const sig = JSON.stringify({ queue, settings });
    if (processedBulk.has(sig)) {
      console.debug('[SunoFeed] BULK_DOWNLOAD_RUN deduped', {
        n: (queue || []).length,
        sigLen: sig.length,
      });
      return;
    }
    processedBulk.add(sig);
    console.debug('[SunoFeed] BULK_DOWNLOAD_RUN', {
      n: (queue || []).length,
      settings,
      origin: runBulkSafely._origin || 'runtime',
    });
    runBulkDownload(queue, settings);
    // Forget the signature after a minute so identical retries still fire,
    // while keeping memory bounded.
    setTimeout(() => processedBulk.delete(sig), 60_000);
  };

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || msg.type !== 'BULK_DOWNLOAD_RUN') return false;
    runBulkSafely._origin = 'runtime';
    runBulkSafely(msg.queue || [], msg.settings || {});
    sendResponse({ ok: true });
    return true;
  });

  // One-time startup pickup. Runs exactly once per IIFE, so no cross-tab
  // duplication. Catches the rare race where background wrote the
  // pending-bulk key before this content script's message listener was
  // registered.
  (async function startupPickupPendingBulk() {
    if (!chrome.storage || !chrome.storage.local) return;
    try {
      const got = await chrome.storage.local.get(PENDING_BULK_KEY);
      const v = got && got[PENDING_BULK_KEY];
      if (!v) {
        console.debug('[SunoFeed] bulk startup pickup: no pending key');
        return;
      }
      console.debug('[SunoFeed] bulk startup pickup: found pending bulk', {
        n: (v.queue || []).length,
      });
      runBulkSafely._origin = 'startup';
      runBulkSafely(v.queue || [], v.settings || {});
      // Clear so a subsequent reload won't replay it.
      chrome.storage.local.remove(PENDING_BULK_KEY).catch(() => {});
    } catch (e) {
      console.debug('[SunoFeed] bulk startup pickup failed', e);
    }
  })();

  async function runBulkDownload(queue, settings) {
    const tick = async (state) => {
      try {
        await chrome.runtime.sendMessage({ type: 'BULK_DOWNLOAD_TICK', ...state });
      } catch (_) { /* service worker may have reloaded; ignore */ }
    };
    const errors = [];
    let completed = 0;
    let failed = 0;
    await tick({ completed, failed, errors, currentId: null, currentTitle: null });

    for (const item of queue) {
      // kind is "audio" or "video"; we only know how to do audio via the
      // API for now. Skip video (the page's own download endpoint may also
      // produce video; for now we just leave it for the user to grab
      // through Suno's UI).
      if (item.kind !== 'audio') {
        completed++;
        await tick({ completed, failed, errors });
        continue;
      }
      const filename = `suno-feed/${sanitizeFilename(item.title || 'clip')}_${String(item.rawId || item.id).slice(0, 8)}.m4a`;
      await tick({
        currentId: item.id,
        currentTitle: item.title,
        currentKind: item.kind,
        completed,
        failed,
        errors,
      });
      const result = await downloadClipViaApi(item.rawId, filename);
      if (result.ok) {
        completed++;
      } else {
        failed++;
        errors.push({
          id: item.id,
          title: item.title,
          url: '',
          error: result.error || result.label || 'unknown',
        });
      }
      await tick({ completed, failed, errors });
      const delay = Math.max(0, Number(settings && settings.delayMs) || 0);
      if (delay > 0) await new Promise((r) => setTimeout(r, delay));
    }
    await tick({ done: true, completed, failed, errors });
  }

  // ---- Lifecycle ------------------------------------------------------

  ensureGlobalButtonStyles();
  loadCapturedTitles().then(scan);

  observer = new MutationObserver(() => scheduleScan());
  observer.observe(document.documentElement || document.body, {
    childList: true,
    subtree: true,
  });

  // SPA route changes do not reload the page; Suno re-renders the card
  // list, so a periodic catch-up is cheap insurance. We go through
  // scheduleScan so the tick is coalesced with any pending rIC — no
  // concurrent scans.
  setInterval(scheduleScan, 4000);

  console.debug('[SunoFeed] content_page_buttons.js installed');
})();
