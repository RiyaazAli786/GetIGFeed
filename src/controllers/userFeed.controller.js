'use strict';

const { getUserFeed } = require('../services/instagram.service');
const {
  getFallbackFeed,
  shouldFallbackForPrivateResult,
  shouldFallbackForError,
} = require('../services/feedFallback.service');
const { checkProxy } = require('../services/proxyCheck');
const poolStore = require('../store/poolStore');
const { logFeedAsync } = require('../store/feedLog');
const {
  bridgeMode,
  bridgeEnabled,
  fallbackEnabled,
  fetchViaFeedPilotBridge,
} = require('../services/feedPilotBridge.service');
const { mapFeedPilotBridgeResponse } = require('../utils/mapFeedPilotBridgeResponse');

const FEED_CACHE_DEFAULT =
  String(process.env.FEED_CACHE_DEFAULT || 'false').toLowerCase() === 'true';

function hasProxy(account) {
  return Boolean(account?.accountBaseModel?.accountProxy?.proxyIp);
}

function accountWithProxy(account, proxySecret) {
  return {
    ...(account || {}),
    accountBaseModel: {
      ...(account?.accountBaseModel || {}),
      accountProxy: {
        proxyIp: proxySecret.host,
        proxyPort: proxySecret.port,
        proxyUsername: proxySecret.username || '',
        proxyPassword: proxySecret.password || '',
      },
    },
  };
}

async function nextValidPoolProxy() {
  const count = poolStore.listProxies().length;
  const checked = new Set();
  for (let i = 0; i < count; i += 1) {
    const proxySecret = poolStore.nextProxy();
    if (!proxySecret) break;
    const key = `${proxySecret.host}:${proxySecret.port}:${proxySecret.username || ''}`;
    if (checked.has(key)) continue;
    checked.add(key);

    const result = await checkProxy(proxySecret);
    if (result.ok && result.igReachable) {
      return {
        proxy: proxySecret,
        check: {
          ok: true,
          igReachable: true,
          ip: result.ip || null,
          ms: result.ms,
        },
      };
    }
  }
  return null;
}

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
      includeStory,
      include_stories,
      include_story,
      includeStoriesAndHighlights,
      includeStoryHighlights,
      stories,
      story,
      includeHighlightDetails,
      highlightDetailLimit,
      fresh,
      bypassCache,
      useCache,
      cache,
    } = src;
    const feedMaxId = maxId ?? max_id ?? null;

    // Only send includeStories = true when URL parameter or request explicitly sets it to true
    // (e.g. ?includeStory=true, ?includeStories=true, ?include_story=true, ?story=true, ?stories=true, ?includeStory=1)
    const storyParamRaw =
      req.query?.includeStory ??
      req.query?.includeStories ??
      req.query?.include_story ??
      req.query?.include_stories ??
      req.query?.story ??
      req.query?.stories ??
      req.query?.includeStoriesAndHighlights ??
      req.query?.includeStoryHighlights ??
      req.params?.includeStory ??
      req.params?.includeStories ??
      includeStory ??
      includeStories ??
      include_story ??
      include_stories ??
      story ??
      stories ??
      includeStoriesAndHighlights ??
      includeStoryHighlights;

    const shouldIncludeStories =
      storyParamRaw === true ||
      String(storyParamRaw).trim().toLowerCase() === 'true' ||
      String(storyParamRaw).trim() === '1';

    const resolvedIncludeStories = shouldIncludeStories;

    if (!userId) {
      return res
        .status(400)
        .json({ success: false, error: 'userId is required.' });
    }

    const feedSourceMode = bridgeMode();
    if (bridgeEnabled() && !feedMaxId) {
      const bridgeResult = await fetchViaFeedPilotBridge({
        requestId: req.headers['x-request-id'] || undefined,
        username: src.username || src.handle || undefined,
        userId,
        limit: Number(src.count || src.limit || 12),
        maxId: feedMaxId,
        includeStories: shouldIncludeStories,
      });

      if (bridgeResult.ok) {
        const mappedBridgeResult = mapFeedPilotBridgeResponse(
          bridgeResult.data,
          bridgeResult.bridge
        );
        res.setHeader('X-FeedPilot-Bridge', 'HIT');
        logFeedAsync({
          userId,
          request: {
            maxId: feedMaxId,
            source: 'feedpilot-bridge',
          },
          result: mappedBridgeResult,
        });
        return res.status(200).json(mappedBridgeResult);
      }

      if (bridgeResult.used && (!bridgeResult.retryable || !fallbackEnabled())) {
        return res.status(bridgeResult.status || 502).json({
          success: false,
          error: bridgeResult.message,
          code: bridgeResult.code,
          bridge: bridgeResult.bridge,
        });
      }

      if (bridgeResult.used) {
        res.setHeader('X-FeedPilot-Bridge', 'FALLBACK');
      }
    } else {
      res.setHeader('X-FeedPilot-Bridge', feedSourceMode === 'pool' ? 'DISABLED_POOL_MODE' : 'SKIPPED');
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

    const noAuthAvailable = !account && poolStore.listSessions().length === 0;
    const initialHadProxy = hasProxy(account);

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
      includeStories: resolvedIncludeStories,
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

    const feedOptions = {
      maxId: feedMaxId,
      minTimestamp,
      isNewBrowser: isNewBrowser === true || isNewBrowser === 'true',
      // Story/highlight enrichment — undefined values fall back to the env
      // defaults inside resolveStoryOptions().
      includeStories: resolvedIncludeStories,
      includeHighlightDetails,
      highlightDetailLimit,
    };

    let result;
    let privateFeedError = null;
    if (!noAuthAvailable) {
      try {
        // getUserFeed → resolveAccount() fills any still-missing cookies/proxy
        // from the encrypted pool.
        result = await getUserFeed(account, userId, feedOptions);
      } catch (err) {
        privateFeedError = err;
      }
    }

    const needsFallback =
      noAuthAvailable ||
      shouldFallbackForError(privateFeedError) ||
      shouldFallbackForPrivateResult(result);

    if (needsFallback && !feedMaxId && !noAuthAvailable) {
      const validProxy = await nextValidPoolProxy();
      if (validProxy) {
        const retryReason =
          privateFeedError?.message || result?.error || 'Private feed failed before proxy retry.';
        const proxyAccount = accountWithProxy(account, validProxy.proxy);
        result = await getUserFeed(proxyAccount, userId, feedOptions);
        if (result && typeof result === 'object') {
          result.private_retry = {
            used: true,
            reason: retryReason,
            proxy: {
              source: 'pool',
              valid: true,
              exitIp: validProxy.check.ip,
              ms: validProxy.check.ms,
              replacedExistingProxy: initialHadProxy,
            },
          };
        }
        privateFeedError = null;
      }
    }

    const stillNeedsFallback =
      noAuthAvailable ||
      shouldFallbackForError(privateFeedError) ||
      shouldFallbackForPrivateResult(result);

    if (stillNeedsFallback && !feedMaxId) {
      const reason = noAuthAvailable
        ? 'No auth provided and the stored session pool is empty.'
        : privateFeedError?.message || result?.error || 'Private Instagram feed returned 401.';
      try {
        result = await getFallbackFeed(userId, {
          pages: 1,
          includeStories: resolvedIncludeStories,
          includeHighlightDetails,
          highlightDetailLimit,
          reason,
        });
      } catch (fallbackErr) {
        if (privateFeedError) throw privateFeedError;
        if (noAuthAvailable) {
          fallbackErr.message =
            `${fallbackErr.message} No auth was available for the private feed path.`;
        }
        throw fallbackErr;
      }
    } else if (privateFeedError) {
      throw privateFeedError;
    } else if (noAuthAvailable) {
      return res.status(400).json({
        success: false,
        error:
          'No auth provided. Send "authToken" (+ optional "proxy"), a ' +
          '"dominatorAccount", or add sessions via POST /api/sessions.',
      });
    }

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
