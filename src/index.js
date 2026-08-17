'use strict';

require('dotenv').config();

const app = require('./app');
const poolStore = require('./store/poolStore');
const { getBackend } = require('./store/poolBackend');
const anonyig = require('./anonyig/service');
const fastdl = require('./fastdl/service');

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

// Graceful shutdown
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    // eslint-disable-next-line no-console
    console.log(`\n${signal} received, shutting down...`);
    // The anonyig module keeps one long-lived HTTP/2 session open.
    anonyig.close();
    // Same for fastdl module.
    fastdl.close();
    server.close(() => process.exit(0));
  });
}

module.exports = server;
