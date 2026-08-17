'use strict';

/**
 * signer.js — loads anonyig's own request-signing chunk inside a minimal browser
 * shim and returns the `subscribeSignedRequestBody` function it exports.
 *
 * The chunk is a webpack chunk that pushes [[chunkIds], {moduleId: factory}]
 * onto self.webpackChunk. Its module's `default` export is a promise resolving
 * to:  async (body) => ({ ...body, ts, _ts, _tsc, _sv, _s })
 * where _s = HMAC-SHA256(secret, JSON.stringify(sortedKeys(body)) + ts).
 *
 * The HMAC key is decoded inside the chunk and zero-filled straight after
 * crypto.subtle.importKey, so it is only reachable through the closure. Rather
 * than extracting it, the chunk is run in a `vm` sandbox and the signer it
 * exports is called. That is also why the secret is not in this repository —
 * ./chunk.js fetches the chunk at runtime.
 *
 * Guards inside the chunk the shim has to satisfy:
 *   - typeof window / document !== 'undefined'
 *   - globalThis.crypto.subtle present
 *   - location.hostname is in the chunk's allow-list
 *   - window === window.top   (not framed)
 *   - GET /msec -> { msec }, used to compute the server clock offset
 */

const vm = require('vm');
const config = require('./config');
const chunk = require('./chunk');

const SITE_ORIGIN = config.siteOrigin;
const HOSTNAME = new URL(SITE_ORIGIN).hostname;

function unref(timer) {
  if (timer && typeof timer.unref === 'function') timer.unref();
  return timer;
}

function makeStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    clear: () => map.clear(),
  };
}

function buildSandbox() {
  const sandbox = {
    console,
    // unref'd so the chunk's 1-hour "reload the page" interval cannot keep the
    // server's event loop busy.
    setTimeout: (...a) => unref(setTimeout(...a)),
    clearTimeout,
    setInterval: (...a) => unref(setInterval(...a)),
    clearInterval,
    TextEncoder,
    TextDecoder,
    Uint8Array,
    AbortController,
    URL,
    atob: (s) => Buffer.from(s, 'base64').toString('binary'),
    btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
    crypto: globalThis.crypto,
    // The chunk only ever calls fetch('/msec') — the server clock it measures its
    // offset against. Resolve it against the site, and answer with this host's
    // own clock when the site cannot be reached: a host anonyig.com refuses
    // (HTTP 451) still has to sign, and an offset of zero is exactly what the
    // chunk computes when the clocks already agree.
    fetch: async (input, init) => {
      const url = typeof input === 'string' && input.startsWith('/') ? SITE_ORIGIN + input : input;
      const localClock = () =>
        new Response(JSON.stringify({ msec: Date.now() / 1000 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      try {
        const res = await globalThis.fetch(url, {
          ...init,
          headers: { ...(init && init.headers), Origin: SITE_ORIGIN, Referer: `${SITE_ORIGIN}/` },
        });
        return res.ok ? res : localClock();
      } catch {
        return localClock();
      }
    },
    location: {
      href: `${SITE_ORIGIN}/`,
      origin: SITE_ORIGIN,
      hostname: HOSTNAME,
      host: HOSTNAME,
      protocol: 'https:',
      pathname: '/',
      reload() {},
    },
    document: {
      documentElement: {},
      referrer: '',
      cookie: '',
      createElement: () => ({ style: {}, setAttribute() {}, appendChild() {} }),
      querySelector: () => null,
      addEventListener() {},
    },
    navigator: {
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36',
      language: 'en-US',
      platform: 'Win32',
    },
    localStorage: makeStorage(),
    sessionStorage: makeStorage(),
    addEventListener() {},
    removeEventListener() {},
  };

  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.top = sandbox; // window === window.top  (frame check)
  sandbox.parent = sandbox;
  return sandbox;
}

/** Minimal webpack runtime: enough for a single self-contained chunk module. */
function makeRequire(modules) {
  const cache = {};

  function __webpack_require__(id) {
    if (cache[id]) return cache[id].exports;
    const module = (cache[id] = { id, loaded: false, exports: {} });
    modules[id].call(module.exports, module, module.exports, __webpack_require__);
    module.loaded = true;
    return module.exports;
  }

  __webpack_require__.m = modules;
  __webpack_require__.n = (m) => {
    const getter = m && m.__esModule ? () => m.default : () => m;
    __webpack_require__.d(getter, { a: getter });
    return getter;
  };
  __webpack_require__.d = (exports, definition) => {
    for (const key in definition) {
      if (
        Object.prototype.hasOwnProperty.call(definition, key) &&
        !Object.prototype.hasOwnProperty.call(exports, key)
      ) {
        Object.defineProperty(exports, key, { enumerable: true, get: definition[key] });
      }
    }
  };
  __webpack_require__.o = (obj, prop) => Object.prototype.hasOwnProperty.call(obj, prop);
  __webpack_require__.r = (exports) => {
    if (typeof Symbol !== 'undefined' && Symbol.toStringTag) {
      Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });
    }
    Object.defineProperty(exports, '__esModule', { value: true });
  };
  __webpack_require__.e = () => Promise.resolve();
  __webpack_require__.g = globalThis;
  __webpack_require__.p = `${SITE_ORIGIN}/`;
  __webpack_require__.b = `${SITE_ORIGIN}/`;
  __webpack_require__.u = (id) => `${id}.js`;
  __webpack_require__.hmd = (m) => m;
  __webpack_require__.nmd = (m) => m;

  return __webpack_require__;
}

/**
 * Run one chunk source and return its signer, having made it produce a real
 * signature first. A chunk that loads but cannot sign is treated as unusable,
 * which is what makes "stale copy on disk" recoverable in load().
 */
async function instantiate(source) {
  const sandbox = buildSandbox();
  const modules = {};

  // Intercept the chunk's own `self.webpackChunk.push(...)`.
  sandbox.webpackChunk = {
    push([, moreModules]) {
      Object.assign(modules, moreModules);
    },
  };

  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: 'live_link_chunk.js' });

  const ids = Object.keys(modules);
  if (!ids.length) throw new Error('chunk did not register any modules');

  const __webpack_require__ = makeRequire(modules);
  // The signing module is the only one exporting a `default` promise.
  let signerPromise = null;
  for (const id of ids) {
    const exports = __webpack_require__(id);
    if (exports && typeof exports.default !== 'undefined') {
      signerPromise = exports.default;
      break;
    }
  }
  if (!signerPromise) throw new Error('no default export found in chunk modules');

  const signer = await signerPromise;
  if (typeof signer !== 'function') throw new Error('default export did not resolve to a function');

  const probe = await signer({ username: 'test' });
  if (!/^[0-9a-f]{64}$/.test((probe && probe._s) || '')) {
    throw new Error('chunk loaded but produced no valid signature');
  }
  return signer;
}

/**
 * Try each place the chunk can come from (disk, B2, the site) until one loads
 * and signs, then store it. A source that is empty, unreachable or holding a
 * stale copy is not fatal on its own — only running out of sources is, and the
 * error then names what every source said, since "no signer" has several very
 * different causes (nothing stored yet, site refuses this host, site redeployed).
 */
async function load(refresh) {
  const attempts = [];

  for (const source of chunk.sources({ refresh })) {
    let code;
    try {
      code = await source.load();
    } catch (err) {
      attempts.push(`${source.name}: ${err.message}`);
      continue;
    }
    if (!code) {
      attempts.push(`${source.name}: nothing stored`);
      continue;
    }

    try {
      const signer = await instantiate(code);
      await chunk.persist(code, source.name);
      return signer;
    } catch (err) {
      // Loaded but cannot sign: the site has redeployed since this copy was
      // taken, so its `_ts` build constant and secret are stale.
      attempts.push(`${source.name}: ${err.message}`);
      // eslint-disable-next-line no-console
      console.warn(`[anonyig] signing chunk from ${source.name} unusable (${err.message})`);
    }
  }

  // 503 rather than 500: nothing is broken in this service, it just has no
  // signer available — the operator has something to do about it.
  throw Object.assign(new Error(`no usable anonyig signing chunk — ${attempts.join(' · ')}`), {
    status: 503,
  });
}

let cached = null;
let pending = null;

/**
 * @param {object}  [opts]
 * @param {boolean} [opts.refresh] skip both caches and refetch the chunk — used
 *   when the hub rejects a signature, which means the site has redeployed.
 * @returns {Promise<(body: object|string) => Promise<object>>}
 *   async fn adding ts/_ts/_tsc/_sv/_s to a request body
 */
function getSigner({ refresh = false } = {}) {
  if (cached && !refresh) return Promise.resolve(cached);
  // Concurrent callers share one load; a refresh never settles for the result
  // of an in-flight plain load, since that is the signer it wants replaced.
  if (pending && (pending.refresh || !refresh)) return pending.promise;

  const entry = { refresh };
  entry.promise = load(refresh)
    .then((signer) => {
      cached = signer;
      return signer;
    })
    .finally(() => {
      if (pending === entry) pending = null;
    });
  pending = entry;
  return entry.promise;
}

/** Drop the in-process signer, so the next getSigner() reloads it. */
function resetSigner() {
  cached = null;
}

module.exports = { getSigner, resetSigner, SITE_ORIGIN, HOSTNAME };
