'use strict';

const { IGram, IGramError } = require('./client');
const { buildConvertedFeed, toHighlightItem } = require('../fastdl/convertedFeed');

let client = null;
const getClient = () => (client ||= new IGram());
const close = () => { if (client) client.close(); client = null; };
const badRequest = (message) => Object.assign(new Error(message), { status: 400 });

function parseTargetInput(input) {
  const target = String(input || '').trim();
  if (!target) return null;
  if (target.startsWith('highlight:') || /^\d{15,25}$/.test(target)) return { type: 'highlight', value: target.replace(/^highlight:/, '') };
  const profile = target.match(/^https?:\/\/(?:www\.)?instagram\.com\/([A-Za-z0-9._]{1,30})\/?(?:\?.*)?$/i);
  if (profile) return { type: 'handle', value: profile[1] };
  if (/^@?[A-Za-z0-9._]{1,30}$/.test(target)) return { type: 'handle', value: target.replace(/^@/, '') };
  try {
    const url = new URL(target);
    return /^https?:$/.test(url.protocol) ? { type: 'url', value: target } : null;
  } catch { return null; }
}

function normalizeUsername(value) {
  const handle = String(value || '').trim().replace(/^@/, '');
  if (!handle) throw badRequest('Username is required.');
  if (!/^[A-Za-z0-9._]{1,30}$/.test(handle)) throw badRequest('Invalid Instagram username.');
  return handle;
}

function toHttpError(err) {
  if (!(err instanceof IGramError)) return err;
  const failure = new Error();
  if (err.status === 404 || /not found/i.test(err.message)) { failure.status = 404; failure.message = err.message || 'No media found.'; return failure; }
  if (err.status === 429) { failure.status = 429; failure.message = 'IGram is rate limiting requests. Please retry shortly.'; return failure; }
  if (err.status === 422 || err.code === 'CAPTCHA_REQUIRED') { failure.status = 502; failure.message = 'IGram requires a captcha token or a trusted proxy. Set IGRAM_X_TOKEN or IGRAM_PROXY and retry.'; return failure; }
  if (/^timeout/.test(err.message)) { failure.status = 504; failure.message = 'IGram worker hub timed out.'; return failure; }
  failure.status = 502;
  failure.message = `IGram upstream failure: ${err.message}`;
  return failure;
}

const run = async (fn) => { try { return await fn(getClient()); } catch (err) { throw toHttpError(err); } };

const getConvertedFeed = (handle, opts = {}) => {
  const pages = parseInt(opts.pages, 10) || 1;
  const limit = parseInt(opts.highlightDetailLimit, 10);
  return run((ig) => buildConvertedFeed(ig, normalizeUsername(handle), {
    pages,
    includeStories: opts.includeStories !== false,
    includeHighlightDetails: opts.includeHighlightDetails !== false,
    highlightDetailLimit: Number.isNaN(limit) ? 0 : Math.max(0, limit),
  }));
};

const fetchData = (input, opts = {}) => {
  const target = parseTargetInput(input);
  if (!target) throw badRequest('Invalid Instagram URL, handle, or highlight ID.');
  if (target.type === 'handle') return getConvertedFeed(target.value, opts);
  if (target.type === 'highlight') return run(async (ig) => (await ig.highlightStoriesRaw(target.value))?.result?.map(toHighlightItem) || []);
  return run((ig) => ig.convert(target.value));
};

const getStatus = async () => ({ hub: { host: getClient().workerHub, ...(await getClient().probe()) }, proxy: getClient().proxyInfo() });

module.exports = { getClient, close, fetchData, getConvertedFeed, getStatus, parseTargetInput, normalizeUsername };
