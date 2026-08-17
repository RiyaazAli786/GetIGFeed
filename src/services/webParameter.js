'use strict';

const https = require('https');
const axios = require('axios');
const { CookieJar } = require('tough-cookie');
const { createCookieAgent } = require('http-cookie-agent/http');
const { HttpsProxyAgent } = require('https-proxy-agent');

const { BASE_URL, HTTP_TIMEOUT_MS } = require('../config/constants');
const { buildMobileAuthorization } = require('../utils/helpers');

// Cookie-aware agents. createCookieAgent wraps a base agent class so that it
// both manages the tough-cookie jar AND (for the proxy variant) tunnels through
// the proxy. This avoids the axios-cookiejar-support limitation of not allowing
// a custom http(s).Agent alongside its wrapper.
const HttpsCookieAgent = createCookieAgent(https.Agent);
const HttpsProxyCookieAgent = createCookieAgent(HttpsProxyAgent);

/**
 * Node.js equivalent of the C# `GetWebParameter` method.
 *
 * Builds a cookie jar from the account cookies, extracts the csrf token
 * (and, for mobile requests, sessionid / ds_user_id / mid), configures a
 * proxy agent, and returns a ready-to-use axios client plus the relevant
 * header values.
 *
 * @param {object} dominatorAccount
 * @param {boolean} [mobileRequest=false]
 * @returns {{
 *   csrfToken: string,
 *   dsUserId: string,
 *   mid: string,
 *   authorization: string,
 *   xIgClaim: string|undefined,
 *   jazoest: string|undefined,
 *   jar: CookieJar,
 *   client: import('axios').AxiosInstance
 * }}
 */
function getWebParameter(dominatorAccount, mobileRequest = false) {
  const jar = new CookieJar();
  const proxy = dominatorAccount?.accountBaseModel?.accountProxy;
  const xIgClaim = dominatorAccount?.deviceDetails?.igxClaim;

  let csrf = '';
  let sessionId = '';
  let dsUserId = '';
  let mid = '';

  const cookies = dominatorAccount?.cookies ?? [];
  for (const cookie of cookies) {
    // Skip the same cookies the C# implementation skips.
    if (cookie.name === 'test_cookie' || cookie.name === 'fr') continue;

    const domain = (cookie.domain || 'instagram.com').replace(/^\./, '');
    jar.setCookieSync(
      `${cookie.name}=${cookie.value}; Domain=${domain}; Path=/`,
      `https://${domain}`
    );

    if (cookie.name === 'csrftoken') csrf = cookie.value;

    // Always capture these so we can build the Bearer authorization header
    // (Bearer IGT:2:base64({ds_user_id, sessionid})) from the session.
    if (cookie.name === 'sessionid') sessionId = cookie.value;
    if (cookie.name === 'ds_user_id') dsUserId = cookie.value;
    if (cookie.name === 'mid') mid = cookie.value;
  }

  // ds_user_id is the leading segment of the sessionid; derive it as a
  // fallback when no ds_user_id cookie was supplied.
  if (!dsUserId && sessionId) {
    const m = decodeURIComponent(sessionId).match(/^(\d+)[:%]/);
    if (m) dsUserId = m[1];
  }

  // Build a single cookie-aware agent. When a proxy is configured, the agent
  // also tunnels through it (WebProxy + NetworkCredential equivalent).
  let httpsAgent;
  if (proxy?.proxyIp && proxy?.proxyPort) {
    const auth =
      proxy.proxyUsername && proxy.proxyPassword
        ? `${encodeURIComponent(proxy.proxyUsername)}:${encodeURIComponent(
            proxy.proxyPassword
          )}@`
        : '';
    httpsAgent = new HttpsProxyCookieAgent(
      `http://${auth}${proxy.proxyIp}:${proxy.proxyPort}`,
      { cookies: { jar } }
    );
  } else {
    httpsAgent = new HttpsCookieAgent({ cookies: { jar } });
  }

  // The cookie agent handles the jar (UseCookies = true).
  // decompress:true handles gzip/deflate (AutomaticDecompression).
  const client = axios.create({
    baseURL: BASE_URL,
    httpsAgent,
    decompress: true,
    // Bound the response phase. NOTE: axios `timeout` does NOT cover the TCP
    // connect phase through a proxy agent — a dead proxy can still hang on
    // connect for the OS timeout (~21s). The abort signal below covers that.
    timeout: HTTP_TIMEOUT_MS,
    // We check status ourselves, mirroring EnsureSuccessStatusCode.
    validateStatus: () => true,
  });

  // Hard wall-clock timeout that aborts the request at ANY phase (connect, TLS,
  // response) — this is what actually prevents a dead proxy from hanging until
  // the host aborts the stream ("stream aborted"). Applied to every request.
  client.interceptors.request.use((config) => {
    if (!config.signal) config.signal = AbortSignal.timeout(HTTP_TIMEOUT_MS);
    return config;
  });

  // Set DEBUG_HTTP=1 to log every outgoing request + response through this
  // client (method, URL, headers, cookies, proxy, status). Off by default.
  if (process.env.DEBUG_HTTP) attachDebugLogging(client, jar, proxy);

  return {
    csrfToken: csrf,
    dsUserId,
    mid,
    // Bearer IGT:2:base64({ds_user_id, sessionid}) — built whenever a session
    // is present, so it can be sent as the Authorization header.
    authorization: sessionId ? buildMobileAuthorization(dsUserId, sessionId) : '',
    xIgClaim,
    // Jazoest depends on your GramStatic.CreateJazoest implementation; expose
    // the phoneId so a jazoest helper can be plugged in if needed.
    jazoest: dominatorAccount?.deviceDetails?.phoneId,
    jar,
    client,
  };
}

/**
 * Attach request/response logging to an axios client. Enabled by DEBUG_HTTP.
 * Secrets are shown truncated so logs are useful without dumping full tokens.
 */
function attachDebugLogging(client, jar, proxy) {
  const trunc = (v, keep = 12) => {
    const s = String(v ?? '');
    return s.length > keep ? `${s.slice(0, keep)}…(${s.length})` : s;
  };
  // Absolute URLs bypass baseURL in axios; mirror that when logging.
  const fullUrl = (config) =>
    /^https?:\/\//i.test(config.url || '')
      ? config.url
      : (config.baseURL || '') + (config.url || '');

  client.interceptors.request.use((config) => {
    const url = fullUrl(config);
    const h = { ...(config.headers || {}) };
    // Truncate the big auth values for readability.
    if (h.Authorization) h.Authorization = trunc(h.Authorization, 24);
    if (h['x-csrftoken']) h['x-csrftoken'] = trunc(h['x-csrftoken']);

    let cookieHeader = '';
    try {
      cookieHeader = jar.getCookieStringSync(url);
    } catch {
      /* ignore */
    }

    // eslint-disable-next-line no-console
    console.log(
      '\n[HTTP →] %s %s\n  proxy: %s\n  headers: %s\n  cookies: %s',
      (config.method || 'get').toUpperCase(),
      url,
      proxy?.proxyIp ? `${proxy.proxyIp}:${proxy.proxyPort}` : '(none)',
      JSON.stringify(h),
      trunc(cookieHeader, 120)
    );
    return config;
  });

  client.interceptors.response.use(
    (response) => {
      // eslint-disable-next-line no-console
      console.log(
        '[HTTP ←] %s %s → %d',
        (response.config.method || 'get').toUpperCase(),
        fullUrl(response.config),
        response.status
      );
      return response;
    },
    (error) => {
      // eslint-disable-next-line no-console
      console.error('[HTTP ✖] request failed:', error.message);
      return Promise.reject(error);
    }
  );
}

module.exports = { getWebParameter };
