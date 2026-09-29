// content_main.js — runs in the PAGE'S MAIN WORLD at document_start.
// Overrides window.fetch and XMLHttpRequest so the page's own code goes
// through our wrappers, then forwards the captured payload to the
// ISOLATED-world bridge via window.postMessage.

(() => {
  'use strict';

  const TARGET_NEEDLES = [
    'studio-api-prod.suno.com/api/feed/v3',
    'studio-api.suno.com/api/feed/v3',
    '/api/feed/v3',
    'studio-api-prod.suno.com/api/unified/feed',
    'studio-api.suno.com/api/unified/feed',
    '/api/unified/feed',
    'studio-api-prod.suno.com/api/mango/rights',
    'studio-api.suno.com/api/mango/rights',
    '/api/mango/rights',
  ];

  const isTarget = (rawUrl) => {
    if (!rawUrl) return false;
    const s = String(rawUrl);
    return TARGET_NEEDLES.some((n) => s.includes(n));
  };

  // De-dupe identical in-flight requests (same URL+init signature).
  const seen = new WeakSet();

  const post = (msg) => {
    try {
      window.postMessage(Object.assign({ __sunoFeed: true, v: 1 }, msg), '*');
    } catch (e) {
      console.debug('[SunoFeed] postMessage failed', e);
    }
  };

  const captureResponse = async (url, response) => {
    if (seen.has(response)) return;
    seen.add(response);
    try {
      const clone = response.clone();
      const contentType = clone.headers.get('content-type') || '';
      let payload;
      if (contentType.includes('application/json')) {
        try { payload = await clone.json(); }
        catch { payload = { _raw: await clone.text() }; }
      } else {
        const text = await clone.text();
        try { payload = JSON.parse(text); }
        catch { payload = { _raw: text }; }
      }
      post({ kind: 'captured', url, payload, capturedAt: Date.now() });
      // For mango endpoints, also surface the body to the page console so
      // the user can inspect the key/license shape — needed to write the
      // decryption step for the on-page Save button.
      if (typeof url === 'string' && url.includes('/api/mango/')) {
        try { console.log('[SunoFeed] mango response', url, payload); } catch (_) {}
      }
    } catch (e) {
      post({ kind: 'captured', url, payload: { _error: String(e && e.message || e) }, capturedAt: Date.now() });
    }
  };

  // Pull the bearer + device-id + browser-token out of any headers shape
  // (Headers instance, plain object, or array of [k,v] pairs). Returns null
  // if no Authorization. browser-token is Suno's anti-abuse JWT-shaped
  // token sent as a header alongside the Bearer — it's required by
  // /api/download/clip/<id> (see temp/urls.txt:3697).
  const extractAuth = (headers) => {
    if (!headers) return null;
    let authorization = null, deviceId = null, browserToken = null;
    const lower = (s) => String(s).toLowerCase();
    const pick = (k, v) => {
      const lk = lower(k);
      if (lk === 'authorization') authorization = v;
      else if (lk === 'device-id') deviceId = v;
      else if (lk === 'browser-token') browserToken = v;
    };
    if (typeof headers.get === 'function') {
      pick('authorization', headers.get('authorization') || headers.get('Authorization'));
      pick('device-id', headers.get('device-id') || headers.get('Device-Id'));
      pick('browser-token', headers.get('browser-token') || headers.get('Browser-Token'));
    } else if (Array.isArray(headers)) {
      for (const pair of headers) {
        if (!Array.isArray(pair) || pair.length < 2) continue;
        pick(pair[0], pair[1]);
      }
    } else if (typeof headers === 'object') {
      for (const k of Object.keys(headers)) pick(k, headers[k]);
    }
    return authorization ? { authorization, deviceId: deviceId || '', browserToken: browserToken || '' } : null;
  };

  const maybePostAuth = (url, headers) => {
    if (!url || typeof url !== 'string') return;
    if (!url.includes('studio-api-prod.suno.com')) return;
    const auth = extractAuth(headers);
    if (auth) post({ kind: 'auth-update', ...auth, ts: Date.now() });
  };

  // ---- fetch ----
  if (!window.__sunoFeedPatchedFetch) {
    window.__sunoFeedPatchedFetch = true;
    const originalFetch = window.fetch ? window.fetch.bind(window) : null;
    if (originalFetch) {
      window.fetch = function patchedFetch(input, init) {
        const url = typeof input === 'string'
          ? input
          : (input && input.url) || '';
        // Stash auth from any page request to studio-api (so the on-page
        // Save button can call /api/download/clip/<id>?format=m4a later).
        maybePostAuth(url, init && init.headers);
        const promise = originalFetch(input, init);
        if (isTarget(url)) {
          promise.then(
            (res) => captureResponse(url, res),
            (err) => post({
              kind: 'captured',
              url,
              payload: { _error: 'fetch-failed:' + String(err && err.message || err) },
              capturedAt: Date.now(),
            })
          );
        }
        return promise;
      };
    }
  }

  // ---- XHR ----
  if (!window.__sunoFeedPatchedXHR && window.XMLHttpRequest) {
    window.__sunoFeedPatchedXHR = true;
    const XHR = window.XMLHttpRequest;
    const origOpen = XHR.prototype.open;
    const origSend = XHR.prototype.send;

    XHR.prototype.open = function (method, url) {
      this.__sunoFeedUrl = url;
      return origOpen.apply(this, arguments);
    };

    XHR.prototype.send = function () {
      const url = this.__sunoFeedUrl;
      // Capture auth on XHR too — Suno used XHR for some calls.
      maybePostAuth(url, this.__sunoFeedHeaders);
      if (isTarget(url)) {
        this.addEventListener('loadend', function () {
          if (this.readyState !== 4) return;
          let payload;
          try { payload = JSON.parse(this.responseText); }
          catch { payload = { _raw: this.responseText }; }
          post({ kind: 'captured', url, payload, capturedAt: Date.now() });
        });
      }
      return origSend.apply(this, arguments);
    };

    const origSetRequestHeader = XHR.prototype.setRequestHeader;
    XHR.prototype.setRequestHeader = function (k, v) {
      if (k) this.__sunoFeedHeaders = this.__sunoFeedHeaders || {};
      if (k) this.__sunoFeedHeaders[k] = v;
      return origSetRequestHeader.apply(this, arguments);
    };
  }

  console.debug('[SunoFeed] content_main.js installed, watching /api/feed/v3');
})();
