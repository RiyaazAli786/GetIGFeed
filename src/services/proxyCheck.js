'use strict';

const axios = require('axios');
const { HttpsProxyAgent } = require('https-proxy-agent');

const { HTTP_TIMEOUT_MS } = require('../config/constants');

/**
 * Liveness check for a single proxy. Runs TWO probes through the proxy:
 *   1. tunnel  — an IP-echo endpoint: does the proxy pass HTTPS at all, and
 *                what exit IP does it present?
 *   2. instagram — Instagram's (no-auth) shared_data endpoint: can the proxy
 *                actually reach Instagram, or does IG reset the connection?
 *
 * The second probe is what matters for this app: a datacenter proxy often
 * tunnels fine (probe 1 OK) yet Instagram blocks its IP and resets the stream
 * (probe 2 fails). Reporting both makes a passing check mean "usable for feeds",
 * not just "tunnels traffic".
 *
 * Each probe retries across targets (PROXY_CHECK_ATTEMPTS) so a transient blip
 * doesn't show a false failure. Note: genuinely unstable (rotating/
 * oversubscribed) proxies can still vary between checks — that's real.
 */

// IP-echo targets (first is primary, rest are fallbacks).
const IP_URLS = (
  process.env.PROXY_CHECK_URL ||
  'https://api.ipify.org/?format=json,https://icanhazip.com,https://ifconfig.me/ip'
)
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

// No-auth Instagram endpoint that mirrors the real csrf path.
const IG_URL =
  process.env.PROXY_CHECK_IG_URL ||
  'https://www.instagram.com/api/v1/web/data/shared_data/';

const ATTEMPTS = Math.max(1, parseInt(process.env.PROXY_CHECK_ATTEMPTS || '3', 10));
const PER_ATTEMPT_MS = Math.min(
  HTTP_TIMEOUT_MS,
  parseInt(process.env.PROXY_CHECK_TIMEOUT_MS || '8000', 10)
);

function proxyUrl({ host, port, username, password }) {
  const auth =
    username && password
      ? `${encodeURIComponent(username)}:${encodeURIComponent(password)}@`
      : '';
  return `http://${auth}${host}:${port}`;
}

function parseIp(data) {
  if (data && typeof data === 'object' && data.ip) return String(data.ip).trim();
  if (typeof data === 'string' && data.trim()) return data.trim().split(/\s/)[0].slice(0, 45);
  return null;
}

function normalizeErr(err) {
  const m = String(err && err.message).toLowerCase();
  if (err.code === 'ERR_CANCELED' || err.name === 'CanceledError' || err.name === 'TimeoutError') {
    return `timed out after ${PER_ATTEMPT_MS}ms`;
  }
  if (m.includes('stream has been aborted') || m.includes('aborted') || m.includes('econnreset')) {
    return 'connection reset (IP likely blocked)';
  }
  if (m.includes('econnrefused')) return 'connection refused';
  return (err && err.message) || 'request failed';
}

/** One request through a fresh agent. Resolves to a result or throws. */
async function oneShot(url, secret) {
  const agent = new HttpsProxyAgent(proxyUrl(secret));
  const start = Date.now();
  const res = await axios.get(url, {
    httpsAgent: agent,
    proxy: false,
    timeout: PER_ATTEMPT_MS,
    signal: AbortSignal.timeout(PER_ATTEMPT_MS),
    validateStatus: () => true,
    headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json,*/*' },
  });
  return {
    ok: res.status >= 200 && res.status < 500, // reached the target = tunneled
    ms: Date.now() - start,
    status: res.status,
    ip: parseIp(res.data),
  };
}

/** Retry a probe across the given target list; first success wins. */
async function probe(urls, secret) {
  let last = { ok: false, ms: 0, error: 'no attempt made' };
  for (let i = 0; i < ATTEMPTS; i += 1) {
    const url = urls[i % urls.length];
    try {
      const r = await oneShot(url, secret);
      if (r.ok) return { ...r, attempts: i + 1 };
      last = { ok: false, ms: r.ms, status: r.status, error: `HTTP ${r.status}` };
    } catch (err) {
      last = { ok: false, ms: 0, error: normalizeErr(err) };
    }
  }
  return { ...last, attempts: ATTEMPTS };
}

/**
 * @param {{host:string, port:string|number, username?:string, password?:string}} secret
 * @returns {Promise<{ok:boolean, ms:number, ip?:string|null, status?:number,
 *   igReachable:boolean, igStatus?:number, igError?:string|null, attempts:number, error?:string}>}
 */
async function checkProxy(secret) {
  const { host, port } = secret || {};
  if (!host || !port) {
    return { ok: false, ms: 0, igReachable: false, attempts: 0, error: 'proxy is missing host or port' };
  }

  // Run both probes concurrently.
  const [tunnel, ig] = await Promise.all([probe(IP_URLS, secret), probe([IG_URL], secret)]);

  return {
    ok: tunnel.ok, // proxy passes HTTPS at all
    ms: tunnel.ms,
    ip: tunnel.ip || null,
    status: tunnel.status,
    error: tunnel.ok ? null : tunnel.error,
    igReachable: ig.ok, // can actually reach Instagram (not reset/blocked)
    igStatus: ig.status,
    igError: ig.ok ? null : ig.error,
    attempts: tunnel.attempts,
  };
}

module.exports = { checkProxy, IP_URLS, IG_URL, ATTEMPTS };
