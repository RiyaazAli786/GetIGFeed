'use strict';

const { getWebParameter } = require('./webParameter');
const { getCsrfToken } = require('./authToken.service');
const poolStore = require('../store/poolStore');
const { buildWebProfileResponse, pickCount } = require('../utils/mapFeedToWebProfile');
const { resolveUserId } = require('../graphql/service');
const {
  resolveStoryOptions,
  fetchStoryBundle,
  attachStoryNodes,
  storyHandle,
} = require('./feedStoryMerge');
const {
  USER_AGENT,
  ACCEPT_ENCODING,
  X_ASBD_ID,
  X_IG_APP_ID,
  PAGE_COUNT,
} = require('../config/constants');

/**
 * Fetch only the first page of an Instagram user feed (the most recent
 * PAGE_COUNT posts — 12 by default) and return it in the web_profile_info
 * response shape ({ data: { user: { edge_owner_to_timeline_media } }, status }).
 * No pagination, no delays.
 *
 * Stories and highlights are fetched alongside the feed (from the third-party
 * story sources, which need no session or proxy) and merged into the same
 * response as separate `stories` / `highlights` / `highlight_details` nodes.
 * That lookup is best-effort: it never fails a feed that otherwise worked, and
 * it can be turned off per request with `includeStories: false`.
 *
 * @param {object} dominatorAccount
 * @param {string} userId
 * @param {object} [opts]
 * @param {string|null} [opts.maxId] - optional cursor (usually null for page 1)
 * @param {boolean} [opts.includeStories] - fetch stories/highlights too
 * @param {boolean} [opts.includeHighlightDetails] - expand each highlight
 * @param {number} [opts.highlightDetailLimit] - cap the expansion (0 = all)
 * @returns {Promise<object>} web_profile_info-shaped response
 */
async function getUserFeed(dominatorAccount, userId, opts = {}) {
  const { maxId = null } = opts;
  const storyOptions = resolveStoryOptions(opts);
  const inputUser = String(userId ?? '').trim();

  // A username input can start the story lookup immediately, in parallel with
  // the feed; a numeric pk has to wait until the feed tells us the handle.
  const inputHandle = /^\d+$/.test(inputUser) ? null : normalizeUsername(inputUser);
  let storyPromise =
    storyOptions.enabled && inputHandle ? fetchStoryBundle(inputHandle, storyOptions) : null;

  let posts = [];
  let nextMaxId = null;
  let hasMore = false;
  let errorMessage = null;
  let profile = null;

  // Hydrate any missing cookies/proxy from the encrypted pool. Session and
  // proxy secrets are decrypted here, at the point of use.
  const account = poolStore.resolveAccount(dominatorAccount);

  try {
    const param = getWebParameter(account);

    const maxParam = maxId ? `&max_id=${encodeURIComponent(maxId)}` : '';

    // Reuse the stored csrf token for up to CSRF_MAX_USES requests, then
    // rotate. Falls back to the cookie-derived token if the fetch fails.
    let csrfToken = param.csrfToken;
    try {
      const token = await getCsrfToken(account);
      if (token?.csrfToken) csrfToken = token.csrfToken;
    } catch (tokenErr) {
      // eslint-disable-next-line no-console
      console.warn('[getUserFeed] csrf token fetch failed:', tokenErr.message);
    }

    const headers = {
      'x-asbd-id': X_ASBD_ID,
      'User-Agent': USER_AGENT,
      'x-ig-app-id': X_IG_APP_ID,
      Accept: '*/*',
      'Accept-Encoding': ACCEPT_ENCODING,
      'Accept-Language': 'en-GB,en-US;q=0.9,en;q=0.8',
    };
    if (csrfToken) headers['x-csrftoken'] = csrfToken;
    if (param.xIgClaim) headers['x-ig-www-claim'] = param.xIgClaim;
    // Bearer IGT:2:base64({ds_user_id, sessionid}) built from the session.
    if (param.authorization) headers['Authorization'] = param.authorization;

    const feedTarget = inputHandle
      ? `${encodeURIComponent(inputHandle)}/username`
      : encodeURIComponent(inputUser);
    const endpoint = `/api/v1/feed/user/${feedTarget}/?count=${PAGE_COUNT}${maxParam}`;
    const response = await param.client.get(endpoint, { headers });

    // EnsureSuccessStatusCode equivalent.
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`Request failed with status ${response.status}`);
    }

    const data = response.data || {};

    // First page only — take the most recent PAGE_COUNT items.
    if (Array.isArray(data.items)) posts = data.items.slice(0, PAGE_COUNT);
    hasMore = Boolean(data.more_available);
    nextMaxId = data.next_max_id ?? null;

    // Profile fields (follower/following counts, HD avatar) that the feed
    // response carries at the top level.
    profile = mergeProfiles(data.user, posts[0]?.user);
    if (!hasProfileCounts(profile)) {
      // Profile details missing counts -> fetch details as fast fallback (non-blocking)
      const profileHeaders = { ...headers };
      try {
        const cookieHeader = param.jar.getCookieStringSync('https://www.instagram.com/');
        if (cookieHeader) profileHeaders.Cookie = cookieHeader;
      } catch {
        /* cookie header is best-effort; the cookie agent still has the jar */
      }
      const fetchedDetails = await fetchUserProfileDetails(param.client, inputUser, profileHeaders, profile);
      if (fetchedDetails) profile = mergeProfiles(profile, fetchedDetails);
    }

    // Empty response with a non-2xx or an IG error message → note why.
    if (!posts.length) {
      if (response.status < 200 || response.status >= 300) {
        errorMessage = `Instagram returned HTTP ${response.status}` +
          (data.message ? ` (${data.message})` : '');
      } else if (data.message || data.status === 'fail') {
        errorMessage = `Instagram: ${data.message || 'request failed'}`;
      }
    }
  } catch (err) {
    // The C# version swallows exceptions and returns whatever it has.
    // Preserve that behavior but log + capture the reason for diagnostics.
    // eslint-disable-next-line no-console
    console.error('[getUserFeed] error:', err.message);
    errorMessage = humanizeFetchError(err.message);
  }

  // Convert feed/user items → web_profile_info response shape.
  const out = buildWebProfileResponse(posts, {
    userId: numericPk(profile?.pk_id, profile?.pk, profile?.id, inputUser) || inputUser,
    hasMore,
    maxId: nextMaxId,
    count: pickCount(profile, 'media_count', 'edge_owner_to_timeline_media') ?? posts.length,
    user: profile,
  });
  // Surface a diagnostic only when nothing came back, so callers/UI can explain
  // an empty feed instead of showing a bare "0 posts".
  if (!posts.length && errorMessage) out.error = errorMessage;

  // Stories + highlights as their own nodes on the same response.
  if (storyOptions.enabled) {
    const handle = storyHandle(out, userId);
    if (!storyPromise && handle) storyPromise = fetchStoryBundle(handle, storyOptions);
    const bundle = storyPromise
      ? await storyPromise
      : { error: 'Could not resolve a username for the story lookup.' };
    attachStoryNodes(out, bundle, storyOptions);
  }

  return out;
}

/**
 * First candidate that is a plain digit string (Instagram's numeric user pk).
 * Usernames, empty values and anything else are rejected.
 *
 * @returns {string|null}
 */
function numericPk(...candidates) {
  for (const c of candidates) {
    if (c === null || c === undefined) continue;
    const s = String(c).trim();
    if (/^\d+$/.test(s)) return s;
  }
  return null;
}

function normalizeUsername(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  if (/^\d+$/.test(raw)) return raw;
  try {
    const url = raw.startsWith('http://') || raw.startsWith('https://')
      ? new URL(raw)
      : null;
    if (url && /(^|\.)instagram\.com$/i.test(url.hostname)) {
      return decodeURIComponent(url.pathname.split('/').filter(Boolean)[0] || '').replace(/^@/, '');
    }
  } catch {
    // Fall through to raw handle normalization.
  }
  return raw.replace(/^@/, '').split(/[/?#]/)[0].trim();
}

async function resolveUsernamePk(username) {
  try {
    return await resolveUserId(username);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[getUserFeed] username id resolution failed for ${username}:`, err.message);
    return null;
  }
}

function mergeProfiles(...profiles) {
  const merged = {};
  for (const profile of profiles) {
    if (!profile || typeof profile !== 'object') continue;
    for (const [key, value] of Object.entries(profile)) {
      if (value === null || value === undefined || value === '') continue;
      merged[key] = value;
    }
  }
  return Object.keys(merged).length ? merged : null;
}

/**
 * True when the payload already carries both follow counts, in either the
 * private-API (`follower_count`) or web (`edge_followed_by.count`) spelling.
 */
function hasProfileCounts(user) {
  const followers = pickCount(user, 'follower_count', 'edge_followed_by', 'followers_count');
  const following = pickCount(user, 'following_count', 'edge_follow', 'follows_count');
  if (followers === null || following === null) return false;
  return followers > 0 || following > 0;
}

/**
 * TopFollow-style profile resolver. It avoids the older public web_profile_info
 * and i.instagram.com fallbacks and instead uses the www.instagram.com api/v1
 * surface accepted by captured web sessions.
 */
async function fetchUserProfileDetails(client, usernameOrId, headers, initialProfile = null) {
  const clean = normalizeUsername(usernameOrId);
  if (!clean) return null;

  let userObj = initialProfile || null;
  let mediaCount = pickCount(userObj, 'media_count', 'edge_owner_to_timeline_media') || 0;
  let pk = numericPk(userObj?.pk_id, userObj?.pk, userObj?.id) || (/^\d+$/.test(clean) ? clean : null);

  if (!pk && !/^\d+$/.test(clean)) {
    pk = await resolveUsernamePk(clean);
  }

  if (pk) {
    const hoverUser = await fetchPolarisHoverCardProfile(client, clean, pk, headers);
    if (hoverUser) {
      userObj = mergeProfiles(userObj, hoverUser);
      const hoverMediaCount = pickCount(hoverUser, 'media_count', 'edge_owner_to_timeline_media');
      if (typeof hoverMediaCount === 'number') mediaCount = hoverMediaCount;
      pk = numericPk(hoverUser.pk_id, hoverUser.pk, hoverUser.id, pk);
    }
  }

  if (!pk) {
    const feedUrl =
      `https://www.instagram.com/api/v1/feed/user/${encodeURIComponent(clean)}/username/?count=${PAGE_COUNT}`;
    const feedUser = await getProfileFrom(client, feedUrl, headers, (d) => {
      const user = d?.user || null;
      if (Array.isArray(d?.items)) {
        mediaCount = d.items.length;
        return user || d.items[0]?.user || null;
      }
      return user;
    }, 2500);
    if (feedUser) {
      userObj = mergeProfiles(userObj, feedUser);
      pk = numericPk(feedUser.pk_id, feedUser.pk, feedUser.id);
    }
  }

  if (pk) {
    const infoUrl = `https://www.instagram.com/api/v1/users/${pk}/info/`;
    const infoUser = await getProfileFrom(client, infoUrl, headers, (d) => d?.user, 2500);
    if (infoUser) {
      userObj = mergeProfiles(userObj, infoUser);
      const infoMediaCount = pickCount(infoUser, 'media_count', 'edge_owner_to_timeline_media');
      if (typeof infoMediaCount === 'number') mediaCount = infoMediaCount;
      pk = numericPk(infoUser.pk_id, infoUser.pk, infoUser.id, pk);
    }
  }

  const htmlUsername = userObj?.username || (/^\d+$/.test(clean) ? null : clean);
  if (!userObj && htmlUsername) {
    const og = await fetchOpenGraphProfile(client, htmlUsername);
    if (og) {
      userObj = mergeProfiles(userObj, og);
      const ogMediaCount = pickCount(og, 'media_count', 'edge_owner_to_timeline_media');
      if (mediaCount <= 0 && typeof ogMediaCount === 'number') mediaCount = ogMediaCount;
    }
  }

  if (!userObj) return pk ? { pk_id: pk, id: pk, username: /^\d+$/.test(clean) ? null : clean } : null;

  const profilePic =
    userObj?.hd_profile_pic_url_info?.url ||
    userObj?.profile_pic_url_hd ||
    userObj?.profile_pic_url ||
    null;
  const followers = pickCount(userObj, 'follower_count', 'edge_followed_by', 'followers_count');
  const following = pickCount(userObj, 'following_count', 'edge_follow', 'follows_count');
  const resolvedMediaCount =
    pickCount(userObj, 'media_count', 'edge_owner_to_timeline_media') ?? mediaCount;

  const normalized = {
    ...userObj,
    pk_id: numericPk(userObj.pk_id, userObj.pk, userObj.id, pk) || pk || undefined,
    id: numericPk(userObj.id, userObj.pk_id, userObj.pk, pk) || pk || undefined,
    username: userObj.username || (/^\d+$/.test(clean) ? null : clean),
    profile_pic_url: userObj.profile_pic_url || profilePic,
    profile_pic_url_hd: userObj.profile_pic_url_hd || profilePic,
  };
  if (followers !== null && followers !== undefined) normalized.follower_count = followers;
  if (following !== null && following !== undefined) normalized.following_count = following;
  if (resolvedMediaCount !== null && resolvedMediaCount !== undefined) {
    normalized.media_count = resolvedMediaCount;
  }
  return normalized;
}

async function fetchPolarisHoverCardProfile(client, usernameOrId, userId, headers) {
  const targetUserId = numericPk(userId);
  if (!targetUserId) return null;

  const handle = normalizeUsername(usernameOrId);
  const csrfToken = headers?.['x-csrftoken'] || headers?.['X-CSRFToken'] || '';
  const lsdToken = process.env.INSTAGRAM_LSD_TOKEN || 'toxLtqxo-5GooSYWUv2PJ1';
  const referer = /^\d+$/.test(handle)
    ? 'https://www.instagram.com/'
    : `https://www.instagram.com/${encodeURIComponent(handle)}/`;

  const body = new URLSearchParams({
    jazoest: createJazoest(targetUserId),
    __crn: 'comet.igweb.PolarisProfilePostsTabRoute',
    fb_api_caller_class: 'RelayModern',
    fb_api_req_friendly_name: 'PolarisUserHoverCardContentV2Query',
    server_timestamps: 'true',
    variables: JSON.stringify({ userID: targetUserId }),
    doc_id: '27756568060663620',
  });

  try {
    const fbDtsg = await fetchFbDtsgToken(client, headers?.Cookie, handle);
    if (fbDtsg) body.set('fb_dtsg', fbDtsg);

    const response = await client.post(
      'https://www.instagram.com/api/graphql',
      body.toString(),
      {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
            '(KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36',
          'Content-Type': 'application/x-www-form-urlencoded',
          'sec-ch-ua-full-version-list':
            '"Not=A?Brand";v="99.0.0.0", "Google Chrome";v="151.0.7922.108", "Chromium";v="151.0.7922.108"',
          'sec-ch-ua-platform': '"Windows"',
          'viewport-width': '1517',
          'sec-ch-ua': '"Not=A?Brand";v="99", "Google Chrome";v="151", "Chromium";v="151"',
          'sec-ch-ua-model': '""',
          'sec-ch-ua-mobile': '?0',
          'X-IG-App-ID': X_IG_APP_ID,
          'X-FB-LSD': lsdToken,
          'X-IG-Max-Touch-Points': '0',
          'X-FB-Friendly-Name': 'PolarisUserHoverCardContentV2Query',
          dpr: '0.9',
          'sec-ch-prefers-color-scheme': 'dark',
          DNT: '1',
          'sec-ch-ua-platform-version': '"15.0.0"',
          Accept: '*/*',
          Origin: 'https://www.instagram.com',
          'Sec-Fetch-Site': 'same-origin',
          'Sec-Fetch-Mode': 'cors',
          'Sec-Fetch-Dest': 'empty',
          Referer: referer,
          'Accept-Language': 'en-US,en;q=0.9',
          ...(csrfToken ? { 'X-CSRFToken': csrfToken } : {}),
          ...(headers?.['x-ig-www-claim'] ? { 'X-IG-WWW-Claim': headers['x-ig-www-claim'] } : {}),
          ...(headers?.Cookie ? { Cookie: headers.Cookie } : {}),
        },
        timeout: 2500,
      }
    );

    if (response.status < 200 || response.status >= 300 || !response.data) {
      // eslint-disable-next-line no-console
      console.warn(`[getUserFeed] hover-card profile fetch returned HTTP ${response.status}`);
      return null;
    }

    const payload = parseInstagramGraphqlPayload(response.data);
    const user = extractPolarisHoverCardUser(payload);
    return user || null;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[getUserFeed] hover-card profile fallback failed for ${targetUserId}:`, err.message);
    return null;
  }
}

async function fetchFbDtsgToken(client, cookieHeader, targetHandle = 'accounts/edit') {
  if (!cookieHeader) return null;
  try {
    const clean = normalizeUsername(targetHandle);
    const profilePath =
      !clean || clean === 'accounts/edit' || /^\d+$/.test(clean)
        ? '/accounts/edit/'
        : `/${encodeURIComponent(clean)}/`;
    const response = await client.get(`https://www.instagram.com${profilePath}`, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
          '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        Cookie: cookieHeader,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
      responseType: 'text',
      transformResponse: [(data) => data],
      timeout: 2500,
    });
    const html = String(response.data || '');
    return (
      /"DTSGInitialData"\s*,\s*\[]\s*,\s*\{\s*"token"\s*:\s*"([^"]+)"/i.exec(html)?.[1] ||
      /name=["']fb_dtsg["']\s+value=["']([^"']+)["']/i.exec(html)?.[1] ||
      /"token"\s*:\s*"([A-Za-z0-9_-]+:[0-9]+:[0-9]+)"/i.exec(html)?.[1] ||
      null
    );
  } catch {
    return null;
  }
}

function parseInstagramGraphqlPayload(data) {
  if (!data) return null;
  if (typeof data !== 'string') return data;
  const clean = data.trim().replace(/^for\s*\(;;\);/, '');
  if (!clean || clean.startsWith('<')) return null;
  return clean ? JSON.parse(clean) : null;
}

function extractPolarisHoverCardUser(payload) {
  return (
    payload?.data?.xig_user_by_igid_v2?.user_dict ||
    payload?.data?.user ||
    payload?.user ||
    null
  );
}

function createJazoest(value = '') {
  let sum = 0;
  for (const ch of String(value)) sum += ch.charCodeAt(0);
  return `2${sum}`;
}

async function fetchOpenGraphProfile(client, username) {
  try {
    const response = await client.get(`https://www.instagram.com/${encodeURIComponent(username)}/`, {
      headers: {
        'User-Agent': 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
      timeout: 2500,
    });
    if (response.status < 200 || response.status >= 300 || !response.data) return null;
    const html = String(response.data);
    const ogDesc = readMetaContent(html, 'og:description');
    const ogImage = readMetaContent(html, 'og:image');
    const out = {};
    if (ogDesc) {
      const followers = /([0-9.,KMBm]+)\s+Followers/i.exec(ogDesc)?.[1];
      const following = /([0-9.,KMBm]+)\s+Following/i.exec(ogDesc)?.[1];
      const posts = /([0-9.,KMBm]+)\s+Posts/i.exec(ogDesc)?.[1];
      if (followers) out.follower_count = parseFormattedCount(followers);
      if (following) out.following_count = parseFormattedCount(following);
      if (posts) out.media_count = parseFormattedCount(posts);
    }
    if (ogImage) {
      out.profile_pic_url = ogImage;
      out.profile_pic_url_hd = ogImage;
    }
    return Object.keys(out).length ? out : null;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[getUserFeed] OpenGraph profile fallback failed for ${username}:`, err.message);
    return null;
  }
}

function readMetaContent(html, property) {
  const prop = property.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return (
    new RegExp(`<meta[^>]+property=["']${prop}["'][^>]+content=["']([^"']+)["']`, 'i')
      .exec(html)?.[1] ||
    new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+property=["']${prop}["']`, 'i')
      .exec(html)?.[1] ||
    null
  );
}

function parseFormattedCount(value) {
  const clean = String(value || '').trim().toUpperCase();
  if (!clean) return 0;
  const suffix = clean.slice(-1);
  const multiplier =
    suffix === 'K' ? 1_000 :
    suffix === 'M' ? 1_000_000 :
    suffix === 'B' ? 1_000_000_000 :
    1;
  const number = suffix === 'K' || suffix === 'M' || suffix === 'B'
    ? Number(clean.slice(0, -1).replace(/,/g, ''))
    : Number(clean.replace(/,/g, '').replace(/\./g, ''));
  return Number.isFinite(number) ? Math.trunc(number * multiplier) : 0;
}

/** One profile fetch: GET, check status, pull the user out. Never throws. */
async function getProfileFrom(client, url, headers, extract, timeoutMs = 2500) {
  try {
    const response = await client.get(url, { headers, timeout: timeoutMs });
    if (response.status < 200 || response.status >= 300) {
      // eslint-disable-next-line no-console
      console.warn(`[getUserFeed] profile fetch ${url} returned HTTP ${response.status}`);
      return null;
    }
    const user = extract(response.data);
    if (!user) {
      // eslint-disable-next-line no-console
      console.warn(`[getUserFeed] profile fetch ${url} returned no user object`);
    }
    return user || null;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[getUserFeed] profile fetch ${url} failed:`, err.message);
    return null;
  }
}

/**
 * Turn a raw fetch/axios error message into something actionable. A reset
 * response stream through a proxy almost always means Instagram blocked the
 * proxy IP (common with datacenter proxies).
 */
function humanizeFetchError(message = '') {
  const m = String(message).toLowerCase();
  if (m.includes('stream has been aborted') || m.includes('aborted') || m.includes('econnreset')) {
    return 'Instagram reset the connection — the proxy IP is likely blocked ' +
      '(datacenter proxies are usually blocked; use residential/mobile).';
  }
  if (m.includes('timed out') || m.includes('timeout') || m.includes('etimedout')) {
    return 'Request timed out — the proxy is slow or unreachable.';
  }
  if (m.includes('econnrefused')) return 'Proxy refused the connection.';
  if (m.includes('canceled')) {
    return 'Request timed out (aborted) — proxy slow/unreachable or IP blocked.';
  }
  return message || 'request failed';
}

module.exports = {
  getUserFeed,
  fetchPolarisHoverCardProfile,
  parseInstagramGraphqlPayload,
  extractPolarisHoverCardUser,
  fetchFbDtsgToken,
  createJazoest,
  hasProfileCounts,
};
