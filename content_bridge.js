// content_bridge.js — runs in the ISOLATED world at document_start.
// Listens for postMessage events from the MAIN-world interceptor and
// forwards them to the service worker.

(() => {
  'use strict';

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

  window.addEventListener('message', (event) => {
    if (event.source !== window) return; // only same-window
    const data = event.data;
    if (!data || data.__sunoFeed !== true || data.v !== 1) return;
    if (data.kind !== 'captured') return;
    forward({
      url: data.url,
      payload: data.payload,
      capturedAt: data.capturedAt,
    });
  });

  console.debug('[SunoFeed] content_bridge.js installed');
})();
