'use strict';

const { getUserFeed } = require('../services/instagram.service');
const poolStore = require('../store/poolStore');
const { logFeedAsync } = require('../store/feedLog');

const FEED_CACHE_DEFAULT =
  String(process.env.FEED_CACHE_DEFAULT || 'false').toLowerCase() === 'true';

/**
 * POST /api/user-feed
 *
 * You do NOT need a full dominatorAccount. Provide whichever you have:
 *
 * Body:
 * {
 *   "userId": "7425066841",        // required
 *
 *   // --- pick ONE auth source (or none, to use the stored pool) ---
 *   "authToken": "<sessionid>",    // just an auth token
 *   "proxy": "ip:port:user:pass",  // string or object; optional
 *   "csrfToken": "...",            // optional, pairs with authToken
 *   // or:
 *   "dominatorAccount": { ... },   // full account object (legacy)
 *
 *   "maxId": null,                 // optional
 *   "minTimestamp": null,          // optional passthrough
 *   "isNewBrowser": false,         // optional passthrough
 *
 *   // --- stories & highlights (merged into the same response) ---
 *   "includeStories": true,          // default from FEED_INCLUDE_STORIES
 *   "includeHighlightDetails": true, // expand each highlight bubble
 *   "highlightDetailLimit": 10       // 0 = every highlight
 * }
 *
 * Resolution order for auth/proxy:
 *   dominatorAccount → { authToken, proxy } → encrypted pool (round-robin).
 *
 * Works as POST (JSON body) or GET (query string / `:userId` path param). For
 * GET, params come from the URL, e.g.
 *   GET /api/user-feed?userId=123&proxy=ip:port
 *   GET /api/user-feed/123
 * Complex values (a full dominatorAccount, a proxy object) require POST.
 */
async function postUserFeed(req, res, next) {
  try {
    // Merge sources so one handler serves GET and POST. Body wins over query,
    // query over path params.
    const src = { ...(req.params || {}), ...(req.query || {}), ...(req.body || {}) };
    const {
      dominatorAccount,
      authToken,
      sessionid,
      token,
      csrfToken,
      proxy,
      userId,
      maxId,
      max_id,
      minTimestamp = null,
      isNewBrowser = false,
      includeStories,
      includeStoryHighlights,
      includeHighlightDetails,
      highlightDetailLimit,
      fresh,
      bypassCache,
      useCache,
      cache,
    } = src;
    const feedMaxId = maxId ?? max_id ?? null;

    if (!userId) {
      return res
        .status(400)
        .json({ success: false, error: 'userId is required.' });
    }

    // Decide the account to use, in priority order. Only treat dominatorAccount
    // as an account when it's an object (a GET query could make it a string).
    let account =
      dominatorAccount && typeof dominatorAccount === 'object'
        ? dominatorAccount
        : null;
    const inlineAuth = authToken || sessionid || token;
    if (!account && (inlineAuth || proxy)) {
      account = poolStore.buildAccount({
        authToken: inlineAuth,
        csrfToken,
        proxy,
      });
    }

    // If still nothing and the pool is empty, there is no way to authenticate.
    if (!account && poolStore.listSessions().length === 0) {
      return res.status(400).json({
        success: false,
        error:
          'No auth provided. Send "authToken" (+ optional "proxy"), a ' +
          '"dominatorAccount", or add sessions via POST /api/sessions.',
      });
    }

    const { feedCache, MemoryCache } = require('../utils/cache');
    const isBypass = String(fresh || bypassCache).toLowerCase() === 'true' || fresh === true || bypassCache === true;
    const isCacheDisabled =
      String(useCache).toLowerCase() === 'false' ||
      String(cache).toLowerCase() === 'false' ||
      useCache === false ||
      cache === false;
    const isCacheRequested =
      FEED_CACHE_DEFAULT ||
      String(useCache || cache).toLowerCase() === 'true' ||
      useCache === true ||
      cache === true;
    const allowCache = isCacheRequested && !isCacheDisabled && !isBypass && !feedMaxId;

    const cacheKey = MemoryCache.makeKey('userFeed', {
      userId,
      maxId: feedMaxId,
      includeStories,
      includeHighlightDetails,
      highlightDetailLimit,
    });

    if (allowCache) {
      const cached = feedCache.get(cacheKey);
      if (cached) {
        res.setHeader('X-Cache', 'HIT');
        return res.status(200).json(cached);
      }
    }

    // getUserFeed → resolveAccount() fills any still-missing cookies/proxy
    // from the encrypted pool.
    const result = await getUserFeed(account, userId, {
      maxId: feedMaxId,
      minTimestamp,
      isNewBrowser: isNewBrowser === true || isNewBrowser === 'true',
      // Story/highlight enrichment — undefined values fall back to the env
      // defaults inside resolveStoryOptions().
      includeStories,
      includeStoryHighlights,
      includeHighlightDetails,
      highlightDetailLimit,
    });

    // Success = at least one post in the web_profile_info edges.
    const edges = result?.data?.user?.edge_owner_to_timeline_media?.edges || [];
    const ok = edges.length > 0;

    if (ok && !feedMaxId) {
      feedCache.set(cacheKey, result);
      res.setHeader('X-Cache', 'MISS');
    }

    // Log every call to its own JSON file (no secrets — only whether they
    // were supplied and where auth was sourced from).
    logFeedAsync({
      userId,
      request: {
        maxId: feedMaxId,
        minTimestamp,
        isNewBrowser,
        authTokenProvided: Boolean(inlineAuth),
        proxyProvided: Boolean(proxy),
        usedDominatorAccount: Boolean(dominatorAccount),
        source: dominatorAccount
          ? 'dominatorAccount'
          : inlineAuth || proxy
          ? 'inline'
          : 'pool',
      },
      result,
    });

    // 200 when we got posts, 502 when the upstream fetch yielded nothing.
    return res.status(ok ? 200 : 502).json(result);
  } catch (err) {
    return next(err);
  }
}

module.exports = { postUserFeed };
