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
    } catch (e) {
      post({ kind: 'captured', url, payload: { _error: String(e && e.message || e) }, capturedAt: Date.now() });
    }
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
  }

  console.debug('[SunoFeed] content_main.js installed, watching /api/feed/v3');
})();
