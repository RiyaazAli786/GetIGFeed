'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeUsername,
  orderedProviders,
  providerList,
  shouldFallbackForError,
  shouldFallbackForPrivateResult,
} = require('./feedFallback.service');

test('normalizeUsername accepts handles and Instagram profile URLs', () => {
  assert.equal(normalizeUsername('@instagram'), 'instagram');
  assert.equal(normalizeUsername('https://www.instagram.com/instagram/?hl=en'), 'instagram');
});

test('normalizeUsername rejects numeric ids because public fallbacks need handles', () => {
  assert.equal(normalizeUsername('25025320'), null);
});

test('providerList defaults to graphql, IGram, anonyig, then fastdl', () => {
  assert.deepEqual(providerList(), ['graphql', 'igram', 'anonyig', 'fastdl']);
});

test('orderedProviders keeps IGram before alternating worker fallbacks', () => {
  assert.deepEqual(orderedProviders(), ['graphql', 'igram', 'anonyig', 'fastdl']);
  assert.deepEqual(orderedProviders(), ['graphql', 'igram', 'fastdl', 'anonyig']);
});

test('orderedProviders preserves an explicitly supplied provider order', () => {
  assert.deepEqual(
    orderedProviders(['igram', 'fastdl', 'anonyig']),
    ['igram', 'fastdl', 'anonyig']
  );
});

test('shouldFallbackForPrivateResult only triggers on empty 401-like failures', () => {
  assert.equal(
    shouldFallbackForPrivateResult({
      status: 'ok',
      error: 'Request failed with status 401',
      data: { user: { edge_owner_to_timeline_media: { edges: [] } } },
    }),
    true
  );

  assert.equal(
    shouldFallbackForPrivateResult({
      status: 'ok',
      error: 'Request timed out',
      data: { user: { edge_owner_to_timeline_media: { edges: [] } } },
    }),
    false
  );

  assert.equal(
    shouldFallbackForPrivateResult({
      status: 'ok',
      error: 'Request failed with status 401',
      data: { user: { edge_owner_to_timeline_media: { edges: [{ node: { id: '1' } }] } } },
    }),
    false
  );
});

test('shouldFallbackForPrivateResult triggers on Instagram spam-block failures', () => {
  assert.equal(
    shouldFallbackForPrivateResult({
      status: 'ok',
      error: 'Instagram flagged the feed request as spam (HTTP 400).',
      data: { user: { edge_owner_to_timeline_media: { edges: [] } } },
    }),
    true
  );
});

test('shouldFallbackForError recognizes thrown 401 failures', () => {
  assert.equal(shouldFallbackForError(Object.assign(new Error('Unauthorized'), { status: 401 })), true);
  assert.equal(shouldFallbackForError(new Error('Request failed with status 401')), true);
  assert.equal(shouldFallbackForError(new Error('Request failed with status 500')), false);
});
