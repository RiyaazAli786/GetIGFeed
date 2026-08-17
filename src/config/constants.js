'use strict';

/**
 * Static values used when talking to the Instagram private API.
 * Mirrors the constants used in the original C# implementation.
 */
module.exports = {
  BASE_URL: 'https://i.instagram.com',

  USER_AGENT:
    'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/150.0.0.0 Mobile Safari/537.36',

  ACCEPT_ENCODING: 'gzip, deflate',

  X_ASBD_ID: '359341',
  X_IG_APP_ID: '936619743392459',

  // Feed pagination tuning (env-overridable)
  MAX_POSTS: parseInt(process.env.FEED_MAX_POSTS || '100', 10),
  PAGE_COUNT: parseInt(process.env.FEED_PAGE_COUNT || '12', 10),
  PAGE_DELAY_MS: parseInt(process.env.FEED_PAGE_DELAY_MS || '3000', 10),

  // Per-request timeout for outgoing Instagram/proxy calls. Without this a dead
  // proxy or stalled upstream hangs forever, and the host (e.g. Render) aborts
  // the response stream ("stream aborted"). A bounded timeout turns that into a
  // fast, clean failure instead.
  HTTP_TIMEOUT_MS: parseInt(process.env.HTTP_TIMEOUT_MS || '15000', 10),
};
