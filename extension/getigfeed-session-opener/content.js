(function () {
  'use strict';

  window.addEventListener('message', function (event) {
    if (event.source !== window || !event.data) return;

    if (event.data.type === 'GETIGFEED_PING') {
      window.postMessage({ type: 'GETIGFEED_EXTENSION_READY' }, window.location.origin);
      return;
    }

    if (event.data.type !== 'GETIGFEED_OPEN_INSTAGRAM') return;

    chrome.runtime.sendMessage({
      type: 'GETIGFEED_OPEN_INSTAGRAM',
      cookies: event.data.cookies || [],
      url: event.data.url || 'https://www.instagram.com/',
      debug: event.data.debug === true,
    }, function (response) {
      if (chrome.runtime.lastError) {
        window.postMessage({
          type: 'GETIGFEED_EXTENSION_ERROR',
          error: chrome.runtime.lastError.message,
        }, window.location.origin);
        return;
      }
      if (response && response.success === false) {
        window.postMessage({
          type: 'GETIGFEED_EXTENSION_ERROR',
          error: response.error || 'Failed to set cookies.',
        }, window.location.origin);
        return;
      }
      console.log('[GetIGFeed Session Opener]', response || { success: true });
      window.postMessage({
        type: 'GETIGFEED_EXTENSION_DONE',
        result: response || { success: true },
      }, window.location.origin);
    });
  });
})();
