'use strict';

/**
 * src/graphql/service.js
 *
 * Fetches Instagram timeline posts via the official GraphQL doc_id query:
 *   GET /graphql/query/?doc_id=7950326061742207&variables={id,first}
 *
 * User ID resolution: uses the public web_profile_info endpoint
 * (no session needed — works like a browser visiting a profile).
 *
 * The GraphQL query itself requires a valid Instagram session from the pool.
 */

const { getWebParameter } = require('../services/webParameter');
const { getCsrfToken } = require('../services/authToken.service');
const poolStore = require('../store/poolStore');
const { X_IG_APP_ID, X_ASBD_ID } = require('../config/constants');
const { pickCount } = require('../utils/mapFeedToWebProfile');

/** doc_id for the timeline media GraphQL query (confirmed working 2026-08). */
const GRAPHQL_DOC_ID = '7950326061742207';

const badRequest = (msg) => Object.assign(new Error(msg), { status: 400 });

// ─── Headers ────────────────────────────────────────────────────────────────

function webBrowserHeaders(extra = {}) {
  return {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
    Accept: '*/*',
    'Accept-Language': 'en-US,en;q=0.9',
    'x-ig-app-id': X_IG_APP_ID,
    'x-asbd-id': X_ASBD_ID,
    ...extra,
  };
}

// ─── User ID resolution ──────────────────────────────────────────────────────

/**
 * Resolve a handle to its numeric Instagram user ID.
 *
 * Three strategies tried in order (first win returns):
 *   1. Native HTTPS fetch of web_profile_info — public, no session, no pool
 *      client base-URL conflicts. Works for any public account.
 *   2. anonyig getUser — the anonyig module already resolves this reliably
 *      and returns `data.id`. Used when strategy 1 fails (e.g. rate-limited).
 *   3. Pool client web_profile_info with auth headers — last resort if both
 *      public paths fail.
 */
async function resolveUserId(username) {
  // ── Strategy 1: public web_profile_info via native https ─────────────────
  try {
    const user = await fetchWebProfileInfoUser(username);
    const id = user?.id ?? user?.pk_id;
    if (id && String(id).match(/^\d+$/)) return String(id);
  } catch (_) {}

  // ── Strategy 2: anonyig getUser (no session, proven working) ─────────────
  try {
    const anonyigService = require('../anonyig/service');
    const user = await anonyigService.getUser(username);
    const id = user?.data?.id ?? user?.data?.pk_id ?? user?.id;
    if (id && String(id).match(/^\d+$/)) return String(id);
  } catch (_) {}

  // ── Strategy 3: pool client with auth headers ─────────────────────────────
  try {
    const account = poolStore.resolveAccount();
    const param = getWebParameter(account);
    const headers = webBrowserHeaders({
      ...(param.csrfToken ? { 'x-csrftoken': param.csrfToken } : {}),
      ...(param.authorization ? { Authorization: param.authorization } : {}),
    });
    const url =
      'https://www.instagram.com/api/v1/users/web_profile_info/?' +
      `username=${encodeURIComponent(username)}`;
    const r = await param.client.get(url, { headers });
    const id = r.data?.data?.user?.id ?? r.data?.data?.user?.pk_id;
    if (id && String(id).match(/^\d+$/)) return String(id);
  } catch (_) {}

  throw Object.assign(
    new Error(`Could not resolve username "${username}" to a numeric user ID.`),
    { status: 404 }
  );
}

/**
 * Fetch the numeric user ID from the public web_profile_info endpoint using
 * Node's native https module (avoids any axios base-URL / interceptor issues).
 */
function fetchWebProfileInfoUser(username) {
  return new Promise((resolve, reject) => {
    const https = require('https');
    const url =
      `https://www.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(username)}`;
    const options = {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
          '(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
        Accept: '*/*',
        'Accept-Language': 'en-US,en;q=0.9',
        'x-ig-app-id': X_IG_APP_ID,
        'x-asbd-id': X_ASBD_ID,
      },
    };
    https.get(url, options, (res) => {
      let raw = '';
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(raw);
          resolve(parsed?.data?.user || null);
        } catch {
          resolve(null);
        }
      });
    }).on('error', reject);
  });
}


// ─── GraphQL query ───────────────────────────────────────────────────────────

/** Fetch a profile header for the converted GraphQL response when available. */
async function fetchProfileForConvertedResponse(handle, fallbackId, param, headers) {
  try {
    const user = await fetchWebProfileInfoUser(handle);
    if (user) return user;
  } catch (_) {}

  try {
    const url =
      'https://www.instagram.com/api/v1/users/web_profile_info/?' +
      `username=${encodeURIComponent(handle)}`;
    const r = await param.client.get(url, { headers });
    return r.data?.data?.user || null;
  } catch (_) {}

  return { id: fallbackId, username: handle };
}

function convertedUserProfile(user, fallbackId, fallbackUsername) {
  return {
    id: String(user?.id ?? user?.pk_id ?? fallbackId ?? ''),
    username: user?.username ?? fallbackUsername,
    full_name: user?.full_name ?? null,
    is_private: Boolean(user?.is_private),
    is_verified: Boolean(user?.is_verified),
    profile_pic_url: user?.profile_pic_url ?? null,
    profile_pic_url_hd: user?.profile_pic_url_hd ?? user?.profile_pic_url ?? null,
    edge_followed_by: {
      count: pickCount(user, 'follower_count', 'edge_followed_by', 'followers_count', 'followers') ?? 0,
    },
    edge_follow: {
      count: pickCount(user, 'following_count', 'edge_follow', 'follows_count', 'following') ?? 0,
    },
  };
}

/**
 * Fetch timeline posts for a handle via the Instagram GraphQL doc_id query.
 *
 * Returns data in the web_profile_info-shaped envelope so existing consumers
 * can read it without changes:
 *   { data: { user: { edge_owner_to_timeline_media: { count, page_info, edges } } }, status, source }
 *
 * @param {string} username   Instagram handle (with or without @).
 * @param {object} [opts]
 * @param {number} [opts.first=12]  Posts per page (max ~50 before IG complains).
 * @param {string} [opts.after]     Pagination cursor (end_cursor from a prior response).
 */
async function fetchFromGraphQL(username, opts = {}) {
  const handle = String(username || '').trim().replace(/^@/, '');
  if (!handle) throw badRequest('username is required.');

  const first = Math.min(parseInt(opts.first, 10) || 12, 50);
  const after = opts.after || opts.endCursor || null;

  // Draw account + proxy from the pool.
  const account = poolStore.resolveAccount();
  const param = getWebParameter(account);

  // Get a fresh CSRF token if available; silently fall back to cookie-derived.
  let csrfToken = param.csrfToken || '';
  try {
    const tok = await getCsrfToken(account);
    if (tok?.csrfToken) csrfToken = tok.csrfToken;
  } catch (_) {}

  const baseHeaders = webBrowserHeaders({
    ...(csrfToken ? { 'x-csrftoken': csrfToken } : {}),
    ...(param.authorization ? { Authorization: param.authorization } : {}),
    ...(param.xIgClaim ? { 'x-ig-www-claim': param.xIgClaim } : {}),
  });

  // ── Step 1: Resolve user ID ──────────────────────────────────────────────
  let userId;
  let profileUser = null;
  try {
    profileUser = await fetchProfileForConvertedResponse(handle, null, param, baseHeaders);
    userId = profileUser?.id ?? profileUser?.pk_id;
    if (!userId || !String(userId).match(/^\d+$/)) userId = await resolveUserId(handle);
    userId = String(userId);
  } catch (err) {
    throw err; // already has the right status code
  }


  // ── Step 2: Run the GraphQL query ────────────────────────────────────────
  const variables = { id: userId, include_clips_attribution_info: false, first };
  if (after) variables.after = after;

  const qUrl =
    'https://www.instagram.com/graphql/query/?' +
    `doc_id=${GRAPHQL_DOC_ID}&variables=${encodeURIComponent(JSON.stringify(variables))}`;

  let gqlData;
  try {
    const r = await param.client.get(qUrl, { headers: baseHeaders });
    if (r.status < 200 || r.status >= 300) {
      throw new Error(`Instagram GraphQL returned HTTP ${r.status}`);
    }
    gqlData = r.data;
  } catch (err) {
    throw Object.assign(
      new Error(`Instagram GraphQL upstream failure: ${err.message}`),
      { status: 502 }
    );
  }

  // ── Step 3: Normalise the response ───────────────────────────────────────
  // The GraphQL response already mirrors web_profile_info shape:
  //   data.user.edge_owner_to_timeline_media.{ count, page_info, edges }
  // We just wrap it and add metadata.
  const gqlUser = gqlData?.data?.user || {};
  const timeline = gqlUser.edge_owner_to_timeline_media || {};
  const edges = Array.isArray(timeline.edges) ? timeline.edges : [];
  const pageInfo = timeline.page_info || {};
  const userProfile = convertedUserProfile(
    { ...(profileUser || {}), ...(gqlUser || {}) },
    userId,
    handle
  );

const {
  resolveStoryOptions,
  fetchStoryBundle,
  attachStoryNodes,
} = require('../services/feedStoryMerge');

  const response = {
    success: true,
    source: 'graphql',
    userId,
    username: handle,
    count: edges.length,
    totalCount: timeline.count ?? null,
    hasNextPage: Boolean(pageInfo.has_next_page),
    endCursor: pageInfo.end_cursor ?? null,
    data: {
      user: {
        ...userProfile,
        edge_owner_to_timeline_media: {
          count: timeline.count ?? edges.length,
          page_info: {
            has_next_page: Boolean(pageInfo.has_next_page),
            end_cursor: pageInfo.end_cursor ?? null,
          },
          edges,
        },
      },
    },
    status: gqlData?.status || 'ok',
  };

  const storyOptions = resolveStoryOptions(opts);
  if (storyOptions.enabled) {
    const bundle = await fetchStoryBundle(handle, storyOptions);
    attachStoryNodes(response, bundle, storyOptions);
  }

  return response;
}

module.exports = {
  resolveUserId,
  fetchFromGraphQL,
};
