'use strict';

/**
 * signer.js — loads FastDL's request-signing chunk inside a minimal browser
 * shim and returns the signing function it exports.
 *
 * It mirrors the anonyig sandboxed signer, but customizes locations and Clock
 * fetch shims for fastdl.app.
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
  sandbox.top = sandbox;
  sandbox.parent = sandbox;
  return sandbox;
}

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

async function instantiate(source) {
  const sandbox = buildSandbox();
  const modules = {};

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

  // Verify that it signs a string input correctly
  const probe = await signer('test');
  if (!/^[0-9a-f]{64}$/.test((probe && probe._s) || '')) {
    throw new Error('chunk loaded but produced no valid signature');
  }
  return signer;
}

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
      attempts.push(`${source.name}: ${err.message}`);
      console.warn(`[fastdl] signing chunk from ${source.name} unusable (${err.message})`);
    }
  }

  throw Object.assign(new Error(`no usable fastdl signing chunk — ${attempts.join(' · ')}`), {
    status: 503,
  });
}

let cached = null;
let pending = null;

function getSigner({ refresh = false } = {}) {
  if (cached && !refresh) return Promise.resolve(cached);
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

function resetSigner() {
  cached = null;
}

module.exports = { getSigner, resetSigner, SITE_ORIGIN, HOSTNAME };
