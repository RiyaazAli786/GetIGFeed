'use strict';

const { getWebParameter } = require('./webParameter');
const tokenStore = require('../store/tokenStore');
const { USER_AGENT, ACCEPT_ENCODING, X_IG_APP_ID } = require('../config/constants');

const SHARED_DATA_URL = 'https://www.instagram.com/api/v1/web/data/shared_data/';

// How many requests a single CSRF token serves before it is rotated.
const CSRF_MAX_USES = parseInt(process.env.CSRF_MAX_USES || '10', 10);

/**
 * Fetch a fresh CSRF token from Instagram's shared_data endpoint.
 *
 * The response looks like: { "config": { "csrf_token": "...", ... }, ... }
 *
 * @param {object} [dominatorAccount] optional account (for cookies/proxy)
 * @returns {Promise<{ csrfToken: string, raw: object }>}
 */
async function fetchCsrfToken(dominatorAccount) {
  // Reuse getWebParameter so we get the same cookie jar / proxy handling.
  // shared_data lives on www.instagram.com, so we pass an absolute URL which
  // axios uses instead of the client's baseURL.
  const { client } = getWebParameter(dominatorAccount || {});

  const response = await client.get(SHARED_DATA_URL, {
    headers: {
      'User-Agent': USER_AGENT,
      'x-ig-app-id': X_IG_APP_ID,
      Accept: '*/*',
      'Accept-Encoding': ACCEPT_ENCODING,
      'Accept-Language': 'en-GB,en-US;q=0.9,en;q=0.8',
    },
  });

  if (response.status < 200 || response.status >= 300) {
    throw new Error(`shared_data request failed with status ${response.status}`);
  }

  const data = response.data || {};
  const csrfToken = data?.config?.csrf_token;

  if (!csrfToken) {
    throw new Error('csrf_token not found in shared_data response.');
  }

  return { csrfToken, raw: data };
}

/**
 * Fetch a fresh CSRF token and persist it to the JSON store, rotating the
 * previous value into history. Call this on every request that needs a token.
 *
 * @param {object} [dominatorAccount]
 * @returns {Promise<{ csrfToken: string, source: string, rotatedAt: string }>}
 */
async function rotateAuthToken(dominatorAccount) {
  const { csrfToken } = await fetchCsrfToken(dominatorAccount);

  const entry = {
    csrfToken,
    source: SHARED_DATA_URL,
    // Passed in by the caller rather than Date.now() so it is easy to stub.
    rotatedAt: new Date().toISOString(),
    // Fresh token: this rotation counts as the first use.
    useCount: 1,
  };

  tokenStore.save(entry);
  return entry;
}

/**
 * Return a CSRF token to use for a request, reusing the stored one until it has
 * served `maxUses` requests, then rotating (fetching a fresh one).
 *
 * Example (maxUses = 10): request 1 rotates → useCount 1; requests 2–10 reuse →
 * useCount 2..10; request 11 rotates again.
 *
 * @param {object} [dominatorAccount]
 * @param {number} [maxUses=CSRF_MAX_USES]
 * @returns {Promise<{ csrfToken: string, useCount: number, rotatedAt: string }>}
 */
async function getCsrfToken(dominatorAccount, maxUses = CSRF_MAX_USES) {
  const current = tokenStore.getCurrent();

  if (current?.csrfToken && (current.useCount || 0) < maxUses) {
    // Reuse: bump the counter in place (no rotation, no shared_data fetch).
    const updated = { ...current, useCount: (current.useCount || 0) + 1 };
    tokenStore.updateCurrent(updated);
    return updated;
  }

  // No token yet, or it has hit maxUses → fetch a fresh one.
  return rotateAuthToken(dominatorAccount);
}

module.exports = {
  fetchCsrfToken,
  rotateAuthToken,
  getCsrfToken,
  CSRF_MAX_USES,
  SHARED_DATA_URL,
};
