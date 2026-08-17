'use strict';

const config = require('../config/story');

/**
 * Plain `fetch` wrapper with a timeout, used by the story / highlight sources.
 *
 * The feed talks to Instagram through an axios client with a cookie jar and an
 * optional proxy (see services/webParameter.js); the story viewers need none of
 * that, so they get this thin helper instead. Node's fetch transparently
 * handles gzip/deflate/br, which is what IgHttpHelper.GetDecodedResponse did by
 * hand in the original C#.
 */
async function request(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    options.timeoutMs || config.requestTimeoutMs
  );
  try {
    return await fetch(url, { ...options, signal: controller.signal, redirect: 'follow' });
  } finally {
    clearTimeout(timeout);
  }
}

async function requestText(url, options = {}) {
  const response = await request(url, options);
  const body = await response.text();
  return { status: response.status, ok: response.ok, headers: response.headers, body };
}

/** Set-Cookie is multi-valued; getSetCookie exists on Node >= 20. */
function getSetCookies(headers) {
  if (typeof headers.getSetCookie === 'function') return headers.getSetCookie();
  const raw = headers.raw ? headers.raw()['set-cookie'] : null;
  if (Array.isArray(raw)) return raw;
  const single = headers.get('set-cookie');
  return single ? [single] : [];
}

/** Builds a Cookie header from the SessionModel-shaped list used everywhere. */
function toCookieHeader(params) {
  return (params || [])
    .filter((p) => p && p.key && p.value !== undefined && p.value !== null)
    .map((p) => `${p.key}=${p.value}`)
    .join('; ');
}

module.exports = { request, requestText, getSetCookies, toCookieHeader };
