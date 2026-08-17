'use strict';

const path = require('path');

/**
 * anonyig module configuration.
 *
 * Kept separate from ../config/story.js (third-party story viewers hit with a
 * plain fetch) and ../config/constants.js (Instagram's private API, which needs
 * a pooled session and a proxy). This source needs neither: it talks to the
 * anonyig worker hub over HTTP/2 with a signed body.
 */

const int = (value, fallback) => {
  const parsed = parseInt(value, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
};

module.exports = {
  workerHub: process.env.ANONYIG_WORKER_HUB || 'https://api-wh.anonyig.com',
  siteOrigin: 'https://anonyig.com',

  // Per-request timeout on the worker hub.
  timeoutMs: int(process.env.ANONYIG_TIMEOUT_MS, 20000),
  // Parallel requests for the per-highlight fan-out.
  concurrency: int(process.env.ANONYIG_CONCURRENCY, 4),

  // Profile headers are cached in-process; the hub is the same rate-limited
  // third party the other story sources are, and getHighlights()/getEverything()
  // both need the header before anything else.
  userCacheTtlMs: int(process.env.ANONYIG_USER_CACHE_TTL_MS, 300000),

  // Pagination ceiling. One page is ~12 posts and costs one upstream call, so a
  // caller cannot ask for an unbounded crawl through the query string.
  defaultPages: int(process.env.ANONYIG_DEFAULT_PAGES, 1),
  maxPages: int(process.env.ANONYIG_MAX_PAGES, 10),

  // The signing chunk is anonyig's own code and carries their HMAC secret, so it
  // is downloaded at runtime rather than committed. It lives under the same
  // DATA_DIR as the pool and token stores (git-ignored locally, the mounted disk
  // on a host that has one), so all runtime state stays in one place.
  chunkPath:
    process.env.ANONYIG_CHUNK_PATH ||
    path.join(
      process.env.DATA_DIR || path.join(__dirname, '..', '..', 'data'),
      'anonyig',
      'live_link_chunk.js'
    ),

  // Tunnel the worker hub through a proxy. The hub answers `422
  // CAPTCHA_REQUIRED` to addresses it distrusts — datacenter ranges, which is
  // what any cloud host has — so a deployed instance generally needs one, and a
  // residential/mobile address is the point. Accepts "http://user:pass@host:port"
  // or the pool's "host:port:user:pass" form.
  proxy: process.env.ANONYIG_PROXY || null,
  // Or draw one per connection from the encrypted proxy pool the feed uses.
  usePoolProxy: process.env.ANONYIG_USE_POOL_PROXY === 'true',

  // Optional passthrough headers. `wh-cf-token` is the captcha token the site's
  // own page obtains after solving a Turnstile challenge; supplying one taken
  // from a browser session is an alternative to proxying, for as long as it
  // stays valid.
  whToken: process.env.ANONYIG_WH_TOKEN || undefined,
  xToken: process.env.ANONYIG_X_TOKEN || undefined,
};
