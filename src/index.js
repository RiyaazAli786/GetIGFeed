'use strict';

require('dotenv').config();

const app = require('./app');
const poolStore = require('./store/poolStore');
const { getBackend } = require('./store/poolBackend');
const anonyig = require('./anonyig/service');
const fastdl = require('./fastdl/service');
const igram = require('./igram/service');

const PORT = process.env.PORT || 3000;

// Warm the pool cache from its durable backend (local file or Backblaze B2)
// before accepting requests, so the first feed/admin call sees real data.
poolStore
  .init()
  .then(() => {
    // eslint-disable-next-line no-console
    console.log(`[pool] loaded from ${getBackend().describe()}`);
  })
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error('[pool] failed to load from backend:', err.message);
  });

const server = app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`GetUserFeed API listening on http://localhost:${PORT}`);
});

// Fail with a clear message instead of an unhandled 'error' stack trace when
// the port is already taken (usually a leftover server instance).
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    // eslint-disable-next-line no-console
    console.error(
      `\n✖ Port ${PORT} is already in use — another server instance is running.\n` +
        `  Stop it, or set a different PORT in .env, then restart.\n` +
        `  Windows: Get-NetTCPConnection -LocalPort ${PORT} -State Listen | ` +
        `ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }\n`
    );
    process.exit(1);
  }
  throw err;
});

// Background verification: proactively checks that signer chunks are accepted by worker hubs.
// If any signer chunk has expired, _signedPost automatically downloads a fresh chunk from
// the live site and mirrors it to Backblaze B2.
async function checkAndRefreshExpiredChunks() {
  const providers = [
    { name: 'fastdl', getClient: () => fastdl.getClient() },
    { name: 'igram', getClient: () => igram.getClient() },
    { name: 'anonyig', getClient: () => anonyig.getClient() },
  ];

  for (const { name, getClient } of providers) {
    try {
      await getClient().userInfo('instagram');
    } catch (err) {
      // Signature rejection/expiration is handled and refreshed inside _signedPost.
      // Any non-signature error (e.g. rate limit 429) is logged at debug level.
      if (err.status !== 200 && err.status !== 429 && err.status !== 404) {
        console.warn(`[${name}] background chunk check: ${err.message}`);
      }
    }
  }
}

const chunkCheckTimer = setTimeout(() => {
  checkAndRefreshExpiredChunks();
  const interval = setInterval(checkAndRefreshExpiredChunks, 2 * 60 * 60 * 1000);
  interval.unref();
}, 5000);
chunkCheckTimer.unref();

// Graceful shutdown
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    // eslint-disable-next-line no-console
    console.log(`\n${signal} received, shutting down...`);
    clearTimeout(chunkCheckTimer);
    // The anonyig module keeps one long-lived HTTP/2 session open.
    anonyig.close();
    // Same for fastdl module.
    fastdl.close();
    igram.close();
    server.close(() => process.exit(0));
  });
}

module.exports = server;
