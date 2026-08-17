'use strict';

/**
 * client.js — Node client for the FastDL worker-hub API.
 *
 * Interacts with: https://api-wh.fastdl.app/api/convert
 * Uses HTTP/2 transport and signs URLs using the FastDL signing chunk.
 */

const http2 = require('http2');
const zlib = require('zlib');
const config = require('./config');
const { getSigner } = require('./signer');
const { parseProxy, describeProxy, maskUser, connectThroughProxy } = require('../anonyig/proxy');

const BROWSER_HEADERS = {
  accept: 'application/json, text/plain, */*',
  'accept-encoding': 'gzip, deflate, br',
  'accept-language': 'en-US,en;q=0.9',
  origin: config.siteOrigin,
  referer: `${config.siteOrigin}/`,
  'user-agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36',
};

class FastDLError extends Error {
  constructor(message, { status, code, endpoint, body } = {}) {
    super(message);
    this.name = 'FastDLError';
    this.status = status;
    this.code = code;
    this.endpoint = endpoint;
    this.body = body;
  }
}

const isSignatureError = (err) =>
  err instanceof FastDLError && typeof err.code === 'string' && err.code.startsWith('REQUEST_SIGNATURE_');

function decompress(buf, encoding) {
  switch (encoding) {
    case 'gzip':
      return zlib.gunzipSync(buf);
    case 'br':
      return zlib.brotliDecompressSync(buf);
    case 'deflate':
      return zlib.inflateSync(buf);
    default:
      return buf;
  }
}

class FastDL {
  /**
   * @param {object} [opts]
   * @param {string} [opts.workerHub]
   * @param {number} [opts.timeout]
   * @param {string|object} [opts.proxy]
   */
  constructor({
    workerHub = config.workerHub,
    timeout = config.timeoutMs,
    proxy,
  } = {}) {
    this.workerHub = workerHub;
    this.timeout = timeout;
    this.proxyInput = proxy;

    this._session = null;
    this._connecting = null;
    this._pending = 0;
    this._loggedProxy = false;
  }

  _proxy() {
    if (this.proxyInput !== undefined) return parseProxy(this.proxyInput);
    if (config.proxy) return parseProxy(config.proxy);
    if (config.usePoolProxy) {
      const next = require('../store/poolStore').nextProxy();
      return next ? parseProxy(next) : null;
    }
    return null;
  }

  _poolProblem() {
    const stored = require('../store/poolStore').listProxies().length;
    if (!stored) return 'the proxy pool is empty — add one in /admin';
    return (
      `the pool holds ${stored} prox${stored === 1 ? 'y' : 'ies'} but none could be read — ` +
      'they were encrypted with a different ENCRYPTION_KEY'
    );
  }

  proxyInfo() {
    const source =
      this.proxyInput !== undefined
        ? 'client option'
        : config.proxy
          ? 'FASTDL_PROXY'
          : config.usePoolProxy
            ? 'proxy pool'
            : null;

    const proxy = this._proxy();
    if (!proxy) {
      let reason = 'not configured — the hub is reached directly';
      if (config.usePoolProxy && this.proxyInput === undefined) reason = this._poolProblem();
      else if (source) reason = `${source} is set but could not be parsed`;
      return { enabled: false, source, reason };
    }
    return {
      enabled: true,
      source,
      host: proxy.host,
      port: proxy.port,
      credentials: Boolean(proxy.username),
      username: proxy.username ? maskUser(proxy.username) : null,
    };
  }

  async _connect() {
    if (this._session && !this._session.closed && !this._session.destroyed) return this._session;
    if (!this._connecting) {
      this._connecting = this._createSession().finally(() => {
        this._connecting = null;
      });
    }
    return this._connecting;
  }

  async _createSession() {
    const proxy = this._proxy();
    const options = {};

    if (!proxy && this.proxyInput === undefined) {
      if (config.proxy) {
        throw Object.assign(
          new Error(
            `FASTDL_PROXY is set but could not be parsed — refusing to connect directly.`
          ),
          { status: 502, code: 'PROXY_MISCONFIGURED' }
        );
      }
      if (config.usePoolProxy) {
        console.warn(`[fastdl] FASTDL_USE_POOL_PROXY is set but ${this._poolProblem()} — connecting directly`);
      }
    }

    if (proxy) {
      const socket = await connectThroughProxy(proxy, this.workerHub, this.timeout);
      options.createConnection = () => socket;
      if (!this._loggedProxy) {
        this._loggedProxy = true;
        console.log(`[fastdl] tunnelling the worker hub through ${describeProxy(proxy)}`);
      }
    }

    const session = http2.connect(this.workerHub, options);
    session.on('error', () => {
      /* handled per-request */
    });
    session.unref();
    this._session = session;
    return session;
  }

  async _post(path, body) {
    const session = await this._connect();
    const isUrlEncoded = path === '/api/convert';
    const payload = Buffer.from(
      isUrlEncoded ? new URLSearchParams(body).toString() : JSON.stringify(body)
    );

    return new Promise((resolve, reject) => {
      if (this._pending++ === 0) session.ref();
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        if (--this._pending === 0) session.unref();
      };

      const req = session.request({
        ':method': 'POST',
        ':path': path,
        ...BROWSER_HEADERS,
        'content-type': isUrlEncoded ? 'application/x-www-form-urlencoded' : 'application/json',
        'content-length': payload.length,
      });
      req.setTimeout(this.timeout, () => req.destroy(new Error(`timeout after ${this.timeout} ms`)));

      let status = 0;
      let responseHeaders = {};
      const chunks = [];

      req.on('response', (h) => {
        status = h[':status'];
        responseHeaders = h;
      });
      req.on('data', (c) => chunks.push(c));
      req.on('error', (err) => {
        done();
        reject(new FastDLError(err.message, { endpoint: path }));
      });
      req.on('end', () => {
        done();
        let raw;
        try {
          raw = decompress(Buffer.concat(chunks), responseHeaders['content-encoding']);
        } catch (err) {
          return reject(
            new FastDLError(`could not decode response: ${err.message}`, { status, endpoint: path })
          );
        }
        const text = raw.toString('utf8');
        let json = null;
        try {
          json = JSON.parse(text);
        } catch {
          /* non-JSON */
        }

        if (status !== 200) {
          return reject(
            new FastDLError((json && (json.message || json.error)) || `HTTP ${status}`, {
              status,
              code: json && json.code,
              endpoint: path,
              body: json || text.slice(0, 500),
            })
          );
        }
        if (json && json.success === false) {
          return reject(
            new FastDLError(json.message || 'request failed', {
              status,
              code: json.response_type,
              endpoint: path,
              body: json,
            })
          );
        }
        resolve(json);
      });

      req.write(payload);
      req.end();
    });
  }

  async _signedPost(path, body) {
    try {
      const signer = await getSigner();
      const signedBody = await signer(body);
      return await this._post(path, signedBody);
    } catch (err) {
      if (!isSignatureError(err)) throw err;
      console.warn(`[fastdl] ${err.code} — refreshing the signing chunk and retrying`);
      const signer = await getSigner({ refresh: true });
      const signedBody = await signer(body);
      return await this._post(path, signedBody);
    }
  }

  /**
   * Fetch all media items for the given Instagram URL.
   * @param {string} url Instagram Post/Reels/Stories/Highlights URL
   */
  async convert(url) {
    return this._signedPost('/api/convert', url);
  }

  call(endpoint, body) {
    return this._signedPost(`/api/v1/instagram/${endpoint}`, body);
  }

  userInfo(handle) {
    return this.call('userInfo', { username: String(handle || '').trim().replace(/^@/, '') });
  }

  postsPage(handle, maxId = '') {
    return this.call('postsV2', { username: String(handle || '').trim().replace(/^@/, ''), maxId });
  }

  storiesRaw(handle) {
    return this.call('stories', { username: String(handle || '').trim().replace(/^@/, '') });
  }

  highlightsRaw(userId) {
    return this.call('highlights', { userId: String(userId) });
  }

  highlightStoriesRaw(highlightId) {
    const asHighlightId = (id) => (String(id).startsWith('highlight:') ? String(id) : `highlight:${id}`);
    return this.call('highlightStories', { highlightId: asHighlightId(highlightId) });
  }


  /** Reachability probe for diagnostics */
  async probe() {
    const proxy = describeProxy(this._proxy());
    try {
      // Unsigned post to convert should trigger 401 signature missing
      await this._post('/api/convert', { sf_url: 'probe' });
      return { reachable: true, challenged: false, status: 200, proxy };
    } catch (err) {
      if (err instanceof FastDLError && err.status) {
        return {
          reachable: true,
          challenged: err.code === 'CAPTCHA_REQUIRED',
          status: err.status,
          code: err.code || null,
          proxy,
        };
      }
      return { reachable: false, challenged: false, error: err.message, proxy };
    }
  }

  close() {
    if (this._session && !this._session.destroyed) this._session.close();
    this._session = null;
    this._connecting = null;
  }
}

module.exports = {
  FastDL,
  FastDLError,
  isSignatureError,
};
