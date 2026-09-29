// content_bridge.js — runs in the ISOLATED world at document_start.
// Listens for postMessage events from the MAIN-world interceptor and
// forwards feed captures to the service worker. Also keeps the most
// recent Suno auth headers (Authorization + device-id) in a window
// global so the on-page Save button can call
// studio-api-prod.suno.com/api/download/clip/<id>?format=m4a with the
// same bearer token the page is using.

(() => {
  'use strict';

  const AUTH_FRESH_MS = 30 * 60 * 1000; // 30 minutes

  const forward = (msg) => {
    try {
      chrome.runtime.sendMessage(
        Object.assign({ type: 'FEED_CAPTURED' }, msg),
        () => void chrome.runtime.lastError
      );
    } catch (e) {
      console.debug('[SunoFeed] sendMessage failed', e);
    }
  };

  const setAuth = (data) => {
    window.__sunoLatestAuth = {
      authorization: data.authorization,
      deviceId: data.deviceId || '',
      browserToken: data.browserToken || '',
      ts: data.ts || Date.now(),
    };
  };

  const getAuth = () => {
    const a = window.__sunoLatestAuth;
    if (!a) return null;
    if (Date.now() - a.ts > AUTH_FRESH_MS) return null;
    return a;
  };

  // Expose a tiny getter for other isolated-world content scripts
  // (content_page_buttons.js) that run after this one in the same world.
  window.__sunoGetAuth = getAuth;

  window.addEventListener('message', (event) => {
    if (event.source !== window) return; // only same-window
    const data = event.data;
    if (!data || data.__sunoFeed !== true || data.v !== 1) return;
    if (data.kind === 'auth-update') {
      setAuth(data);
      return;
    }
    if (data.kind !== 'captured') return;
    forward({
      url: data.url,
      payload: data.payload,
      capturedAt: data.capturedAt,
    });
  });

  console.debug('[SunoFeed] content_bridge.js installed');
})();
