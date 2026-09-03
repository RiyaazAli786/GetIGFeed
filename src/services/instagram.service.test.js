'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { hasProfileCounts, profileFromFeed } = require('./instagram.service');

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

test('profileFromFeed prefers the requested username over unrelated feed user', () => {
  const profile = profileFromFeed(
    { pk_id: '1962023419', username: 'sachintendulkar', follower_count: 51681492 },
    [
      { user: { pk: '1962023419', username: 'sachintendulkar' } },
      { user: { pk: '70374808999', username: 'tenxyouworld' } },
    ],
    'tenxyouworld'
  );

  assert.strictEqual(profile.username, 'tenxyouworld');
  assert.strictEqual(String(profile.pk), '70374808999');
  assert.strictEqual(profile.follower_count, undefined);
});
