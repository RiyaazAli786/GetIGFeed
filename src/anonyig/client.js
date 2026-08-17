'use strict';

/**
 * client.js — Node client for the anonyig worker-hub Instagram API.
 *
 * Covers everything the site's profile page loads for a public handle:
 *   user info · posts · reels · stories · highlights (with each highlight's
 *   stories fetched automatically, no second call from the caller)
 *
 *   const { AnonyIG } = require('./client');
 *   const ig = new AnonyIG();
 *   try {
 *     const profile = await ig.getEverything('nasa');
 *   } finally {
 *     ig.close();
 *   }
 *
 * Transport notes that matter:
 *   - Requests MUST go over HTTP/2. The identical signed request over HTTP/1.1
 *     is answered 422 CAPTCHA_REQUIRED, which is why this does not use the
 *     shared ../utils/httpFetch.js.
 *   - Every body is signed by the site's own chunk via ./signer.js.
 *   - One h2 session is reused for all calls, the way the browser multiplexes
 *     userInfo / postsV2 / stories / highlights over a single connection.
 */

const http2 = require('http2');
const zlib = require('zlib');
const config = require('./config');
const { getSigner } = require('./signer');
const { parseProxy, describeProxy, maskUser, connectThroughProxy } = require('./proxy');

const BROWSER_HEADERS = {
  accept: 'application/json, text/plain, */*',
  'accept-encoding': 'gzip, deflate, br',
  'accept-language': 'en-GB,en-US;q=0.9,en;q=0.8',
  'content-type': 'application/json',
  origin: config.siteOrigin,
  priority: 'u=1, i',
  referer: `${config.siteOrigin}/`,
  'sec-ch-ua': '"Not=A?Brand";v="99", "Google Chrome";v="151", "Chromium";v="151"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"Windows"',
  'sec-fetch-dest': 'empty',
  'sec-fetch-mode': 'cors',
  'sec-fetch-site': 'same-site',
  'user-agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36',
};

class AnonyIGError extends Error {
  constructor(message, { status, code, endpoint, body } = {}) {
    super(message);
    this.name = 'AnonyIGError';
    this.status = status;
    this.code = code;
    this.endpoint = endpoint;
    this.body = body;
  }
}

/**
 * The hub answers 401 REQUEST_SIGNATURE_* when the signing chunk is stale — the
 * site redeployed and both its `_ts` build constant and secret moved on.
 */
const isSignatureError = (err) =>
  err instanceof AnonyIGError && typeof err.code === 'string' && err.code.startsWith('REQUEST_SIGNATURE_');

/** Run `fn` over `items` with at most `limit` in flight, preserving order. */
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

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

const stripAt = (handle) => String(handle || '').trim().replace(/^@/, '');

/** highlightStories only returns items for the prefixed form the API hands out. */
const asHighlightId = (id) => (String(id).startsWith('highlight:') ? String(id) : `highlight:${id}`);
const highlightNumericId = (id) => String(id).replace(/^highlight:/, '');

class AnonyIG {
  /**
   * @param {object}  [opts]
   * @param {string}  [opts.workerHub]    API origin
   * @param {number}  [opts.concurrency]  parallel requests for fan-out (highlights)
   * @param {number}  [opts.timeout]      per-request timeout in ms
   * @param {number}  [opts.userCacheTtl] profile-header cache lifetime in ms (0 disables)
   * @param {string|object} [opts.proxy]  tunnel the hub through this proxy;
   *   omit to follow ANONYIG_PROXY / ANONYIG_USE_POOL_PROXY, pass null to force direct
   * @param {string}  [opts.whToken]      optional wh-cf-token header
   * @param {string}  [opts.xToken]       optional x-token header
   */
  constructor({
    workerHub = config.workerHub,
    concurrency = config.concurrency,
    timeout = config.timeoutMs,
    userCacheTtl = config.userCacheTtlMs,
    proxy,
    whToken = config.whToken,
    xToken = config.xToken,
  } = {}) {
    this.workerHub = workerHub;
    this.concurrency = concurrency;
    this.timeout = timeout;
    this.userCacheTtl = userCacheTtl;
    // Kept as given (including an explicit null) so "force direct" is
    // distinguishable from "not specified, follow the env".
    this.proxyInput = proxy;
    this.extraHeaders = {};
    if (whToken) this.extraHeaders['wh-cf-token'] = whToken;
    if (xToken) this.extraHeaders['x-token'] = xToken;

    this._session = null;
    this._connecting = null;
    this._pending = 0;
    this._loggedProxy = false;
    this._userCache = new Map();
  }

  // ---------------------------------------------------------------- transport

  /** The proxy to tunnel through, or null for a direct connection. */
  _proxy() {
    if (this.proxyInput !== undefined) return parseProxy(this.proxyInput);
    if (config.proxy) return parseProxy(config.proxy);
    if (config.usePoolProxy) {
      // Round-robin out of the encrypted pool, the same source the feed draws
      // from. Resolved per connection, so a dead proxy is not sticky forever.
      const next = require('../store/poolStore').nextProxy();
      return next ? parseProxy(next) : null;
    }
    return null;
  }

  /**
   * Why pool mode produced no proxy — an empty pool and entries that will not
   * decrypt (an ENCRYPTION_KEY that no longer matches the one they were stored
   * with) are the same silent `null` otherwise.
   */
  _poolProblem() {
    const stored = require('../store/poolStore').listProxies().length;
    if (!stored) return 'the proxy pool is empty — add one in /admin';
    return (
      `the pool holds ${stored} prox${stored === 1 ? 'y' : 'ies'} but none could be read — ` +
      'they were encrypted with a different ENCRYPTION_KEY, so re-add them in /admin'
    );
  }

  /**
   * How this client will reach the hub. For diagnostics only — it reports
   * whether credentials were parsed out of the configured value, which is the
   * difference between a proxy that tunnels and one that answers 407, and never
   * reveals them.
   */
  proxyInfo() {
    const source =
      this.proxyInput !== undefined
        ? 'client option'
        : config.proxy
          ? 'ANONYIG_PROXY'
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

  /**
   * The shared h2 session, opened on first use. Async because a proxied
   * connection has to complete its CONNECT tunnel and TLS handshake before
   * http2 can be handed the socket.
   */
  async _connect() {
    if (this._session && !this._session.closed && !this._session.destroyed) return this._session;
    // Concurrent callers must not each open their own session.
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
      // An explicitly configured proxy that does not parse must not degrade into
      // a direct connection: that silently sends the traffic from the address
      // the proxy was there to avoid, and the captcha it earns then looks like
      // the proxy failing to help rather than never being used.
      if (config.proxy) {
        throw Object.assign(
          new Error(
            `ANONYIG_PROXY is set but could not be parsed ("${String(config.proxy).slice(0, 24)}…") — ` +
              'expected "host:port:user:pass" or "http://user:pass@host:port". ' +
              'Refusing to connect directly instead.'
          ),
          { status: 502, code: 'PROXY_MISCONFIGURED' }
        );
      }
      // An empty pool is a transient state rather than a typo, so that one only
      // warns and goes direct.
      if (config.usePoolProxy) {
        // eslint-disable-next-line no-console
        console.warn(`[anonyig] ANONYIG_USE_POOL_PROXY is set but ${this._poolProblem()} — connecting directly`);
      }
    }

    if (proxy) {
      const socket = await connectThroughProxy(proxy, this.workerHub, this.timeout);
      options.createConnection = () => socket;
      if (!this._loggedProxy) {
        this._loggedProxy = true;
        // eslint-disable-next-line no-console
        console.log(`[anonyig] tunnelling the worker hub through ${describeProxy(proxy)}`);
      }
    }

    const session = http2.connect(this.workerHub, options);
    session.on('error', () => {
      /* surfaced per-request; a dead session is replaced on next call */
    });
    // Idle sessions must not hold the process open — ref'd only while in flight.
    session.unref();
    this._session = session;
    return session;
  }

  /** POST a pre-signed body and return parsed JSON. */
  async _post(path, body, headers = {}) {
    const session = await this._connect();
    const payload = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));

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
        ...this.extraHeaders,
        ...headers,
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
        reject(new AnonyIGError(err.message, { endpoint: path }));
      });
      req.on('end', () => {
        done();
        let raw;
        try {
          raw = decompress(Buffer.concat(chunks), responseHeaders['content-encoding']);
        } catch (err) {
          return reject(
            new AnonyIGError(`could not decode response: ${err.message}`, { status, endpoint: path })
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
            new AnonyIGError((json && (json.message || json.error)) || `HTTP ${status}`, {
              status,
              code: json && json.code,
              endpoint: path,
              body: json || text.slice(0, 500),
            })
          );
        }
        if (json && json.success === false) {
          return reject(
            new AnonyIGError(json.message || 'request failed', {
              status,
              code: json.response_type,
              endpoint: path,
              body: json,
            })
          );
        }
        resolve(json);
      });

      req.end(payload);
    });
  }

  /**
   * Sign `body` and POST it. A signature rejection is retried once against a
   * freshly downloaded chunk: the site redeploys on its own schedule, and a
   * long-running server would otherwise fail every call until restarted.
   */
  async _signedPost(path, body) {
    try {
      return await this._post(path, await (await getSigner())(body));
    } catch (err) {
      if (!isSignatureError(err)) throw err;
      // eslint-disable-next-line no-console
      console.warn(`[anonyig] ${err.code} — refreshing the signing chunk and retrying`);
      return this._post(path, await (await getSigner({ refresh: true }))(body));
    }
  }

  /** Sign `body` and POST it to an Instagram endpoint on the worker hub. */
  call(endpoint, body) {
    return this._signedPost(`/api/v1/instagram/${endpoint}`, body);
  }

  /**
   * Reachability check for the worker hub, without needing a signer.
   *
   * The request is deliberately unsigned, so a hub that is reachable answers
   * `401 REQUEST_SIGNATURE_MISSING_REQUIRED_PARAMETERS`. Any HTTP status at all
   * proves the connection got through; only a transport error means blocked.
   */
  async probe() {
    const proxy = describeProxy(this._proxy());
    try {
      await this._post('/api/v1/instagram/userInfo', { username: 'probe' });
      return { reachable: true, challenged: false, status: 200, proxy };
    } catch (err) {
      // Only an AnonyIGError carries a status the HUB produced. A proxy or
      // transport failure also has a status attached, and reading that as a hub
      // response would report a proxy that never connected as "hub reachable".
      if (err instanceof AnonyIGError && err.status) {
        return {
          reachable: true,
          // Reachable but refusing to serve this address: the hub wants a
          // Turnstile token, which is what a datacenter IP gets.
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

  // ------------------------------------------------------------ raw endpoints

  userInfo(handle) {
    return this.call('userInfo', { username: stripAt(handle) });
  }
  profileRaw(handle) {
    return this.call('profile', { username: stripAt(handle) });
  }
  postsPage(handle, maxId = '') {
    return this.call('postsV2', { username: stripAt(handle), maxId });
  }
  postsPageV1(handle, maxId = '') {
    return this.call('posts', { username: stripAt(handle), maxId });
  }
  storiesRaw(handle) {
    return this.call('stories', { username: stripAt(handle) });
  }
  storyByUrl(url) {
    return this.call('story', { url });
  }
  highlightsRaw(userId) {
    return this.call('highlights', { userId: String(userId) });
  }
  highlightStoriesRaw(highlightId) {
    return this.call('highlightStories', { highlightId: asHighlightId(highlightId) });
  }
  usernameSuggestions(query) {
    return this.call('usernameSuggestions', { query: stripAt(query) });
  }
  convert(targetUrl) {
    return this._signedPost('/api/convert', { target_url: targetUrl });
  }

  // ------------------------------------------------------------- high level

  /**
   * Profile header: the same fields the site's UserInfo component shows.
   *
   * Cached for `userCacheTtl`, because getHighlights() and getEverything() both
   * resolve the handle through here before anything else.
   */
  async getUser(handle) {
    const username = stripAt(handle).toLowerCase();
    const hit = this._userCache.get(username);
    if (hit && Date.now() - hit.at < this.userCacheTtl) return hit.user;

    const payload = await this.userInfo(username);
    const user = payload?.result?.[0]?.user;
    if (!user) {
      // The hub answers 200 with an empty result for a handle that does not
      // exist; ./service.js turns this code into a 404.
      throw new AnonyIGError(`no user data for "${username}"`, {
        code: 'USER_NOT_FOUND',
        endpoint: 'userInfo',
        body: payload,
      });
    }

    const normalized = normalizeUser(user);
    if (this.userCacheTtl > 0) {
      // Bounded: this runs for the life of the process, and the cache exists to
      // spare the fan-out a lookup, not to be a store.
      if (this._userCache.size >= 500) this._userCache.clear();
      this._userCache.set(username, { user: normalized, at: Date.now() });
    }
    return normalized;
  }

  /**
   * Posts tab. `pages` follows `end_cursor` pagination; 1 page is ~12 items.
   * @returns {Promise<{items: object[], pageInfo: object, pages: number, count: number}>}
   */
  async getPosts(handle, { pages = 1, maxId = '' } = {}) {
    const username = stripAt(handle);
    const items = [];
    let cursor = maxId;
    let pageInfo = null;
    let fetched = 0;

    for (let i = 0; i < pages; i++) {
      const payload = await this.postsPage(username, cursor);
      const result = payload?.result;
      if (!result) break;
      fetched++;
      items.push(...(result.edges || []).flatMap(normalizePostEdge));
      pageInfo = result.page_info || null;
      if (!pageInfo?.has_next_page || !pageInfo.end_cursor) break;
      cursor = pageInfo.end_cursor;
    }

    return { items, pageInfo, pages: fetched, count: items.length };
  }

  /**
   * Reels tab. The site has no reels endpoint — it requests the same posts feed
   * and keeps the entries carrying a downloadable video URL
   * (`Qv = e => e.filter(e => e.downloadableVideoUrl)` in the bundle).
   */
  async getReels(handle, { pages = 1 } = {}) {
    const { items, pageInfo, pages: fetched } = await this.getPosts(handle, { pages });
    const reels = items.filter((item) => item.videoUrl);
    return { items: reels, pageInfo, pages: fetched, count: reels.length };
  }

  /** Stories tab. Empty array when the account has no active stories. */
  async getStories(handle) {
    const payload = await this.storiesRaw(handle);
    const items = (payload?.result || []).map(normalizeStoryItem);
    return { items, count: items.length };
  }

  /**
   * Highlights tab.
   *
   * Each highlight's stories are fetched as part of this call — the caller never
   * issues a separate highlightStories request. Resolution:
   *   userInfo(handle) -> user.pk -> highlights(userId) -> highlightStories(id) per highlight
   * The per-highlight fan-out runs `concurrency` requests at a time.
   *
   * @param {object}  [opts]
   * @param {boolean} [opts.withItems=true] set false for covers/titles only
   */
  async getHighlights(handle, { withItems = true, concurrency = this.concurrency } = {}) {
    const user = await this.getUser(handle);
    const payload = await this.highlightsRaw(user.id);
    const highlights = (payload?.result || []).map(normalizeHighlight);

    if (!withItems || !highlights.length) {
      return { items: highlights, count: highlights.length };
    }

    await mapLimit(highlights, concurrency, async (highlight) => {
      try {
        const stories = await this.highlightStoriesRaw(highlight.id);
        highlight.items = (stories?.result || []).map(normalizeStoryItem);
        highlight.count = highlight.items.length;
      } catch (err) {
        // One bad highlight must not sink the whole tab.
        highlight.items = [];
        highlight.count = 0;
        highlight.error = err.message;
      }
    });

    return { items: highlights, count: highlights.length };
  }

  /**
   * Everything the profile page shows, in one call: user + all four tabs, with
   * highlight stories already resolved.
   *
   * Tabs are fetched concurrently over the shared h2 session. A tab that fails
   * (private account, no stories) is reported in `errors` rather than thrown, so
   * a partial profile still comes back.
   */
  async getEverything(handle, { pages = 1, withHighlightItems = true } = {}) {
    const username = stripAt(handle);
    const user = await this.getUser(username);

    const tabs = {
      posts: () => this.getPosts(username, { pages }),
      stories: () => this.getStories(username),
      highlights: () => this.getHighlights(username, { withItems: withHighlightItems }),
    };

    const errors = {};
    const settled = await Promise.all(
      Object.entries(tabs).map(async ([name, run]) => {
        try {
          return [name, await run()];
        } catch (err) {
          errors[name] = err.message;
          return [name, { items: [], count: 0 }];
        }
      })
    );
    const out = Object.fromEntries(settled);

    // Reels reuse the posts payload — no extra request.
    const reels = out.posts.items.filter((item) => item.videoUrl);

    return {
      user,
      posts: out.posts,
      reels: { items: reels, count: reels.length, pageInfo: out.posts.pageInfo },
      stories: out.stories,
      highlights: out.highlights,
      errors: Object.keys(errors).length ? errors : null,
      fetchedAt: new Date().toISOString(),
    };
  }
}

// ------------------------------------------------------------- normalizers
// Field mapping mirrors the bundle's own mappers; `*_wrapped` URLs are the
// proxied ones the site renders, `*_downloadable` are the attachment variants.
// Both carry a short-lived __sig/__expires pair on media.anonyig.com.

function normalizeUser(user) {
  return {
    id: user.pk ?? user.id ?? null,
    username: user.username,
    fullName: user.full_name ?? null,
    biography: user.biography ?? null,
    isPrivate: !!user.is_private,
    isVerified: !!user.is_verified,
    followers: user.follower_count ?? user.edge_followed_by?.count ?? null,
    following: user.following_count ?? user.edge_follow?.count ?? null,
    postCount: user.media_count ?? user.edge_owner_to_timeline_media?.count ?? null,
    externalUrl: user.external_url ?? null,
    category: user.category ?? null,
    profilePic: user.profile_pic_url_hd ?? user.profile_pic_url ?? null,
    profilePicProxied: user.profile_pic_url_wrapped ?? null,
  };
}

/** A post edge; carousels expand into one entry per child. */
function normalizePostEdge(edge) {
  const node = edge?.node;
  if (!node) return [];
  const children = node.edge_sidecar_to_children?.edges;
  if (children?.length) {
    return children.map((child, i) => ({
      ...normalizePostNode(child.node, node),
      carouselIndex: i + 1,
      carouselCount: children.length,
    }));
  }
  return [normalizePostNode(node, node)];
}

function normalizePostNode(node, parent) {
  const best = node.display_resources?.[node.display_resources.length - 1] || {};
  return {
    id: node.id ?? null,
    shortcode: parent.shortcode ?? node.shortcode ?? shortcodeFromId(node.id),
    url: (parent.shortcode ?? node.shortcode)
      ? `https://www.instagram.com/p/${parent.shortcode ?? node.shortcode}/`
      : null,
    type: node.__typename ?? null,
    productType: node.product_type ?? parent.product_type ?? null,
    isVideo: !!node.is_video,
    caption: parent.edge_media_to_caption?.edges?.[0]?.node?.text ?? null,
    takenAt: parent.taken_at_timestamp ? parent.taken_at_timestamp * 1000 : null,
    likeCount: parent.edge_media_preview_like?.count ?? null,
    commentCount: parent.edge_media_to_comment?.count ?? null,
    viewCount: node.video_view_count ?? null,
    width: node.dimensions?.width ?? best.config_width ?? null,
    height: node.dimensions?.height ?? best.config_height ?? null,
    imageUrl: node.display_url ?? best.src ?? null,
    imageUrlProxied: best.url_wrapped ?? null,
    imageUrlDownload: best.url_downloadable ?? null,
    videoUrl: node.video_url_downloadable ?? node.video_url ?? null,
    videoUrlProxied: node.video_url_wrapped ?? null,
    carouselIndex: null,
    carouselCount: null,
  };
}

/** stories and highlightStories return the same item shape. */
function normalizeStoryItem(item) {
  const image = item.image_versions2?.candidates?.[0] || {};
  const video = item.video_versions?.[0] || null;
  return {
    id: item.pk ?? null,
    takenAt: item.taken_at ? item.taken_at * 1000 : null,
    isVideo: !!video,
    hasAudio: !!item.has_audio,
    width: item.original_width ?? image.width ?? null,
    height: item.original_height ?? image.height ?? null,
    imageUrl: image.url ?? null,
    imageUrlProxied: image.url_wrapped ?? null,
    imageUrlDownload: image.url_downloadable ?? null,
    videoUrl: video?.url ?? null,
    videoUrlProxied: video?.url_wrapped ?? null,
    videoUrlDownload: video?.url_downloadable ?? null,
  };
}

function normalizeHighlight(highlight) {
  const cover = highlight.cover_media?.cropped_image_version || {};
  return {
    id: highlight.id,
    highlightId: highlightNumericId(highlight.id),
    title: highlight.title ?? null,
    coverUrl: cover.url ?? null,
    coverUrlProxied: cover.url_wrapped ?? null,
    items: [],
    count: 0,
  };
}

/** Instagram media id -> shortcode, for payloads that omit it. */
function shortcodeFromId(id) {
  if (!id || !/^\d+$/.test(String(id))) return null;
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  let n = BigInt(id);
  let out = '';
  while (n > 0n) {
    out = alphabet[Number(n % 64n)] + out;
    n /= 64n;
  }
  return out || null;
}

module.exports = {
  AnonyIG,
  AnonyIGError,
  isSignatureError,
  normalizeUser,
  normalizePostEdge,
  normalizeStoryItem,
  normalizeHighlight,
  shortcodeFromId,
};
