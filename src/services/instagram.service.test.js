'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {
  getIgramFallbackHandle,
  isIgramFallbackEnabled,
  getConvertedFallbackSources,
  canUseConvertedFallback,
} = require('./instagram.service');

test('user-feed IGram fallback only accepts public handles', () => {
  assert.strictEqual(getIgramFallbackHandle('nasa'), 'nasa');
  assert.strictEqual(getIgramFallbackHandle('@nasa'), 'nasa');
  assert.strictEqual(getIgramFallbackHandle('https://www.instagram.com/nasa/'), 'nasa');
  assert.strictEqual(getIgramFallbackHandle('123456789'), null);
  assert.strictEqual(getIgramFallbackHandle('not a handle'), null);
});

test('user-feed IGram fallback honors per-request disable flag', () => {
  assert.strictEqual(isIgramFallbackEnabled({ igramFallback: false }), false);
  assert.strictEqual(isIgramFallbackEnabled({ igramFallback: 'off' }), false);
  assert.strictEqual(isIgramFallbackEnabled({ igramFallback: true }), true);
});

test('user-feed hub fallback order stays converted and deterministic', () => {
  assert.deepStrictEqual(getConvertedFallbackSources({ igramFallback: true, hubFallback: true }), [
    'igram', 'fastdl', 'anonyig',
  ]);
  assert.deepStrictEqual(getConvertedFallbackSources({ igramFallback: false, hubFallback: true }), [
    'fastdl', 'anonyig',
  ]);
  assert.strictEqual(canUseConvertedFallback('nasa', { igramFallback: false, hubFallback: true }), true);
  assert.strictEqual(canUseConvertedFallback('1234567', { igramFallback: true, hubFallback: true }), false);
});
