'use strict';

/**
 * Attaches feed resolution information to Express res.locals.
 * @param {import('express').Response} res
 * @param {object} meta
 * @param {string} meta.resolvedFrom - Human-friendly source (e.g. 'Instagram Private API', 'FeedPilot Bridge', 'Cache', 'Fallback Provider (anonyig)')
 * @param {string} [meta.resolvedPath] - Concrete upstream path/URL/cacheKey
 * @param {string} [meta.authSource] - Auth source: 'session-pool' | 'inline' | 'dominatorAccount' | 'none'
 * @param {string} [meta.proxy] - Proxy host:port or IP used
 * @param {string} [meta.provider] - Provider name if fallback
 * @param {string} [meta.logFile] - Local path where the converted feed JSON was written
 * @param {string} [meta.error] - Error message if resolution failed
 * @param {object} [meta.details] - Additional key-values
 */
function setFeedResolution(res, meta = {}) {
  if (!res) return;
  if (!res.locals) res.locals = {};
  res.locals.feedResolution = {
    ...(res.locals.feedResolution || {}),
    ...meta,
  };
}

/**
 * Formats structured feed resolution metadata into a human-readable text block.
 * @param {object} feedRes
 * @returns {string}
 */
function formatFeedResolutionText(feedRes) {
  if (!feedRes || typeof feedRes !== 'object') return '';

  const lines = [];
  if (feedRes.resolvedFrom) {
    lines.push(`Feed Resolved From: ${feedRes.resolvedFrom}`);
  }
  if (feedRes.resolvedPath) {
    lines.push(`Resolution Path: ${feedRes.resolvedPath}`);
  }
  if (feedRes.provider) {
    lines.push(`Provider: ${feedRes.provider}`);
  }
  if (feedRes.failedSource) {
    lines.push(`Failed Source: ${feedRes.failedSource}`);
  }
  if (feedRes.authSource) {
    lines.push(`Auth Source: ${feedRes.authSource}`);
  }
  if (feedRes.proxy) {
    lines.push(`Proxy: ${feedRes.proxy}`);
  }
  if (feedRes.logFile) {
    lines.push(`Feed Log File: ${feedRes.logFile}`);
  }
  if (feedRes.error) {
    lines.push(`Resolution Error: ${feedRes.error}`);
  }
  if (feedRes.details && typeof feedRes.details === 'object') {
    for (const [key, value] of Object.entries(feedRes.details)) {
      if (key === 'failedSource' && feedRes.failedSource) continue;
      if (value !== undefined && value !== null) {
        lines.push(`${key}: ${typeof value === 'object' ? JSON.stringify(value) : value}`);
      }
    }
  }

  return lines.join('\n');
}

module.exports = {
  setFeedResolution,
  formatFeedResolutionText,
};
