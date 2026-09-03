'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { hasProfileCounts } = require('./instagram.service');

test('hasProfileCounts treats 0/0 counts as incomplete', () => {
  assert.strictEqual(
    hasProfileCounts({
      follower_count: 0,
      following_count: 0,
    }),
    false
  );
});

test('hasProfileCounts accepts non-zero profile counts', () => {
  assert.strictEqual(
    hasProfileCounts({
      edge_followed_by: { count: 64 },
      edge_follow: { count: 124 },
    }),
    true
  );
});
