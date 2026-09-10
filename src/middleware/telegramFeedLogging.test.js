'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { setFeedResolution, formatFeedResolutionText } = require('../utils/feedResolution');
const {
  formatTelegramMessage,
  isFeedRoute,
  shouldLogPath,
} = require('./telegramRequestLogger');

test('formatFeedResolutionText formats structured resolution fields', () => {
  const meta = {
    resolvedFrom: 'Instagram Private API',
    resolvedPath: '/api/v1/feed/user/12345/username/?count=12',
    authSource: 'pool',
    proxy: '1.2.3.4:8080',
    logFile: 'C:\\CoreProjects\\GetIGFeed\\data\\feeds\\2026-09-10_test.json',
  };

  const text = formatFeedResolutionText(meta);
  assert.ok(text.includes('Feed Resolved From: Instagram Private API'));
  assert.ok(text.includes('Resolution Path: /api/v1/feed/user/12345/username/?count=12'));
  assert.ok(text.includes('Auth Source: pool'));
  assert.ok(text.includes('Proxy: 1.2.3.4:8080'));
  assert.ok(text.includes('Feed Log File: C:\\CoreProjects\\GetIGFeed\\data\\feeds\\2026-09-10_test.json'));
});

test('formatFeedResolutionText formats fallback and provider fields', () => {
  const meta = {
    resolvedFrom: 'Fallback Provider (anonyig)',
    resolvedPath: 'https://api-wh.anonyig.com/api/v1/user/therock',
    provider: 'anonyig',
    logFile: 'data/feeds/test.json',
    details: {
      reason: 'Private Instagram feed returned 401.',
    },
  };

  const text = formatFeedResolutionText(meta);
  assert.ok(text.includes('Feed Resolved From: Fallback Provider (anonyig)'));
  assert.ok(text.includes('Resolution Path: https://api-wh.anonyig.com/api/v1/user/therock'));
  assert.ok(text.includes('Provider: anonyig'));
  assert.ok(text.includes('reason: Private Instagram feed returned 401.'));
});

test('formatTelegramMessage includes feed resolution along with existing request and response logs', () => {
  const feedResolution = {
    resolvedFrom: 'Cache (Memory)',
    resolvedPath: 'memory-cache://userFeed:123',
    proxy: 'none (in-memory cache)',
  };

  const message = formatTelegramMessage({
    statusCode: 200,
    method: 'GET',
    url: '/api/user-feed/123',
    durationMs: 42,
    feedResolution,
    requestInfo: { method: 'GET', path: '/api/user-feed/123' },
    responseBody: { success: true, count: 12 },
  });

  // Verify header and duration
  assert.ok(message.includes('GetIGFeed API 200 GET /api/user-feed/123'));
  assert.ok(message.includes('Duration: 42ms'));

  // Verify resolution path is present
  assert.ok(message.includes('Feed Resolved From: Cache (Memory)'));
  assert.ok(message.includes('Resolution Path: memory-cache://userFeed:123'));

  // Verify existing logging methods (Request and Response text blocks) are preserved
  assert.ok(message.includes('Request:'));
  assert.ok(message.includes('Response:'));
});

test('formatTelegramMessage works cleanly when feedResolution is omitted', () => {
  const message = formatTelegramMessage({
    statusCode: 200,
    method: 'POST',
    url: '/api/auth/token',
    durationMs: 15,
    requestInfo: { method: 'POST' },
    responseBody: { ok: true },
  });

  assert.ok(!message.includes('Feed Resolved From:'));
  assert.ok(message.includes('GetIGFeed API 200 POST /api/auth/token'));
  assert.ok(message.includes('Request:'));
  assert.ok(message.includes('Response:'));
});

test('isFeedRoute identifies feed endpoints', () => {
  assert.equal(isFeedRoute('/api/user-feed'), true);
  assert.equal(isFeedRoute('/api/user-feed/7425066841'), true);
  assert.equal(isFeedRoute('/admin/user-feed'), true);
  assert.equal(isFeedRoute('/admin/user-feed/therock'), true);
  assert.equal(isFeedRoute('/api/v1/feed/user/therock/username'), true);
  assert.equal(isFeedRoute('/api/auth/token'), false);
  assert.equal(isFeedRoute('/health'), false);
});

test('setFeedResolution cleanly sets and merges res.locals.feedResolution', () => {
  const res = { locals: {} };
  setFeedResolution(res, { resolvedFrom: 'Test Source' });
  setFeedResolution(res, { resolvedPath: '/test/path' });

  assert.equal(res.locals.feedResolution.resolvedFrom, 'Test Source');
  assert.equal(res.locals.feedResolution.resolvedPath, '/test/path');
});
