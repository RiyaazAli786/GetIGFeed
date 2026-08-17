'use strict';

const crypto = require('crypto');

const { encryptJson, decryptJson } = require('../utils/crypto');
const { getBackend } = require('./poolBackend');

/**
 * Encrypted store for a pool of Instagram sessions and proxies.
 *
 * Secrets (session id / cookies, proxy credentials) are encrypted at rest with
 * AES-256-GCM (see utils/crypto). Only non-sensitive metadata (id, label,
 * ds_user_id, createdAt) is kept in the clear so the pool can be listed without
 * exposing the secrets. Decryption happens on demand when an Instagram request
 * needs a session/proxy.
 *
 * The encrypted blob is persisted through a pluggable backend (a local file, or
 * Backblaze B2 object storage — see poolBackend). Reads and round-robin pickers
 * serve from an in-memory cache for speed; mutations reload-modify-save against
 * the durable backend so the stored copy is always authoritative, then refresh
 * the cache. Because mutations touch the network (B2), they are ASYNC.
 *
 * Blob shape:
 *   {
 *     "sessions": [ { id, label, dsUserId, createdAt, enc } ],
 *     "proxies":  [ { id, label, host, port, createdAt, enc } ]
 *   }
 */

// In-memory round-robin cursors (per process).
let sessionCursor = 0;
let proxyCursor = 0;

// ---------------------------------------------------------------------------
// Persistence (cached; durable copy in the configured backend)
// ---------------------------------------------------------------------------

// In-memory copy of the pool blob. Null until first loaded.
let cache = null;

/** Populate the cache synchronously when the backend allows it (local file). */
function ensureCache() {
  if (cache) return cache;
  const backend = getBackend();
  cache =
    (backend.loadSync && backend.loadSync()) || { sessions: [], proxies: [] };
  return cache;
}

/**
 * Load the pool from the durable backend into the cache. Call once at startup
 * (awaited) so remote (B2) reads are warm before the first request.
 */
async function init() {
  cache = await getBackend().load();
  return cache;
}

/** Sync read of the cached store — used by list/pickers. */
function read() {
  return ensureCache();
}

/** Async: load a fresh copy from the backend (authoritative for mutations). */
async function reload() {
  cache = await getBackend().load();
  return cache;
}

/** Async: persist a store to the backend and update the cache. */
async function persist(store) {
  cache = store;
  await getBackend().save(store);
}

const newId = () => crypto.randomUUID();
const now = () => new Date().toISOString();

/** Mask a secret string, keeping only the last few characters visible. */
function mask(value, visible = 4) {
  const s = String(value || '');
  if (s.length <= visible) return '*'.repeat(s.length);
  return `${'*'.repeat(Math.min(8, s.length - visible))}${s.slice(-visible)}`;
}

// ---------------------------------------------------------------------------
// Input parsing
// ---------------------------------------------------------------------------

/**
 * Normalize a single session input into a secret blob.
 * Accepts:
 *   - a raw sessionid string: "64827392%3AAbC...%3A17"
 *   - a cookie string: "sessionid=...; csrftoken=...; ds_user_id=...; mid=..."
 *   - an object: { sessionid, csrftoken, mid, dsUserId|ds_user_id, cookies, label }
 * @returns {{ secret: object, dsUserId: string, label: string|undefined }}
 */
function parseSessionInput(input) {
  let sessionid = '';
  let csrftoken = '';
  let mid = '';
  let dsUserId = '';
  let label;
  let cookies;

  if (input && typeof input === 'object' && !Array.isArray(input)) {
    sessionid = input.sessionid || input.sessionId || '';
    csrftoken = input.csrftoken || input.csrfToken || '';
    mid = input.mid || '';
    dsUserId = input.dsUserId || input.ds_user_id || '';
    label = input.label;
    if (Array.isArray(input.cookies)) cookies = input.cookies;
  } else if (typeof input === 'string') {
    const str = input.trim();
    if (/(^|[;\s])sessionid=/.test(str) || str.includes('=')) {
      // Cookie-string form: split on ";" into k=v pairs.
      for (const pair of str.split(';')) {
        const idx = pair.indexOf('=');
        if (idx === -1) continue;
        const k = pair.slice(0, idx).trim();
        const v = pair.slice(idx + 1).trim();
        if (k === 'sessionid') sessionid = v;
        else if (k === 'csrftoken') csrftoken = v;
        else if (k === 'ds_user_id') dsUserId = v;
        else if (k === 'mid') mid = v;
      }
      if (!sessionid) sessionid = str; // fall back to whole string
    } else {
      sessionid = str;
    }
  }

  sessionid = String(sessionid || '').trim();
  if (!sessionid) throw new Error('session is missing a sessionid');

  // ds_user_id is the leading segment of the sessionid ("<id>%3A..." or "<id>:...").
  if (!dsUserId) {
    const decoded = decodeURIComponent(sessionid);
    const m = decoded.match(/^(\d+)[:%]/);
    if (m) dsUserId = m[1];
  }

  return {
    secret: { sessionid, csrftoken, mid, dsUserId, cookies },
    dsUserId,
    label,
  };
}

/**
 * Normalize a single proxy input into a secret blob + visible host/port.
 * Accepts:
 *   - "ip:port"
 *   - "ip:port:user:pass"
 *   - "user:pass@ip:port"
 *   - "http://user:pass@ip:port"
 *   - object: { host|proxyIp, port|proxyPort, username|proxyUsername, password|proxyPassword, label }
 * @returns {{ secret: object, host: string, port: string, label: string|undefined }}
 */
function parseProxyInput(input) {
  let host = '';
  let port = '';
  let username = '';
  let password = '';
  let label;

  if (input && typeof input === 'object' && !Array.isArray(input)) {
    host = input.host || input.proxyIp || input.ip || input.url || '';
    port = input.port || input.proxyPort || '';
    label = input.label;

    // Luminati / Bright Data style: username is built from the customer +
    // zone (+ optional country/session). Detected when `customer` or `zone`
    // is present and no explicit username was given.
    const explicitUser = input.username || input.proxyUsername || input.user;
    if (!explicitUser && (input.customer || input.zone)) {
      const parts = [];
      if (input.customer) parts.push(input.customer);
      if (input.zone) parts.push(`zone-${input.zone}`);
      if (input.country) parts.push(`country-${input.country}`);
      if (input.session) parts.push(`session-${input.session}`);
      username = parts.join('-');
      password = input.password || input.proxyPassword || input.pass || '';
    } else {
      username = explicitUser || '';
      password = input.password || input.proxyPassword || input.pass || '';
    }
  } else if (typeof input === 'string') {
    let str = input.trim().replace(/^https?:\/\//i, '');
    if (str.includes('@')) {
      // user:pass@ip:port
      const [creds, hostPart] = str.split('@');
      [username, password] = creds.split(':');
      [host, port] = hostPart.split(':');
    } else {
      const parts = str.split(':');
      if (parts.length >= 4) {
        [host, port, username, password] = parts;
      } else {
        [host, port] = parts;
      }
    }
  }

  host = String(host || '').trim();
  port = String(port || '').trim();
  if (!host || !port) throw new Error('proxy is missing host or port');

  return {
    secret: { host, port, username, password },
    host,
    port,
    label,
  };
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

/**
 * Bulk-add sessions. Duplicates (same sessionid) are skipped.
 * @param {Array<string|object>} list
 * @returns {{ added: object[], skipped: number, total: number }}
 */
async function addSessions(list) {
  const store = await reload();
  const existing = new Set(
    store.sessions.map((s) => {
      try {
        return decryptJson(s.enc).sessionid;
      } catch {
        return null;
      }
    })
  );

  const added = [];
  let skipped = 0;

  for (const raw of Array.isArray(list) ? list : [list]) {
    let parsed;
    try {
      parsed = parseSessionInput(raw);
    } catch {
      skipped += 1;
      continue;
    }
    if (existing.has(parsed.secret.sessionid)) {
      skipped += 1;
      continue;
    }
    existing.add(parsed.secret.sessionid);

    const entry = {
      id: newId(),
      label: parsed.label,
      dsUserId: parsed.dsUserId || '',
      createdAt: now(),
      enc: encryptJson(parsed.secret),
    };
    store.sessions.push(entry);
    added.push(publicSession(entry));
  }

  await persist(store);
  return { added, skipped, total: store.sessions.length };
}

/** Public (masked) view of a stored session entry. */
function publicSession(entry) {
  let preview = '';
  try {
    preview = mask(decryptJson(entry.enc).sessionid);
  } catch {
    preview = '(unreadable)';
  }
  return {
    id: entry.id,
    label: entry.label,
    dsUserId: entry.dsUserId,
    sessionidPreview: preview,
    createdAt: entry.createdAt,
  };
}

/** List all sessions (masked). */
function listSessions() {
  return read().sessions.map(publicSession);
}

/**
 * Update a session in place, preserving its id and createdAt.
 * - `label` (if the key is present) is always applied, including clearing it.
 * - A new credential (sessionid / cookie string / cookies[]) re-encrypts the
 *   secret and refreshes dsUserId. Omit it to edit only the label.
 * @returns {object|null} the updated public session, or null if not found.
 */
async function updateSession(id, input = {}) {
  const store = await reload();
  const entry = store.sessions.find((s) => s.id === id);
  if (!entry) return null;

  const obj = input && typeof input === 'object' && !Array.isArray(input);
  const hasSecret = obj
    ? Boolean(input.sessionid || input.sessionId || input.cookies)
    : Boolean(input);

  if (hasSecret) {
    const parsed = parseSessionInput(input);
    entry.enc = encryptJson(parsed.secret);
    entry.dsUserId = parsed.secret.dsUserId || entry.dsUserId || '';
  }
  if (obj && 'label' in input) entry.label = input.label;

  await persist(store);
  return publicSession(entry);
}

/** Delete a session by id. Returns true if one was removed. */
async function deleteSession(id) {
  const store = await reload();
  const before = store.sessions.length;
  store.sessions = store.sessions.filter((s) => s.id !== id);
  const removed = store.sessions.length < before;
  if (removed) await persist(store);
  return removed;
}

/** Remove every session. Returns the number removed. */
async function clearSessions() {
  const store = await reload();
  const count = store.sessions.length;
  store.sessions = [];
  await persist(store);
  return count;
}

// ---------------------------------------------------------------------------
// Proxies
// ---------------------------------------------------------------------------

/**
 * Bulk-add proxies. Duplicates (same host:port:username) are skipped.
 * @param {Array<string|object>} list
 * @returns {{ added: object[], skipped: number, total: number }}
 */
async function addProxies(list) {
  const store = await reload();
  const keyOf = (secret) => `${secret.host}:${secret.port}:${secret.username || ''}`;
  const existing = new Set(
    store.proxies.map((p) => {
      try {
        return keyOf(decryptJson(p.enc));
      } catch {
        return null;
      }
    })
  );

  const added = [];
  let skipped = 0;

  for (const raw of Array.isArray(list) ? list : [list]) {
    let parsed;
    try {
      parsed = parseProxyInput(raw);
    } catch {
      skipped += 1;
      continue;
    }
    if (existing.has(keyOf(parsed.secret))) {
      skipped += 1;
      continue;
    }
    existing.add(keyOf(parsed.secret));

    const entry = {
      id: newId(),
      label: parsed.label,
      host: parsed.host,
      port: parsed.port,
      createdAt: now(),
      enc: encryptJson(parsed.secret),
    };
    store.proxies.push(entry);
    added.push(publicProxy(entry));
  }

  await persist(store);
  return { added, skipped, total: store.proxies.length };
}

/** Public (masked) view of a stored proxy entry. */
function publicProxy(entry) {
  let hasAuth = false;
  try {
    const s = decryptJson(entry.enc);
    hasAuth = Boolean(s.username);
  } catch {
    /* ignore */
  }
  return {
    id: entry.id,
    label: entry.label,
    host: entry.host,
    port: entry.port,
    hasAuth,
    createdAt: entry.createdAt,
  };
}

/** List all proxies (credentials never returned). */
function listProxies() {
  return read().proxies.map(publicProxy);
}

/**
 * Update a proxy in place, preserving its id and createdAt.
 * - `label` (if the key is present) is always applied, including clearing it.
 * - A new secret (host + port, optional user/pass, or a proxy string) re-encrypts
 *   the credentials and refreshes the visible host/port. Omit it to edit only
 *   the label.
 * @returns {object|null} the updated public proxy, or null if not found.
 */
async function updateProxy(id, input = {}) {
  const store = await reload();
  const entry = store.proxies.find((p) => p.id === id);
  if (!entry) return null;

  const obj = input && typeof input === 'object' && !Array.isArray(input);
  const hasSecret = obj
    ? Boolean(input.host || input.proxyIp || input.ip || input.url)
    : Boolean(input);

  if (hasSecret) {
    const parsed = parseProxyInput(input);
    entry.enc = encryptJson(parsed.secret);
    entry.host = parsed.host;
    entry.port = parsed.port;
  }
  if (obj && 'label' in input) entry.label = input.label;

  await persist(store);
  return publicProxy(entry);
}

/** Delete a proxy by id. Returns true if one was removed. */
async function deleteProxy(id) {
  const store = await reload();
  const before = store.proxies.length;
  store.proxies = store.proxies.filter((p) => p.id !== id);
  const removed = store.proxies.length < before;
  if (removed) await persist(store);
  return removed;
}

/** Remove every proxy. Returns the number removed. */
async function clearProxies() {
  const store = await reload();
  const count = store.proxies.length;
  store.proxies = [];
  await persist(store);
  return count;
}

// ---------------------------------------------------------------------------
// Pickers + account hydration (decrypt on use)
// ---------------------------------------------------------------------------

/** Round-robin pick a decrypted session secret, or null if the pool is empty. */
function nextSession() {
  const { sessions } = read();
  if (!sessions.length) return null;
  const entry = sessions[sessionCursor % sessions.length];
  sessionCursor = (sessionCursor + 1) % sessions.length;
  try {
    return { id: entry.id, dsUserId: entry.dsUserId, ...decryptJson(entry.enc) };
  } catch {
    return null;
  }
}

/**
 * Decrypted secret for a single session by id (cookies + metadata).
 * Returns null when the id doesn't exist; throws (code DECRYPT_FAILED) when the
 * entry exists but can't be decrypted — usually an ENCRYPTION_KEY mismatch —
 * so callers don't confuse that with "not found".
 */
function getSessionSecret(id) {
  const entry = read().sessions.find((s) => s.id === id);
  if (!entry) return null;
  try {
    return { id: entry.id, dsUserId: entry.dsUserId, ...decryptJson(entry.enc) };
  } catch {
    const err = new Error(
      'Session secret could not be decrypted (ENCRYPTION_KEY mismatch?).'
    );
    err.code = 'DECRYPT_FAILED';
    throw err;
  }
}

/**
 * Decrypted secret for a single proxy by id (host/port/user/pass).
 * Returns null when the id doesn't exist; throws (code DECRYPT_FAILED) when the
 * entry exists but can't be decrypted — usually an ENCRYPTION_KEY mismatch —
 * so callers don't confuse that with "not found".
 */
function getProxySecret(id) {
  const entry = read().proxies.find((p) => p.id === id);
  if (!entry) return null;
  try {
    return decryptJson(entry.enc);
  } catch {
    const err = new Error(
      'Proxy secret could not be decrypted (ENCRYPTION_KEY mismatch?).'
    );
    err.code = 'DECRYPT_FAILED';
    throw err;
  }
}

/** Round-robin pick a decrypted proxy secret, or null if the pool is empty. */
function nextProxy() {
  const { proxies } = read();
  if (!proxies.length) return null;
  const entry = proxies[proxyCursor % proxies.length];
  proxyCursor = (proxyCursor + 1) % proxies.length;
  try {
    return { id: entry.id, ...decryptJson(entry.enc) };
  } catch {
    return null;
  }
}

/** Build the cookies[] array getWebParameter expects from a session secret. */
function cookiesFromSession(session) {
  if (Array.isArray(session.cookies) && session.cookies.length) {
    return session.cookies;
  }
  const cookies = [];
  if (session.sessionid)
    cookies.push({ name: 'sessionid', value: session.sessionid, domain: 'instagram.com' });
  if (session.csrftoken)
    cookies.push({ name: 'csrftoken', value: session.csrftoken, domain: 'instagram.com' });
  if (session.dsUserId)
    cookies.push({ name: 'ds_user_id', value: session.dsUserId, domain: 'instagram.com' });
  if (session.mid)
    cookies.push({ name: 'mid', value: session.mid, domain: 'instagram.com' });
  return cookies;
}

/** Shape a proxy secret into the accountProxy structure getWebParameter reads. */
function accountProxyFromProxy(proxy) {
  return {
    proxyIp: proxy.host,
    proxyPort: proxy.port,
    proxyUsername: proxy.username || '',
    proxyPassword: proxy.password || '',
  };
}

/**
 * Build a getWebParameter-ready account from a bare auth token + proxy — no
 * dominatorAccount required. Both fields are optional; whatever is missing is
 * later filled from the pool by resolveAccount().
 *
 * @param {object} creds
 * @param {string} [creds.authToken]  the sessionid / auth token
 * @param {string} [creds.sessionid]  alias of authToken
 * @param {string} [creds.token]      alias of authToken
 * @param {string} [creds.csrfToken]  optional csrf token
 * @param {Array}  [creds.cookies]    optional explicit cookie array
 * @param {string|object} [creds.proxy] "ip:port[:user:pass]" or a proxy object
 * @returns {object} a dominatorAccount-shaped object
 */
function buildAccount(creds = {}) {
  const account = {};
  const authToken = creds.authToken || creds.sessionid || creds.token;

  if (Array.isArray(creds.cookies) && creds.cookies.length) {
    account.cookies = creds.cookies;
  } else if (authToken) {
    const { secret } = parseSessionInput(authToken);
    if (creds.csrfToken) secret.csrftoken = creds.csrfToken;
    account.cookies = cookiesFromSession(secret);
  }

  if (creds.proxy) {
    const { secret } = parseProxyInput(creds.proxy);
    account.accountBaseModel = { accountProxy: accountProxyFromProxy(secret) };
  }

  return account;
}

/**
 * Return a dominatorAccount ready for getWebParameter, hydrating any missing
 * cookies/proxy from the encrypted pool. If the caller already supplied
 * cookies and a proxy, the account is returned unchanged.
 *
 * @param {object} [dominatorAccount]
 * @returns {object|null} account, or null if nothing could be resolved
 */
function resolveAccount(dominatorAccount) {
  const account = dominatorAccount ? { ...dominatorAccount } : {};

  const hasCookies = Array.isArray(account.cookies) && account.cookies.length > 0;
  const hasProxy = Boolean(account?.accountBaseModel?.accountProxy?.proxyIp);

  if (!hasCookies) {
    const session = nextSession();
    if (session) account.cookies = cookiesFromSession(session);
  }

  if (!hasProxy) {
    const proxy = nextProxy();
    if (proxy) {
      account.accountBaseModel = {
        ...(account.accountBaseModel || {}),
        accountProxy: accountProxyFromProxy(proxy),
      };
    }
  }

  const resolvedCookies = Array.isArray(account.cookies) && account.cookies.length > 0;
  return resolvedCookies || dominatorAccount ? account : null;
}

module.exports = {
  // lifecycle
  init,
  // sessions
  addSessions,
  listSessions,
  updateSession,
  deleteSession,
  clearSessions,
  getSessionSecret,
  // proxies
  addProxies,
  listProxies,
  updateProxy,
  deleteProxy,
  clearProxies,
  getProxySecret,
  // usage
  nextSession,
  nextProxy,
  buildAccount,
  resolveAccount,
  // for tests
  parseSessionInput,
  parseProxyInput,
};
