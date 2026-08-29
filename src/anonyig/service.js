'use strict';

/**
 * service.js — the module's seam with the rest of the app: one shared client,
 * validated inputs, and upstream failures translated into HTTP errors the
 * central ../middleware/errorHandler.js understands.
 *
 * Controllers never touch ./client.js directly, so the h2 session and the signer
 * stay process-wide singletons.
 */

const config = require('./config');
const { AnonyIG, AnonyIGError } = require('./client');
const { buildConvertedFeed } = require('./convertedFeed');

let client = null;

/** The shared client. Lazily built so nothing is connected until first use. */
function getClient() {
  if (!client) client = new AnonyIG();
  return client;
}

/** Close the h2 session (server shutdown, tests). */
function close() {
  if (client) client.close();
  client = null;
}

const badRequest = (message) => Object.assign(new Error(message), { status: 400 });

/** Instagram handles: letters, digits, dots and underscores, up to 30 chars. */
function normalizeUsername(handle) {
  const username = String(handle || '').trim().replace(/^@/, '');
  if (!username) throw badRequest('Username is required.');
  if (!/^[A-Za-z0-9._]{1,30}$/.test(username)) throw badRequest('Invalid Instagram username.');
  return username;
}

/** Clamp `pages` — one page is ~12 posts and costs one upstream call. */
function normalizePages(value) {
  const parsed = parseInt(value, 10);
  if (Number.isNaN(parsed)) return config.defaultPages;
  return Math.min(Math.max(parsed, 1), config.maxPages);
}

/**
 * Upstream statuses must not be replayed as our own — a 401 from the hub is not
 * an auth failure of this API. Everything that is not "no such user" or a
 * timeout becomes a 502.
 */
function toHttpError(err) {
  if (!(err instanceof AnonyIGError)) return err;

  const failure = new Error();
  if (err.code === 'USER_NOT_FOUND') {
    failure.status = 404;
    failure.message = err.message;
    return failure;
  }
  // The hub answers HTTP 200 / success:false / "link not found" for a handle
  // (or media) it cannot resolve — that is a 404, not an upstream fault.
  if (err.code === 'link not found') {
    failure.status = 404;
    failure.message = 'No such Instagram account, or it exposes no public data.';
    return failure;
  }
  // A captcha challenge is a property of this host's IP address, not of the
  // request — no retry will clear it, so say what actually has to change.
  if (err.code === 'CAPTCHA_REQUIRED') {
    failure.status = 502;
    failure.message =
      'anonyig is serving a captcha challenge to this server (its IP is distrusted — ' +
      'cloud/datacenter addresses are). Route the hub through a residential proxy: set ' +
      'ANONYIG_PROXY, or ANONYIG_USE_POOL_PROXY=true to use the proxy pool. ' +
      'GET /api/anonyig/status confirms the diagnosis.';
    return failure;
  }
  // The hub throttles bursts. Pass that through as a 429 rather than burying it
  // in a 502, so a caller can tell "slow down" apart from "upstream is broken".
  if (err.status === 429) {
    failure.status = 429;
    failure.message = 'anonyig is rate limiting this client — retry shortly.';
    return failure;
  }
  if (/^timeout after /.test(err.message)) {
    failure.status = 504;
    failure.message = `anonyig timed out after ${config.timeoutMs} ms.`;
    return failure;
  }
  failure.status = 502;
  failure.message = `anonyig upstream failure${err.code ? ` (${err.code})` : ''}: ${err.message}`;
  return failure;
}

const run = async (fn) => {
  try {
    return await fn(getClient());
  } catch (err) {
    throw toHttpError(err);
  }
};

/** Profile header for one handle. */
const getUser = (handle) => {
  const username = normalizeUsername(handle);
  return run((ig) => ig.getUser(username));
};

const getPosts = (handle, { pages } = {}) => {
  const username = normalizeUsername(handle);
  const count = normalizePages(pages);
  return run((ig) => ig.getPosts(username, { pages: count }));
};

const getReels = (handle, { pages } = {}) => {
  const username = normalizeUsername(handle);
  const count = normalizePages(pages);
  return run((ig) => ig.getReels(username, { pages: count }));
};

const getStories = (handle) => {
  const username = normalizeUsername(handle);
  return run((ig) => ig.getStories(username));
};

/** Highlight bubbles, each with its stories already attached. */
const getHighlights = (handle, { withItems = true } = {}) => {
  const username = normalizeUsername(handle);
  return run((ig) => ig.getHighlights(username, { withItems }));
};

/** User + posts + reels + stories + highlights in one response. */
const getProfile = (handle, { pages, withHighlightItems = true } = {}) => {
  const username = normalizeUsername(handle);
  const count = normalizePages(pages);
  return run((ig) => ig.getEverything(username, { pages: count, withHighlightItems }));
};

/**
 * Posts, stories, highlights and every highlight's stories in one response,
 * shaped like the converted feed the rest of this API returns.
 */
const getConvertedFeed = (handle, opts = {}) => {
  const username = normalizeUsername(handle);
  const pages = normalizePages(opts.pages);
  const limit = parseInt(opts.highlightDetailLimit, 10);
  return run((ig) =>
    buildConvertedFeed(ig, username, {
      pages,
      includeStories: Boolean(opts.includeStories),
      includeHighlightDetails: opts.includeHighlightDetails !== false,
      // 0 (the default) expands every bubble.
      highlightDetailLimit: Number.isNaN(limit) ? 0 : Math.max(0, limit),
    })
  );
};

/** Diagnostics: what this host can reach, and the state of the signing chunk. */
const getStatus = () => require('./status').report(getClient());

/** Handle autocomplete, as the site's search box uses it. */
const getSuggestions = async (query) => {
  const term = String(query || '').trim().replace(/^@/, '');
  if (!term) throw badRequest('Query is required.');
  const payload = await run((ig) => ig.usernameSuggestions(term));
  return payload?.result || [];
};

module.exports = {
  getClient,
  close,
  getUser,
  getPosts,
  getReels,
  getStories,
  getHighlights,
  getProfile,
  getConvertedFeed,
  getSuggestions,
  getStatus,
};
