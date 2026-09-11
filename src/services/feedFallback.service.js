'use strict';

const anonyig = require('../anonyig/service');
const fastdl = require('../fastdl/service');
const graphql = require('../graphql/service');
const poolStore = require('../store/poolStore');

const PROVIDERS = {
  graphql: (username, opts) => graphql.fetchFromGraphQL(username, {
    first: opts.first || opts.count || 12,
    after: opts.after || opts.endCursor,
    useProxy: false,
    includeStories: Boolean(opts.includeStories),
    includeHighlightDetails: opts.includeHighlightDetails !== false,
    highlightDetailLimit: opts.highlightDetailLimit,
  }),
  anonyig: (username, opts) => anonyig.getConvertedFeed(username, opts),
  fastdl: (username, opts) => fastdl.getConvertedFeed(username, opts),
};
const DEFAULT_PROVIDERS = ['graphql', 'anonyig', 'fastdl'];
const WORKER_PROVIDERS = ['anonyig', 'fastdl'];
let workerProviderCursor = 0;

function normalizeUsername(value) {
  const raw = String(value || '').trim();
  if (!raw || /^\d+$/.test(raw)) return null;
  try {
    const url = raw.startsWith('http://') || raw.startsWith('https://')
      ? new URL(raw)
      : null;
    if (url && /(^|\.)instagram\.com$/i.test(url.hostname)) {
      return decodeURIComponent(url.pathname.split('/').filter(Boolean)[0] || '').replace(/^@/, '');
    }
  } catch {
    // Fall through to raw handle normalization.
  }
  const username = raw.replace(/^@/, '').split(/[/?#]/)[0].trim();
  return /^[A-Za-z0-9._]{1,30}$/.test(username) ? username : null;
}

function providerList(value = process.env.FEED_FALLBACK_PROVIDERS) {
  const source = value == null || String(value).trim() === ''
    ? DEFAULT_PROVIDERS
    : String(value).split(',');
  const names = source
    .map((name) => name.trim().toLowerCase())
    .filter(Boolean);
  return names.filter((name, index) => PROVIDERS[name] && names.indexOf(name) === index);
}

function orderedProviders(value = process.env.FEED_FALLBACK_PROVIDERS) {
  const providers = providerList(value);
  const nonWorkers = providers.filter((provider) => !WORKER_PROVIDERS.includes(provider));
  const workers = WORKER_PROVIDERS.filter((provider) => providers.includes(provider));

  if (workers.length < 2) return providers;

  const firstWorker = workerProviderCursor % workers.length;
  workerProviderCursor = (workerProviderCursor + 1) % workers.length;
  return [
    ...nonWorkers,
    ...workers.slice(firstWorker),
    ...workers.slice(0, firstWorker),
  ];
}

function edgesOf(result) {
  return result?.data?.user?.edge_owner_to_timeline_media?.edges || [];
}

function hasFeedItems(result) {
  return edgesOf(result).length > 0;
}

function workerFallbackProxy(opts = {}) {
  if (opts.proxy !== undefined) return opts.proxy;
  return poolStore.nextProxy() || undefined;
}

function providerOptions(provider, opts = {}) {
  const options = {
    pages: opts.pages || 1,
    first: opts.first || opts.count || 12,
    after: opts.after || opts.endCursor,
    includeStories: Boolean(opts.includeStories),
    includeHighlightDetails: opts.includeHighlightDetails !== false,
    highlightDetailLimit: opts.highlightDetailLimit,
  };

  if (provider === 'anonyig' || provider === 'fastdl') {
    const proxy = workerFallbackProxy(opts);
    if (proxy !== undefined) {
      options.proxy = proxy;
      options.proxySource = opts.proxy !== undefined ? 'provided' : 'pool';
    }
  }

  return options;
}

function shouldFallbackForPrivateResult(result) {
  if (!result || edgesOf(result).length > 0) return false;
  const message = String(result.error || result.errors?.feed || '').toLowerCase();
  return /\b401\b|unauthori[sz]ed|login required|challenge|required|flagged .*spam/.test(message);
}

function shouldFallbackForError(err) {
  const status = err?.status || err?.statusCode || err?.response?.status;
  if (status === 401) return true;
  const message = String(err?.message || '').toLowerCase();
  return /\b401\b|unauthori[sz]ed|login required|challenge|required|flagged .*spam/.test(message);
}

async function getFallbackFeed(userId, opts = {}) {
  const username = normalizeUsername(userId);
  if (!username) {
    const err = new Error('Fallback feed providers need a public Instagram username.');
    err.status = 400;
    throw err;
  }

  const failures = [];
  for (const provider of orderedProviders(opts.providers)) {
    try {
      const attemptOptions = providerOptions(provider, opts);
      const result = await PROVIDERS[provider](username, attemptOptions);
      if (!hasFeedItems(result)) {
        failures.push({
          provider,
          status: result?.status || null,
          error: 'Provider returned an empty feed.',
        });
        continue;
      }
      return {
        ...result,
        source: result.source || provider,
        fallback: {
          used: true,
          provider,
          triggerReason: opts.reason || null,
          // Kept for older clients; this is why fallback started, not the
          // selected provider's own error.
          reason: opts.reason || null,
          proxy: attemptOptions.proxy ? attemptOptions.proxySource : null,
          failures,
        },
      };
    } catch (err) {
      failures.push({
        provider,
        status: err.status || err.statusCode || err.response?.status || null,
        error: err.message,
      });
    }
  }

  const err = new Error('All fallback feed providers failed.');
  err.status = 502;
  err.failures = failures;
  throw err;
}

module.exports = {
  getFallbackFeed,
  shouldFallbackForPrivateResult,
  shouldFallbackForError,
  normalizeUsername,
  providerList,
  orderedProviders,
};
