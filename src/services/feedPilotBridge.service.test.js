'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  bridgeMode,
  bridgeEnabled,
  fallbackEnabled,
  fetchViaFeedPilotBridge,
  sanitizeBridgeUsername,
} = require('./feedPilotBridge.service');

test('per-request bridge_then_pool override bypasses pool environment without changing it', async () => {
  const previous = { mode: process.env.FEED_SOURCE_MODE, url: process.env.FEEDPILOT_BRIDGE_URL, key: process.env.FEEDPILOT_BRIDGE_KEY };
  const originalFetch = global.fetch;
  try {
    process.env.FEED_SOURCE_MODE = 'pool';
    process.env.FEEDPILOT_BRIDGE_URL = 'http://localhost:5000';
    process.env.FEEDPILOT_BRIDGE_KEY = 'test-key';
    let calls = 0;
    global.fetch = async () => {
      calls += 1;
      return { ok: false, status: 503, json: async () => ({ code: 'NO_ACTIVE_DEVICE' }) };
    };
    assert.deepEqual(await fetchViaFeedPilotBridge({ username: 'ordinary' }), { used: false });
    const result = await fetchViaFeedPilotBridge({ username: 'exception', mode: 'bridge_then_pool' });
    assert.equal(result.used, true);
    assert.equal(result.retryable, true);
    assert.equal(calls, 1);
    assert.equal(process.env.FEED_SOURCE_MODE, 'pool');
  } finally {
    global.fetch = originalFetch;
    for (const [name, value] of Object.entries({ FEED_SOURCE_MODE: previous.mode, FEEDPILOT_BRIDGE_URL: previous.url, FEEDPILOT_BRIDGE_KEY: previous.key })) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test('bridgeEnabled respects FEED_SOURCE_MODE and FEEDPILOT_BRIDGE_ENABLED', () => {
  const prevMode = process.env.FEED_SOURCE_MODE;
  const prevEnabled = process.env.FEEDPILOT_BRIDGE_ENABLED;

  try {
    process.env.FEED_SOURCE_MODE = 'pool';
    assert.equal(bridgeEnabled(), false);

    process.env.FEED_SOURCE_MODE = 'android_bridge';
    assert.equal(bridgeEnabled(), true);

    process.env.FEED_SOURCE_MODE = 'bridge_then_pool';
    assert.equal(bridgeEnabled(), true);

    delete process.env.FEED_SOURCE_MODE;
    process.env.FEEDPILOT_BRIDGE_ENABLED = 'true';
    assert.equal(bridgeEnabled(), true);

    process.env.FEEDPILOT_BRIDGE_ENABLED = 'false';
    assert.equal(bridgeEnabled(), false);
  } finally {
    process.env.FEED_SOURCE_MODE = prevMode;
    process.env.FEEDPILOT_BRIDGE_ENABLED = prevEnabled;
  }
});

test('fetchViaFeedPilotBridge sends includeStories only as strict boolean', async () => {
  const prevMode = process.env.FEED_SOURCE_MODE;
  const prevUrl = process.env.FEEDPILOT_BRIDGE_URL;
  const prevKey = process.env.FEEDPILOT_BRIDGE_KEY;
  const originalFetch = global.fetch;

  try {
    process.env.FEED_SOURCE_MODE = 'android_bridge';
    process.env.FEEDPILOT_BRIDGE_URL = 'http://localhost:5000';
    process.env.FEEDPILOT_BRIDGE_KEY = 'test-key';

    let capturedBody = null;
    global.fetch = async (url, options) => {
      capturedBody = JSON.parse(options.body);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          data: { profile: { id: '123' }, items: [] },
        }),
      };
    };

    // Case 1: includeStories explicitly true
    await fetchViaFeedPilotBridge({
      userId: 'testuser',
      includeStories: true,
    });
    assert.equal(capturedBody.includeStories, true);

    // Case 2: includeStories missing/undefined -> must be false
    await fetchViaFeedPilotBridge({
      userId: 'testuser',
    });
    assert.equal(capturedBody.includeStories, false);

    // Case 3: includeStories non-boolean / falsy -> must be false
    await fetchViaFeedPilotBridge({
      userId: 'testuser',
      includeStories: 'false',
    });
    assert.equal(capturedBody.includeStories, false);

    await fetchViaFeedPilotBridge({
      userId: 'testuser',
      includeStories: null,
    });
    assert.equal(capturedBody.includeStories, false);
  } finally {
    process.env.FEED_SOURCE_MODE = prevMode;
    process.env.FEEDPILOT_BRIDGE_URL = prevUrl;
    process.env.FEEDPILOT_BRIDGE_KEY = prevKey;
    global.fetch = originalFetch;
  }
});

test('fetchViaFeedPilotBridge treats IG_EMPTY_FEED and 502 as retryable so pool/fallback triggers', async () => {
  const prevMode = process.env.FEED_SOURCE_MODE;
  const prevUrl = process.env.FEEDPILOT_BRIDGE_URL;
  const prevKey = process.env.FEEDPILOT_BRIDGE_KEY;
  const originalFetch = global.fetch;

  try {
    process.env.FEED_SOURCE_MODE = 'bridge_then_pool';
    process.env.FEEDPILOT_BRIDGE_URL = 'http://localhost:5000';
    process.env.FEEDPILOT_BRIDGE_KEY = 'test-key';

    global.fetch = async () => ({
      ok: false,
      status: 502,
      json: async () => ({
        success: false,
        code: 'IG_EMPTY_FEED',
        message: 'Instagram returned no feed data.',
      }),
    });

    const result = await fetchViaFeedPilotBridge({
      userId: 'testuser',
      includeStories: false,
    });

    assert.equal(result.used, true);
    assert.equal(result.ok, false);
    assert.equal(result.retryable, true);
    assert.equal(result.code, 'IG_EMPTY_FEED');
  } finally {
    process.env.FEED_SOURCE_MODE = prevMode;
    process.env.FEEDPILOT_BRIDGE_URL = prevUrl;
    process.env.FEEDPILOT_BRIDGE_KEY = prevKey;
    global.fetch = originalFetch;
  }
});

test('sanitizeBridgeUsername handles valid handles, leading @, URLs, and rejects posts/reels/@ inside', () => {
  // Valid handles
  assert.equal(sanitizeBridgeUsername('wwe'), 'wwe');
  assert.equal(sanitizeBridgeUsername('gentlerist'), 'gentlerist');
  assert.equal(sanitizeBridgeUsername('the.private.suite_la'), 'the.private.suite_la');

  // Strips leading @
  assert.equal(sanitizeBridgeUsername('@wwe'), 'wwe');
  assert.equal(sanitizeBridgeUsername('@@wwe'), 'wwe');
  assert.equal(sanitizeBridgeUsername('  @gentlerist  '), 'gentlerist');

  // Rejects internal @
  assert.equal(sanitizeBridgeUsername('wwe@'), undefined);
  assert.equal(sanitizeBridgeUsername('user@domain.com'), undefined);
  assert.equal(sanitizeBridgeUsername('john@doe'), undefined);

  // Profile URLs extracted
  assert.equal(sanitizeBridgeUsername('https://www.instagram.com/wwe/'), 'wwe');
  assert.equal(sanitizeBridgeUsername('http://instagram.com/wwe'), 'wwe');
  assert.equal(sanitizeBridgeUsername('https://www.instagram.com/@wwe/'), 'wwe');
  assert.equal(sanitizeBridgeUsername('instagram.com/gentlerist?igsh=abc'), 'gentlerist');
  assert.equal(sanitizeBridgeUsername('https://instagram.com/_u/wwe'), 'wwe');

  // Post & Reel URLs rejected
  assert.equal(sanitizeBridgeUsername('https://www.instagram.com/p/DFg1234/'), undefined);
  assert.equal(sanitizeBridgeUsername('https://www.instagram.com/reel/C7-xyz_123/'), undefined);
  assert.equal(sanitizeBridgeUsername('https://instagram.com/reels/C7-xyz_123/'), undefined);
  assert.equal(sanitizeBridgeUsername('https://www.instagram.com/tv/xyz789/'), undefined);
  assert.equal(sanitizeBridgeUsername('/p/DFg1234/'), undefined);
  assert.equal(sanitizeBridgeUsername('reel/C7-xyz_123'), undefined);
  assert.equal(sanitizeBridgeUsername('reels/C7-xyz_123'), undefined);
  assert.equal(sanitizeBridgeUsername('https://www.instagram.com/stories/highlights/12345/'), undefined);
  assert.equal(sanitizeBridgeUsername('https://www.instagram.com/stories/wwe/123456789/'), undefined);

  // Reserved Instagram routes rejected
  assert.equal(sanitizeBridgeUsername('reel'), undefined);
  assert.equal(sanitizeBridgeUsername('reels'), undefined);
  assert.equal(sanitizeBridgeUsername('p'), undefined);
  assert.equal(sanitizeBridgeUsername('tv'), undefined);
  assert.equal(sanitizeBridgeUsername('stories'), undefined);
  assert.equal(sanitizeBridgeUsername('explore'), undefined);

  // Pure numeric IDs rejected
  assert.equal(sanitizeBridgeUsername('123456789'), undefined);
  assert.equal(sanitizeBridgeUsername('0'), undefined);

  // Invalid chars / empty
  assert.equal(sanitizeBridgeUsername(''), undefined);
  assert.equal(sanitizeBridgeUsername('   '), undefined);
  assert.equal(sanitizeBridgeUsername(null), undefined);
  assert.equal(sanitizeBridgeUsername(undefined), undefined);
  assert.equal(sanitizeBridgeUsername('user!name'), undefined);
  assert.equal(sanitizeBridgeUsername('user name'), undefined);
});

test('fetchViaFeedPilotBridge sanitizes username and rejects post/reel URLs before calling bridge', async () => {
  const prevMode = process.env.FEED_SOURCE_MODE;
  const prevUrl = process.env.FEEDPILOT_BRIDGE_URL;
  const prevKey = process.env.FEEDPILOT_BRIDGE_KEY;
  const originalFetch = global.fetch;

  try {
    process.env.FEED_SOURCE_MODE = 'android_bridge';
    process.env.FEEDPILOT_BRIDGE_URL = 'http://localhost:5000';
    process.env.FEEDPILOT_BRIDGE_KEY = 'test-key';

    let capturedBody = null;
    let fetchCallCount = 0;
    global.fetch = async (url, options) => {
      fetchCallCount += 1;
      capturedBody = JSON.parse(options.body);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          data: { profile: { id: '123' }, items: [] },
        }),
      };
    };

    // 1. Username with leading @ is sanitized to bare username
    fetchCallCount = 0;
    capturedBody = null;
    const res1 = await fetchViaFeedPilotBridge({ username: '@wwe' });
    assert.equal(res1.ok, true);
    assert.equal(fetchCallCount, 1);
    assert.equal(capturedBody.username, 'wwe');
    assert.equal(capturedBody.userId, undefined);

    // 2. Profile URL in username is sanitized to bare handle
    fetchCallCount = 0;
    capturedBody = null;
    const res2 = await fetchViaFeedPilotBridge({ username: 'https://www.instagram.com/gentlerist/' });
    assert.equal(res2.ok, true);
    assert.equal(fetchCallCount, 1);
    assert.equal(capturedBody.username, 'gentlerist');

    // 3. Post / Reel URL in username with no numeric userId does not hit bridge
    fetchCallCount = 0;
    capturedBody = null;
    const res3 = await fetchViaFeedPilotBridge({ username: 'https://www.instagram.com/reel/DFg1234/' });
    assert.equal(res3.used, false);
    assert.equal(res3.ok, false);
    assert.equal(res3.code, 'INVALID_BRIDGE_TARGET');
    assert.equal(fetchCallCount, 0);

    // 4. Reel URL in userId with no username does not hit bridge
    fetchCallCount = 0;
    capturedBody = null;
    const res4 = await fetchViaFeedPilotBridge({ userId: 'https://www.instagram.com/reel/DFg1234/' });
    assert.equal(res4.used, false);
    assert.equal(res4.ok, false);
    assert.equal(res4.code, 'INVALID_BRIDGE_TARGET');
    assert.equal(fetchCallCount, 0);

    // 5. Numeric userId without username passes through correctly
    fetchCallCount = 0;
    capturedBody = null;
    const res5 = await fetchViaFeedPilotBridge({ userId: '123456789' });
    assert.equal(res5.ok, true);
    assert.equal(fetchCallCount, 1);
    assert.equal(capturedBody.userId, '123456789');
    assert.equal(capturedBody.username, undefined);

    // 6. Username containing @ inside is rejected
    fetchCallCount = 0;
    capturedBody = null;
    const res6 = await fetchViaFeedPilotBridge({ username: 'user@domain.com' });
    assert.equal(res6.used, false);
    assert.equal(res6.ok, false);
    assert.equal(res6.code, 'INVALID_BRIDGE_TARGET');
    assert.equal(fetchCallCount, 0);
  } finally {
    process.env.FEED_SOURCE_MODE = prevMode;
    process.env.FEEDPILOT_BRIDGE_URL = prevUrl;
    process.env.FEEDPILOT_BRIDGE_KEY = prevKey;
    global.fetch = originalFetch;
  }
});

