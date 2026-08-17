'use strict';

/**
 * 404 handler for unmatched routes.
 */
function notFound(req, res, next) {
  res.status(404).json({ success: false, error: 'Not found.' });
}

/**
 * Central error handler. Must keep the 4-arg signature so Express treats it
 * as an error middleware.
 *
 * Both status spellings are honoured: the feed/pool code sets `err.status`,
 * while the story/download code (merged in from GetInstaStoryHighlight) sets
 * `err.statusCode`. An aborted upstream fetch becomes a 504 rather than a 500,
 * since the failure is the third-party source timing out, not this service.
 */
// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  const isTimeout = err.name === 'AbortError' || err.name === 'TimeoutError';
  const status = err.status || err.statusCode || (isTimeout ? 504 : 500);
  const message = isTimeout
    ? 'Upstream request timed out.'
    : err.message || 'Internal server error.';

  if (isTimeout) {
    // eslint-disable-next-line no-console
    console.warn(`[timeout] ${req.method} ${req.originalUrl}`);
  } else if (status >= 500) {
    // eslint-disable-next-line no-console
    console.error('[error]', err.stack || err.message);
  }

  res.status(status).json({ success: false, error: message });
}

module.exports = { notFound, errorHandler };
