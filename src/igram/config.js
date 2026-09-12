'use strict';

const int = (value, fallback) => {
  const parsed = parseInt(value, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
};

module.exports = {
  // The worker hub captured from IGram's profile/highlight viewer. Keeping this
  // configurable makes a hub migration an environment change rather than code.
  workerHub: process.env.IGRAM_WORKER_HUB || 'https://api-wn.igram.world',
  siteOrigin: process.env.IGRAM_SITE_ORIGIN || 'https://igram.world',
  timeoutMs: int(process.env.IGRAM_TIMEOUT_MS, 20000),
  proxy: process.env.IGRAM_PROXY || null,
  usePoolProxy: process.env.IGRAM_USE_POOL_PROXY === 'true',
};
