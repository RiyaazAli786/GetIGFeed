'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  bridgeMode,
  bridgeEnabled,
  fallbackEnabled,
  fetchViaFeedPilotBridge,
} = require('./feedPilotBridge.service');

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

