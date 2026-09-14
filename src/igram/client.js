'use strict';

/**
 * HTTP/2 client for IGram's profile-viewer worker hub. Its public profile UI
 * calls these endpoints directly: userInfo, postsV2, stories, highlights and
 * highlightStories. It is separate from FastDL's signing-chunk flow and can
 * optionally receive a captcha token through IGRAM_X_TOKEN.
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

class IGramError extends Error {
  constructor(message, { status, code, endpoint, body } = {}) {
    super(message);
    this.name = 'IGramError';
    this.status = status;
    this.code = code;
    this.endpoint = endpoint;
    this.body = body;
  }
}

const isSignatureError = (err) => {
  if (!err) return false;
  if (!(err instanceof IGramError)) return false;
  if (err.status === 401) return true;
  const code = String(err.code || '').toUpperCase();
  const msg = String(err.message || '').toUpperCase();
  return (
    code.startsWith('REQUEST_SIGNATURE_') ||
    code.includes('SIGNATURE') ||
    code.includes('EXPIRED') ||
    msg.includes('SIGNATURE') ||
    msg.includes('EXPIRED')
  );
};

const decompress = (buf, encoding) => {
  if (encoding === 'gzip') return zlib.gunzipSync(buf);
  if (encoding === 'br') return zlib.brotliDecompressSync(buf);
  if (encoding === 'deflate') return zlib.inflateSync(buf);
  return buf;
};

const username = (value) => String(value || '').trim().replace(/^@/, '');
const asHighlightId = (value) => {
  const id = String(value || '');
  return id.startsWith('highlight:') ? id : `highlight:${id}`;
};

class IGram {
  constructor({ workerHub = config.workerHub, timeout = config.timeoutMs, proxy, xToken = process.env.IGRAM_X_TOKEN } = {}) {
    this.workerHub = workerHub.replace(/\/$/, '');
    this.timeout = timeout;
    this.proxyInput = proxy;
    this.extraHeaders = xToken ? { 'x-token': xToken } : {};
    this.source = 'igram';
    this.ErrorType = IGramError;
    this.concurrency = 4;
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
    return stored ? 'no readable proxy is available from the pool' : 'the proxy pool is empty — add one in /admin';
  }

  proxyInfo() {
    const source = this.proxyInput !== undefined ? 'client option' : config.proxy ? 'IGRAM_PROXY' : config.usePoolProxy ? 'proxy pool' : null;
    const proxy = this._proxy();
    if (!proxy) {
      return { enabled: false, source, reason: config.usePoolProxy ? this._poolProblem() : 'not configured — the hub is reached directly' };
    }
    return { enabled: true, source, host: proxy.host, port: proxy.port, credentials: Boolean(proxy.username), username: proxy.username ? maskUser(proxy.username) : null };
  }

  async _connect() {
    if (this._session && !this._session.closed && !this._session.destroyed) return this._session;
    if (!this._connecting) this._connecting = this._createSession().finally(() => { this._connecting = null; });
    return this._connecting;
  }

  async _createSession() {
    const proxy = this._proxy();
    if (!proxy && config.proxy && this.proxyInput === undefined) {
      throw Object.assign(new Error('IGRAM_PROXY is set but could not be parsed — refusing to connect directly.'), { status: 502, code: 'PROXY_MISCONFIGURED' });
    }
    const options = {};
    if (proxy) {
      if (!this._loggedProxy) {
        this._loggedProxy = true;
        console.log(`[igram] tunnelling the worker hub through ${describeProxy(proxy)}`);
      }
    }
    // connectThroughProxy is asynchronous, so resolve it before creating h2.
    if (proxy) {
      const socket = await connectThroughProxy(proxy, this.workerHub, this.timeout);
      options.createConnection = () => socket;
    }
    const session = http2.connect(this.workerHub, options);
    session.on('error', () => {});
    session.unref();
    this._session = session;
    return session;
  }

  async _post(path, body) {
    const session = await this._connect();
    const payload = Buffer.from(JSON.stringify(body));
    return new Promise((resolve, reject) => {
      if (this._pending++ === 0) session.ref();
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        if (--this._pending === 0) session.unref();
      };
      const req = session.request({
        ':method': 'POST', ':path': path, ...BROWSER_HEADERS, ...this.extraHeaders,
        'content-type': 'application/json', 'content-length': payload.length,
      });
      req.setTimeout(this.timeout, () => req.destroy(new Error(`timeout after ${this.timeout} ms`)));
      let status = 0;
      let headers = {};
      const chunks = [];
      req.on('response', (responseHeaders) => { status = responseHeaders[':status']; headers = responseHeaders; });
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('error', (err) => { done(); reject(new IGramError(err.message, { endpoint: path })); });
      req.on('end', () => {
        done();
        let text;
        try { text = decompress(Buffer.concat(chunks), headers['content-encoding']).toString('utf8'); }
        catch (err) { return reject(new IGramError(`could not decode response: ${err.message}`, { status, endpoint: path })); }
        let json;
        try { json = JSON.parse(text); } catch { json = null; }
        if (status < 200 || status >= 300 || json?.success === false) {
          return reject(new IGramError(json?.message || json?.error || `HTTP ${status}`, {
            status, code: json?.code || json?.response_type, endpoint: path, body: json || text.slice(0, 500),
          }));
        }
        resolve(json);
      });
      req.end(payload);
    });
  }

  async _signedPost(path, body) {
    try {
      const signer = await getSigner();
      const signedBody = await signer(body);
      return await this._post(path, signedBody);
    } catch (err) {
      if (!isSignatureError(err)) throw err;
      console.warn(
        `[igram] ${err.code || err.message || `HTTP ${err.status}`} — signing chunk expired/rejected; fetching fresh from site and mirroring to B2`
      );
      const signer = await getSigner({ refresh: true });
      const signedBody = await signer(body);
      return await this._post(path, signedBody);
    }
  }

  call(endpoint, body) { return this._signedPost(`/api/v1/instagram/${endpoint}`, body); }
  convert(url) { return this._signedPost('/api/convert', { url }); }
  userInfo(handle) { return this.call('userInfo', { username: username(handle) }); }
  postsPage(handle, maxId = '') { return this.call('postsV2', { username: username(handle), maxId }); }
  storiesRaw(handle) { return this.call('stories', { username: username(handle) }); }
  highlightsRaw(userId) { return this.call('highlights', { userId: String(userId) }); }
  highlightStoriesRaw(highlightId) { return this.call('highlightStories', { highlightId: asHighlightId(highlightId) }); }

  async probe() {
    const proxy = describeProxy(this._proxy());
    try {
      await this.userInfo('instagram');
      return { reachable: true, challenged: false, status: 200, proxy };
    } catch (err) {
      if (err instanceof IGramError && err.status) return { reachable: true, challenged: err.status === 422 || err.code === 'CAPTCHA_REQUIRED', status: err.status, code: err.code || null, proxy };
      return { reachable: false, challenged: false, error: err.message, proxy };
    }
  }

  close() {
    if (this._session && !this._session.destroyed) this._session.close();
    this._session = null;
    this._connecting = null;
  }
}

module.exports = { IGram, IGramError, isSignatureError };
