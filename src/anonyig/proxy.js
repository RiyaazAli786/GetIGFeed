'use strict';

/**
 * proxy.js — an HTTP/2 connection to the worker hub through an HTTP proxy.
 *
 * Why this exists: the hub answers `422 CAPTCHA_REQUIRED` (a Cloudflare
 * Turnstile challenge) to requests from addresses it distrusts — datacenter
 * ranges, which is exactly what a cloud host gives you. The same request from a
 * residential address is answered normally. Routing the hub traffic through a
 * proxy is therefore the fix, the same bargain the feed already makes for
 * Instagram's private API in ../services/webParameter.js.
 *
 * It cannot reuse that code, though: `https-proxy-agent` serves Node's
 * http/https stack, and the hub REQUIRES HTTP/2 (an HTTP/1.1 request is itself
 * answered with a captcha). So the tunnel is opened by hand —
 *
 *   CONNECT api-wh.anonyig.com:443  ->  TLS with ALPN "h2"  ->  http2.connect
 *
 * — and the resulting socket is handed to http2 via `createConnection`.
 */

const http = require('http');
const tls = require('tls');

/**
 * Normalise whatever a proxy was written as.
 *
 * Accepts everything /admin accepts, so a proxy is never valid in one place and
 * not the other:
 *
 *   host:port
 *   host:port:user:pass
 *   user:pass@host:port          (with or without an http:// prefix)
 *   http://user:pass@host:port   (percent-encoded credentials)
 *
 * ...and, unlike ../store/poolStore.parseProxyInput, keeps passwords that
 * themselves contain ':' or '@' intact rather than truncating them.
 *
 * Objects are taken directly — that is the shape the pool hands back, including
 * the Bright Data customer/zone username it assembles.
 *
 * @returns {?{host: string, port: number, username: string, password: string}}
 */
function parseProxy(input) {
  if (!input) return null;

  if (typeof input === 'object') {
    const host = input.host || input.proxyIp;
    const port = parseInt(input.port ?? input.proxyPort, 10);
    if (!host || !port) return null;
    return {
      host,
      port,
      username: input.username || input.proxyUsername || '',
      password: input.password || input.proxyPassword || '',
    };
  }

  const raw = String(input).trim();
  if (!raw) return null;

  // Percent-encoded credentials — the only form that survives a password
  // containing characters this notation uses as separators.
  if (/^https?:\/\//i.test(raw) && raw.includes('@')) {
    try {
      const url = new URL(raw);
      const port = parseInt(url.port, 10);
      if (!url.hostname || !port) return null;
      return {
        host: url.hostname,
        port,
        username: decodeURIComponent(url.username || ''),
        password: decodeURIComponent(url.password || ''),
      };
    } catch {
      return null;
    }
  }

  const bare = raw.replace(/^https?:\/\//i, '');

  // user:pass@host:port — split at the LAST '@', since a host cannot contain
  // one but a password can, and at the FIRST ':' of the credentials, since a
  // password can contain those too. (The pool's own parser splits on the first
  // '@' and the first ':', which truncates such passwords.)
  const at = bare.lastIndexOf('@');
  if (at !== -1) {
    const credentials = bare.slice(0, at);
    const [host, port] = splitHostPort(bare.slice(at + 1));
    // Only read it this way when what follows the '@' really is host:port;
    // otherwise the '@' belonged to a password in the delimited form below.
    if (host && port) {
      const colon = credentials.indexOf(':');
      return {
        host,
        port,
        username: colon === -1 ? credentials : credentials.slice(0, colon),
        password: colon === -1 ? '' : credentials.slice(colon + 1),
      };
    }
  }

  // host:port[:user:pass] — everything after the third separator is password.
  const parts = bare.split(':');
  const port = parseInt(parts[1], 10);
  if (parts.length < 2 || !parts[0] || !port) return null;
  return {
    host: parts[0],
    port,
    username: parts[2] || '',
    password: parts.slice(3).join(':') || '',
  };
}

function splitHostPort(value) {
  const parts = String(value).split(':');
  const port = parseInt(parts[1], 10);
  return [parts[0] || '', port || 0];
}

/** Enough of a username to recognise it, never enough to reuse it. */
const maskUser = (username) => {
  const value = String(username || '');
  if (!value) return '';
  return value.length <= 4 ? `${value.slice(0, 1)}***` : `${value.slice(0, 4)}***`;
};

/** For logs and /status — never includes the credentials. */
const describeProxy = (proxy) =>
  proxy ? `${proxy.host}:${proxy.port}${proxy.username ? ' (authenticated)' : ''}` : null;

/**
 * A proxy that will not carry the request is a gateway failure, not an internal
 * one — 502 with the reason intact, rather than a bare 500.
 */
const proxyError = (message) =>
  Object.assign(new Error(message), { status: 502, code: 'PROXY_FAILED' });

/**
 * Open a TLS socket to `target` through `proxy`, with h2 negotiated over ALPN.
 *
 * @param {{host: string, port: number, username: string, password: string}} proxy
 * @param {string} target  origin to reach, e.g. https://api-wh.anonyig.com
 * @param {number} timeout ms for the tunnel + handshake
 * @returns {Promise<import('tls').TLSSocket>}
 */
function connectThroughProxy(proxy, target, timeout = 20000) {
  const url = new URL(target);
  const port = parseInt(url.port, 10) || 443;

  return new Promise((resolve, reject) => {
    const headers = { host: `${url.hostname}:${port}` };
    if (proxy.username || proxy.password) {
      const auth = Buffer.from(`${proxy.username}:${proxy.password}`).toString('base64');
      headers['proxy-authorization'] = `Basic ${auth}`;
    }

    const req = http.request({
      host: proxy.host,
      port: proxy.port,
      method: 'CONNECT',
      path: `${url.hostname}:${port}`,
      headers,
      timeout,
      agent: false,
    });

    const fail = (err) => {
      req.destroy();
      reject(err);
    };

    req.on('error', (err) => reject(proxyError(`proxy ${describeProxy(proxy)}: ${err.message}`)));
    req.on('timeout', () => fail(proxyError(`proxy ${describeProxy(proxy)}: CONNECT timed out`)));

    req.on('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        // 407 is about the proxy's own auth, not the hub. Whether credentials
        // were even sent is the first thing to know, and it is not obvious from
        // the outside — a value entered as bare "host:port" fails exactly here.
        let why = '';
        if (res.statusCode === 407) {
          why = proxy.username
            ? ` — the proxy rejected the credentials for user "${maskUser(proxy.username)}"`
            : ' — no credentials were sent. Set ANONYIG_PROXY as "host:port:user:pass" or ' +
              '"http://user:pass@host:port" (percent-encode any @ or : inside the password), ' +
              "or allow-list this host's IP with your proxy provider";
        }
        return reject(
          proxyError(`proxy ${describeProxy(proxy)} refused CONNECT: HTTP ${res.statusCode}${why}`)
        );
      }

      socket.setTimeout(0);
      const tlsSocket = tls.connect(
        {
          socket,
          servername: url.hostname,
          // The hub only serves h2; a proxy that MITMs down to http/1.1 would
          // otherwise surface later as an unexplained CAPTCHA_REQUIRED.
          ALPNProtocols: ['h2'],
        },
        () => {
          if (tlsSocket.alpnProtocol !== 'h2') {
            tlsSocket.destroy();
            return reject(
              proxyError(
                `proxy ${describeProxy(proxy)} negotiated ` +
                  `"${tlsSocket.alpnProtocol || 'nothing'}" instead of h2 — the hub needs HTTP/2`
              )
            );
          }
          resolve(tlsSocket);
        }
      );
      tlsSocket.on('error', (err) =>
        reject(proxyError(`proxy ${describeProxy(proxy)}: TLS failed — ${err.message}`))
      );
    });

    req.end();
  });
}

module.exports = { parseProxy, describeProxy, maskUser, connectThroughProxy };
