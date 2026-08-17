'use strict';

const path = require('path');

const int = (value, fallback) => {
  const parsed = parseInt(value, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
};

module.exports = {
  workerHub: process.env.FASTDL_WORKER_HUB || 'https://api-wh.fastdl.app',
  siteOrigin: 'https://fastdl.app',

  // Per-request timeout on the worker hub.
  timeoutMs: int(process.env.FASTDL_TIMEOUT_MS || process.env.ANONYIG_TIMEOUT_MS, 20000),

  // Chunk path locally
  chunkPath:
    process.env.FASTDL_CHUNK_PATH ||
    path.join(
      process.env.DATA_DIR || path.join(__dirname, '..', '..', 'data'),
      'fastdl',
      'live_link_chunk.js'
    ),

  // Proxy settings (inheriting from anonyig defaults if not explicitly set)
  proxy: process.env.FASTDL_PROXY || process.env.ANONYIG_PROXY || null,
  usePoolProxy: process.env.FASTDL_USE_POOL_PROXY === 'true' || process.env.ANONYIG_USE_POOL_PROXY === 'true',
};
