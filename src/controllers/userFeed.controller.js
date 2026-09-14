'use strict';

const { getUserFeed } = require('../services/instagram.service');
const { fetchFromGraphQL } = require('../graphql/service');
const {
  getFallbackFeed,
  shouldFallbackForPrivateResult,
  shouldFallbackForError,
} = require('../services/feedFallback.service');
const { checkProxy } = require('../services/proxyCheck');
const poolStore = require('../store/poolStore');
const { logFeed, logFeedAsync } = require('../store/feedLog');
const { setFeedResolution } = require('../utils/feedResolution');
const {
  bridgeMode,
  bridgeEnabled,
  fallbackEnabled,
  fetchViaFeedPilotBridge,
} = require('../services/feedPilotBridge.service');
const { mapFeedPilotBridgeResponse } = require('../utils/mapFeedPilotBridgeResponse');

const FEED_CACHE_DEFAULT =
  String(process.env.FEED_CACHE_DEFAULT || 'false').toLowerCase() === 'true';

const flag = (value, fallback = true) => {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  return !['false', '0', 'no', 'off'].includes(String(value).trim().toLowerCase());
};

/** Apply per-request IGram/hub switches without bypassing configured provider order. */
function fallbackProviders({ igramFallback, hubFallback }) {
  const configured = process.env.FEED_FALLBACK_PROVIDERS || 'graphql,igram,anonyig,fastdl';
  return configured
    .split(',')
    .map((provider) => provider.trim().toLowerCase())
    .filter(Boolean)
    .filter((provider) => provider !== 'igram' || flag(igramFallback, process.env.USER_FEED_IGRAM_FALLBACK !== 'false'))
    .filter((provider) => !['anonyig', 'fastdl'].includes(provider) || flag(hubFallback, process.env.USER_FEED_HUB_FALLBACK !== 'false'));
}

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
      igramFallback,
      useIgramFallback,
      hubFallback,
      useHubFallback,
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
    let bridgeResult = null;
    if (bridgeEnabled() && !feedMaxId) {
      const isNumericId = /^\d+$/.test(String(userId).trim());
      const resolvedUsername =
        src.username ||
        src.handle ||
        (!isNumericId ? String(userId).replace(/^@/, '') : undefined);
      const resolvedUserId = isNumericId
        ? String(userId).trim()
        : (src.numericUserId || src.userIdNumeric || undefined);

      bridgeResult = await fetchViaFeedPilotBridge({
        requestId: req.headers['x-request-id'] || undefined,
        username: resolvedUsername,
        userId: resolvedUserId,
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
        const logFile = logFeed({
          userId,
          request: {
            maxId: feedMaxId,
            source: 'feedpilot-bridge',
          },
          result: mappedBridgeResult,
        });
        const bridgeEndpoint =
          bridgeResult.bridge?.endpoint ||
          (process.env.FEEDPILOT_BRIDGE_URL
            ? `${process.env.FEEDPILOT_BRIDGE_URL.replace(/\/+$/, '')}/api/bridge/feed`
            : 'feedpilot-bridge');
        setFeedResolution(res, {
          resolvedFrom: 'FeedPilot Bridge',
          resolvedPath: bridgeEndpoint,
          proxy: 'bridge-device',
          logFile: logFile || undefined,
          details: {
            device: bridgeResult.bridge?.device || 'unknown',
          },
        });
        return res.status(200).json(mappedBridgeResult);
      }

      if (bridgeResult.used && (!bridgeResult.retryable || !fallbackEnabled())) {
        setFeedResolution(res, {
          resolvedFrom: 'FeedPilot Bridge (Failed)',
          resolvedPath: bridgeResult.bridge?.endpoint || 'feedpilot-bridge',
          error: bridgeResult.message,
        });
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
    const requestedIgramFallback = igramFallback ?? useIgramFallback;
    const requestedHubFallback = hubFallback ?? useHubFallback;
    const selectedFallbackProviders = fallbackProviders({
      igramFallback: requestedIgramFallback,
      hubFallback: requestedHubFallback,
    });

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
      igramFallback: requestedIgramFallback,
      hubFallback: requestedHubFallback,
    });

    if (allowCache) {
      const cached = feedCache.get(cacheKey);
      if (cached) {
        res.setHeader('X-Cache', 'HIT');
        setFeedResolution(res, {
          resolvedFrom: 'Cache (Memory)',
          resolvedPath: `memory-cache://${cacheKey}`,
          source: 'cache',
          proxy: 'none (in-memory cache)',
        });
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
    let primaryGqlError = null;
    let triedGraphQL = false;
    const primarySource = (
      process.env.USER_FEED_PRIMARY_SOURCE || 'graphql'
    ).trim().toLowerCase();

    // Step 1: If primary source is GraphQL (default), try it first!
    if (primarySource === 'graphql' && !noAuthAvailable) {
      triedGraphQL = true;
      try {
        result = await fetchFromGraphQL(userId, {
          first: Number(src.count || src.limit || 12),
          after: feedMaxId,
          account,
          useProxy: initialHadProxy,
          includeStories: resolvedIncludeStories,
          includeHighlightDetails,
          highlightDetailLimit,
        });
      } catch (err) {
        primaryGqlError = err;
      }
    }

    const gqlEdges = result?.data?.user?.edge_owner_to_timeline_media?.edges || [];
    const gqlSucceeded = gqlEdges.length > 0;

    // Step 2: If GraphQL didn't succeed, try Private API
    let privateFeedError = null;
    if (!gqlSucceeded && !noAuthAvailable) {
      try {
        // getUserFeed → resolveAccount() fills any still-missing cookies/proxy
        // from the encrypted pool.
        result = await getUserFeed(account, userId, feedOptions);
      } catch (err) {
        privateFeedError = err;
      }
    }

    const privateEdges = result?.data?.user?.edge_owner_to_timeline_media?.edges || [];
    const hasPostsAfterPrimary = gqlSucceeded || privateEdges.length > 0;

    const needsFallback =
      !gqlSucceeded &&
      (noAuthAvailable ||
        !hasPostsAfterPrimary ||
        shouldFallbackForError(privateFeedError) ||
        shouldFallbackForPrivateResult(result));

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

    const currentEdges = result?.data?.user?.edge_owner_to_timeline_media?.edges || [];
    const hasCurrentPosts = currentEdges.length > 0;

    const stillNeedsFallback =
      !gqlSucceeded &&
      (noAuthAvailable ||
        !hasCurrentPosts ||
        shouldFallbackForError(privateFeedError) ||
        shouldFallbackForPrivateResult(result));

    if (stillNeedsFallback && !feedMaxId) {
      const failedSource = bridgeResult?.used
        ? 'FeedPilot Bridge'
        : dominatorAccount
        ? 'Dominator Account'
        : inlineAuth || proxy
        ? 'Inline Auth Session'
        : triedGraphQL && !privateFeedError && (!result || !currentEdges.length)
        ? 'Instagram GraphQL & Private API'
        : triedGraphQL
        ? 'Instagram GraphQL'
        : noAuthAvailable
        ? 'Session Pool (Empty - No Auth Available)'
        : 'Instagram Private API (Session Pool)';

      const rawReason = noAuthAvailable
        ? 'No auth provided and the stored session pool is empty.'
        : primaryGqlError?.message ||
          privateFeedError?.message ||
          result?.error ||
          'Upstream returned 0 posts.';

      const reason = rawReason.includes('401')
        ? `${rawReason} (Session cookies expired or unauthorized)`
        : rawReason;

      const remainingProviders = triedGraphQL
        ? selectedFallbackProviders.filter((p) => p !== 'graphql')
        : selectedFallbackProviders;

      try {
        result = await getFallbackFeed(userId, {
          pages: 1,
          includeStories: resolvedIncludeStories,
          includeHighlightDetails,
          highlightDetailLimit,
          reason,
          failedSource,
          providers: remainingProviders.length ? remainingProviders : selectedFallbackProviders,
        });
      } catch (fallbackErr) {
        if (primaryGqlError && !privateFeedError) throw primaryGqlError;
        if (privateFeedError) throw privateFeedError;
        if (noAuthAvailable) {
          fallbackErr.message =
            `${fallbackErr.message} No auth was available for the private feed path.`;
        }
        throw fallbackErr;
      }
    } else if (primaryGqlError && !result) {
      throw primaryGqlError;
    } else if (privateFeedError && !result) {
      throw privateFeedError;
    } else if (noAuthAvailable) {
      setFeedResolution(res, {
        resolvedFrom: 'Failed (No auth)',
        error: 'No auth provided. Send authToken or add sessions via POST /api/sessions.',
      });
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
    const logFile = logFeed({
      userId,
      request: {
        maxId: feedMaxId,
        minTimestamp,
        isNewBrowser,
        authTokenProvided: Boolean(inlineAuth),
        proxyProvided: Boolean(proxy),
        usedDominatorAccount: Boolean(dominatorAccount),
        igramFallbackEnabled: flag(requestedIgramFallback, process.env.USER_FEED_IGRAM_FALLBACK !== 'false'),
        hubFallbackEnabled: flag(requestedHubFallback, process.env.USER_FEED_HUB_FALLBACK !== 'false'),
        source: dominatorAccount
          ? 'dominatorAccount'
          : inlineAuth || proxy
          ? 'inline'
          : 'pool',
      },
      result,
    });

    const isNumericId = /^\d+$/.test(String(userId).trim());
    const feedTarget = !isNumericId
      ? `${encodeURIComponent(String(userId).replace(/^@/, ''))}/username`
      : encodeURIComponent(userId);
    const feedPath = `/api/v1/feed/user/${feedTarget}/?count=12`;

    if (result?.fallback?.used) {
      const provider = result.fallback.provider || 'fallback';
      const hubUrl =
        provider === 'igram'
          ? (process.env.IGRAM_WORKER_HUB || 'https://api-wn.igram.world')
          : provider === 'fastdl'
          ? (process.env.FASTDL_WORKER_HUB || 'https://api-wh.fastdl.app')
          : provider === 'anonyig'
            ? (process.env.ANONYIG_WORKER_HUB || 'https://api-wh.anonyig.com')
            : 'https://www.instagram.com/graphql/query';
      const targetUser = !isNumericId ? String(userId).replace(/^@/, '') : userId;
      setFeedResolution(res, {
        resolvedFrom: `Fallback Provider (${provider})`,
        resolvedPath: `${hubUrl}/api/v1/user/${encodeURIComponent(targetUser)}`,
        provider,
        failedSource: result.fallback.failedSource || undefined,
        logFile: logFile || undefined,
        details: {
          failedSource: result.fallback.failedSource || undefined,
          triggerReason: result.fallback.triggerReason || result.fallback.reason || undefined,
        },
      });
    } else if (result?.source === 'graphql') {
      const authSource = dominatorAccount ? 'dominatorAccount' : (inlineAuth || proxy ? 'inline' : 'pool');
      setFeedResolution(res, {
        resolvedFrom: 'Instagram GraphQL',
        resolvedPath: 'https://www.instagram.com/graphql/query/?doc_id=7950326061742207',
        authSource,
        proxy: initialHadProxy ? 'provided' : 'direct / pool',
        logFile: logFile || undefined,
      });
    } else if (result?.private_retry?.used) {
      setFeedResolution(res, {
        resolvedFrom: 'Instagram Private API (Proxy Retry)',
        resolvedPath: feedPath,
        authSource: dominatorAccount ? 'dominatorAccount' : (inlineAuth || proxy ? 'inline' : 'pool'),
        proxy: result.private_retry.proxy?.exitIp || 'pool-proxy',
        logFile: logFile || undefined,
      });
    } else {
      const authSource = dominatorAccount ? 'dominatorAccount' : (inlineAuth || proxy ? 'inline' : 'pool');
      setFeedResolution(res, {
        resolvedFrom: triedGraphQL ? 'Instagram Private API (Fallback)' : 'Instagram Private API',
        resolvedPath: feedPath,
        authSource,
        proxy: initialHadProxy ? 'provided' : 'direct / pool',
        logFile: logFile || undefined,
        ...(triedGraphQL ? {
          failedSource: 'Instagram GraphQL',
        } : {}),
      });
    }

    // 200 when we got posts, 502 when the upstream fetch yielded nothing.
    return res.status(ok ? 200 : 502).json(result);
  } catch (err) {
    setFeedResolution(res, {
      resolvedFrom: 'Failed (Error)',
      error: err.message,
    });
    return next(err);
  }
}

module.exports = { postUserFeed };
