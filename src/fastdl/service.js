'use strict';

/**
 * service.js — FastDL service manager.
 * Handles single client instance, input URL validation, and maps failures to
 * HTTP errors.
 */

const { FastDL, FastDLError } = require('./client');

let client = null;

function getClient() {
  if (!client) client = new FastDL();
  return client;
}

function close() {
  if (client) client.close();
  client = null;
}

const badRequest = (message) => Object.assign(new Error(message), { status: 400 });

function parseTargetInput(input) {
  const target = String(input || '').trim();
  if (!target) return null;

  // 1. Check if it's a highlight ID (e.g. highlight:18201653992314974 or 18201653992314974)
  if (target.startsWith('highlight:') || /^\d{15,25}$/.test(target)) {
    const highlightId = target.replace(/^highlight:/, '');
    return { type: 'highlight', value: highlightId };
  }

  // 2. Check if it's a profile URL (e.g. https://www.instagram.com/nasa/)
  const profileRegex = /^https?:\/\/(?:www\.)?instagram\.com\/([A-Za-z0-9._]{1,30})\/?(?:\?.*)?$/i;
  const profileMatch = target.match(profileRegex);
  if (profileMatch) {
    return { type: 'handle', value: profileMatch[1] };
  }

  // 2. Check if it's a direct handle (e.g. @nasa or nasa)
  if (target.startsWith('@') || /^[A-Za-z0-9._]{1,30}$/.test(target)) {
    const username = target.replace(/^@/, '');
    if (/^[A-Za-z0-9._]{1,30}$/.test(username)) {
      return { type: 'handle', value: username };
    }
  }

  // 3. Otherwise, check if it's a valid URL (e.g. post/reels/stories URL)
  try {
    const parsed = new URL(target);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      return { type: 'url', value: target };
    }
  } catch {
    // ignore
  }

  return null;
}

function normalizeUsername(handle) {
  const username = String(handle || '').trim().replace(/^@/, '');
  if (!username) throw badRequest('Username is required.');
  if (!/^[A-Za-z0-9._]{1,30}$/.test(username)) throw badRequest('Invalid Instagram username.');
  return username;
}

function normalizeInput(input) {
  const target = String(input || '').trim();
  if (!target) throw badRequest('URL or Instagram handle is required.');

  // Check if it's an Instagram handle (starts with @ or is a simple username string)
  if (target.startsWith('@') || /^[A-Za-z0-9._]{1,30}$/.test(target)) {
    const username = target.replace(/^@/, '');
    if (!/^[A-Za-z0-9._]{1,30}$/.test(username)) {
      throw badRequest('Invalid Instagram username.');
    }
    return `https://www.instagram.com/${username}/`;
  }

  // Otherwise, treat as URL
  try {
    const parsed = new URL(target);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error();
    }
    return target;
  } catch {
    throw badRequest('Invalid URL or Instagram handle.');
  }
}

function toHttpError(err) {
  if (!(err instanceof FastDLError)) return err;

  const failure = new Error();
  
  if (err.code === 'link not found' || (err.message && err.message.toLowerCase().includes('not found'))) {
    failure.status = 404;
    failure.message = err.message || 'No media found at this URL.';
    return failure;
  }
  
  if (err.code === 'CAPTCHA_REQUIRED' || (err.message && err.message.includes('CAPTCHA'))) {
    failure.status = 502;
    failure.message =
      'FastDL is serving a captcha challenge to this server. Route the hub through a residential proxy ' +
      'by setting FASTDL_PROXY or FASTDL_USE_POOL_PROXY=true.';
    return failure;
  }

  if (err.status === 429) {
    failure.status = 429;
    failure.message = 'FastDL is rate limiting requests. Please retry shortly.';
    return failure;
  }

  if (err.message && err.message.startsWith('timeout')) {
    failure.status = 504;
    failure.message = 'FastDL hub timed out.';
    return failure;
  }

  failure.status = 502;
  failure.message = `FastDL upstream failure: ${err.message}`;
  return failure;
}

const run = async (fn) => {
  try {
    return await fn(getClient());
  } catch (err) {
    throw toHttpError(err);
  }
};

/** Convert/fetch media items for a single URL */
const convert = (url) => {
  const validated = normalizeInput(url);
  return run((ig) => ig.convert(validated));
};

const { buildConvertedFeed } = require('./convertedFeed');

/** Fetch user, posts, stories, highlights in converted JSON shape */
const getConvertedFeed = (handle, opts = {}) => {
  const username = normalizeUsername(handle);
  const pages = parseInt(opts.pages, 10) || 1;
  const limit = parseInt(opts.highlightDetailLimit, 10);
  return run((ig) =>
    buildConvertedFeed(ig, username, {
      pages,
      includeHighlightDetails: opts.includeHighlightDetails !== false,
      highlightDetailLimit: Number.isNaN(limit) ? 0 : Math.max(0, limit),
    })
  );
};

const fetchData = async (input, opts = {}) => {
  const parsed = parseTargetInput(input);
  if (!parsed) {
    throw badRequest('Invalid Instagram URL or handle. Provide a valid post/media URL, profile URL, or handle.');
  }

  if (parsed.type === 'handle') {
    const pages = parseInt(opts.pages, 10) || 1;
    const limit = parseInt(opts.highlightDetailLimit, 10);
    return await run((ig) =>
      buildConvertedFeed(ig, parsed.value, {
        pages,
        includeHighlightDetails: opts.includeHighlightDetails !== false,
        highlightDetailLimit: Number.isNaN(limit) ? 0 : Math.max(0, limit),
      })
    );
  } else if (parsed.type === 'highlight') {
    return await run(async (ig) => {
      const payload = await ig.highlightStoriesRaw(parsed.value);
      const items = payload?.result || [];
      const { toHighlightItem } = require('./convertedFeed');
      return items.map(toHighlightItem);
    });
  } else {
    return await run((ig) => ig.convert(parsed.value));
  }
};

const getStatus = () => require('./status').report(getClient());

module.exports = {
  getClient,
  close,
  convert,
  getConvertedFeed,
  getStatus,
  normalizeInput,
  fetchData,
  parseTargetInput,
};

