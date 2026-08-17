'use strict';

const config = require('../config/story');
const { request, requestText, getSetCookies, toCookieHeader } = require('../utils/httpFetch');
const { getBetween } = require('../utils/strings');
const { sleep } = require('../utils/helpers');

/**
 * Port of GramDominatorCore.Utility.StoryFetcher.
 */

/**
 * GetParam - opens the site once and harvests the session cookies the
 * subsequent POSTs need.
 *
 * @param {string} url         page to hit
 * @param {Object} cookieNames map of cookieName -> domain
 * @returns {Promise<Array<{key:string,value:string,domain:string,expires:string}>>}
 */
async function getParam(url, cookieNames = {}) {
  const params = [];
  try {
    const response = await request(url, {
      method: 'GET',
      headers: {
        Connection: 'keep-alive',
        'sec-ch-ua': '"(Not(A:Brand";v="99", "Google Chrome";v="133", "Chromium";v="133"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"macOS"',
        'Upgrade-Insecure-Requests': '1',
        'User-Agent': config.userAgents.chromeMac,
        Accept:
          'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
        'Sec-Fetch-Site': 'none',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-User': '?1',
        'Sec-Fetch-Dest': 'document',
        'Accept-Language': 'en-GB,en-US;q=0.9,en;q=0.8',
        'sec-ch-ua-full-version-list':
          '"(Not(A:Brand";v="99.0.0.0", "Google Chrome";v="133", "Chromium";v="133"',
      },
    });

    const cookies = getSetCookies(response.headers);
    for (const [name, domain] of Object.entries(cookieNames)) {
      const match = cookies.find((c) => c && c.includes(name));
      if (!match) continue;
      params.push({
        key: name,
        value: getBetween(match, `${name}=`, ';'),
        domain,
        expires: getBetween(match, 'expires=', ';'),
      });
    }
  } catch {
    // Same as the C# side: a failed handshake yields an empty param list.
  }
  return params;
}

/**
 * HitRequest - authenticated JSON POST against storynavigation.com / theasmn.
 *
 * @param {string} api
 * @param {Array} params  session cookies from getParam
 * @param {string|Object} body
 * @param {string} origin
 * @param {string} referer
 * @returns {Promise<string>} raw response body
 */
async function hitRequest(api, params, body, origin, referer) {
  const xsrf = (params || []).find((p) => p.key === 'XSRF-TOKEN');
  const headers = {
    'sec-ch-ua-platform': '"Windows"',
    'User-Agent': config.userAgents.chromeWin,
    Accept: 'application/json, text/plain, */*',
    'sec-ch-ua': '"(Not(A:Brand";v="99", "Google Chrome";v="134", "Chromium";v="134"',
    'Content-Type': 'application/json',
    Origin: origin,
    Referer: referer,
  };
  if (xsrf && xsrf.value) headers['X-XSRF-TOKEN'] = decodeURIComponent(xsrf.value);

  const cookie = toCookieHeader(params);
  if (cookie) headers.Cookie = cookie;

  const { body: responseText } = await requestText(api, {
    method: 'POST',
    headers,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  return responseText;
}

/* ------------------------------------------------------------------ *
 * anonstories throttle guard
 *
 * The host allows only a handful of requests per short window before answering
 * 429 "Too many requests" and, if pushed, an HTML block page. Since it is the
 * only source for some accounts' highlight lists, being throttled means real
 * data loss — so requests are serialized with a minimum gap, and successful
 * bodies are cached for a short TTL. Repeated lookups of one handle (a user
 * pressing Fetch again) and the per-highlight fan-out then cost nothing extra.
 * ------------------------------------------------------------------ */

const anonCache = new Map();
let anonChain = Promise.resolve();
let anonLastAt = 0;

/** Serialize onto one chain, spacing each call by minIntervalMs. */
function scheduleAnon(task) {
  const run = anonChain.then(async () => {
    const gap = config.anonStories.minIntervalMs - (Date.now() - anonLastAt);
    if (gap > 0) await sleep(gap);
    try {
      return await task();
    } finally {
      anonLastAt = Date.now();
    }
  });
  // Keep the chain usable even when a task rejects.
  anonChain = run.then(
    () => {},
    () => {}
  );
  return run;
}

/** Cache only real, content-bearing answers — never a 429 or a block page. */
function cacheableAnon(result) {
  return (
    result.status === 200 && Boolean(result.body) && !/^\s*<(!doctype|html)/i.test(result.body)
  );
}

function pruneAnonCache() {
  const cutoff = Date.now() - config.anonStories.cacheTtlMs;
  for (const [key, entry] of anonCache) if (entry.at < cutoff) anonCache.delete(key);
  // Hard ceiling in case a long-lived process sees many distinct handles.
  if (anonCache.size > 200) anonCache.clear();
}

/**
 * Shared anonstories.com POST. `auth` is base64 of the '::'-joined segments
 * with the static token appended:
 *   story/highlights list -> "-1::<username>::<token>"
 *   highlight items       -> "<userId>::<username>::<highlightId>::<token>"
 *
 * @returns {Promise<{status:number, body:string}>} status matters here: a 429 or
 *   an HTML page is what throttling looks like, and the body alone cannot say so.
 */
async function postAnonStories(api, segments) {
  const key = `${api}|${segments.join('::')}`;
  const cached = anonCache.get(key);
  if (cached && Date.now() - cached.at < config.anonStories.cacheTtlMs) return cached.result;

  const result = await scheduleAnon(() => requestAnonStories(api, segments));
  if (cacheableAnon(result)) {
    pruneAnonCache();
    anonCache.set(key, { at: Date.now(), result });
  }
  return result;
}

async function requestAnonStories(api, segments) {
  try {
    const authRaw = [...segments, config.anonStories.authSuffix].join('::');
    const authEncoded = Buffer.from(authRaw, 'utf8').toString('base64');

    const { status, body } = await requestText(api, {
      method: 'POST',
      headers: {
        Connection: 'keep-alive',
        'sec-ch-ua-platform': '"Linux"',
        'X-Requested-With': 'XMLHttpRequest',
        'User-Agent': config.userAgents.chromeLinux,
        Accept: '*/*',
        'sec-ch-ua': '"(Not(A:Brand";v="99", "Google Chrome";v="134", "Chromium";v="134"',
        'sec-ch-ua-mobile': '?0',
        Origin: config.anonStories.origin,
        'Sec-Fetch-Site': 'same-origin',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Dest': 'empty',
        Referer: config.anonStories.referer,
        'Accept-Language': 'en-GB,en-US;q=0.9,en;q=0.8',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ auth: authEncoded }).toString(),
    });
    return { status, body };
  } catch {
    return { status: 0, body: '' };
  }
}

/**
 * HitStoryOrHighlights - the story / highlights-list fallback source.
 * @returns {Promise<{status:number, body:string}>}
 */
function hitStoryOrHighlights(api, username) {
  return postAnonStories(api, ['-1', username]);
}

/**
 * anonstories.com/api/v1/highlight/stories - the media inside one highlight.
 * userId is the numeric Instagram id from the profile lookup; '-1' when unknown.
 * @returns {Promise<{status:number, body:string}>}
 */
function hitHighlightStories(userId, username, highlightId) {
  return postAnonStories(config.anonStories.highlightStories, [
    userId || '-1',
    username,
    highlightId,
  ]);
}

/** GetInstaUsername - accepts a bare handle or a full instagram profile URL. */
function getInstaUsername(instaUsername) {
  if (!instaUsername) return instaUsername;
  const value = String(instaUsername).trim();
  if (!value.includes('www.instagram.com')) return value.replace(/^@/, '');
  const segments = value.split('/').filter(Boolean);
  const last = segments[segments.length - 1];
  return (last || '').split('?')[0];
}

/** IsImageVisibleAsync - HEAD probe used to detect an expired CDN profile pic. */
async function isImageVisible(imageUrl) {
  try {
    if (!imageUrl) return false;
    const response = await request(imageUrl, { method: 'HEAD' });
    const contentType = response.headers.get('content-type') || '';
    return response.ok && contentType.startsWith('image');
  } catch {
    return false;
  }
}

module.exports = {
  getParam,
  hitRequest,
  hitStoryOrHighlights,
  hitHighlightStories,
  getInstaUsername,
  isImageVisible,
};
