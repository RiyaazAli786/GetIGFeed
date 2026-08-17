'use strict';

const config = require('../config/story');
const fetcher = require('./storyFetcher');
const { getStoryByBrowser } = require('./browserFallback');
const {
  parseStories,
  parseStoryItems,
  parseHighlights,
} = require('../parsers/instagramStoriesResponseHandler');
const {
  parseHighlightDetails,
  parseAnonHighlightDetails,
} = require('../parsers/mediaDetailsResponseHandler');
const { getBetween } = require('../utils/strings');
const { parseJson } = require('../utils/json');
const { mapWithConcurrency, sleep } = require('../utils/helpers');

// Recoverable upstream failures, each with its own remedy (see config.retry).
const RATE_LIMITED = /too many requests|rate limit|slow down/i;
const HANDSHAKE_EXPIRED = /csrf token mismatch|page expired|unauthenticated|token mismatch/i;

/**
 * Why a payload carries no data, or null when it is a valid response (which may
 * still be legitimately empty — an account with no highlights).
 *
 * This is what turns a silent `count: 0` into an explanation: without it a
 * throttled source is indistinguishable from an account that genuinely has no
 * highlights, and the UI ends up asserting the wrong one. The HTTP status is
 * included when known, because a bare "html error page" does not say that the
 * real problem was a 429.
 *
 * @param {?string} text response body
 * @param {number} [status] HTTP status, when the caller kept it
 */
function describeFailure(text, status) {
  const httpNote = status && (status < 200 || status >= 300) ? `HTTP ${status}` : '';
  const join = (reason) => [httpNote, reason].filter(Boolean).join(' — ') || null;

  if (!text || !String(text).trim()) return join('no response');
  const raw = String(text);
  if (/^\s*<(!doctype|html)/i.test(raw)) {
    return join(status === 429 ? 'rate limited (block page)' : 'html error page');
  }
  const obj = parseJson(text);
  const message = typeof obj.message === 'string' ? obj.message.trim() : '';
  if (message) return join(message);
  if (raw.includes('"Server Error"')) return join('server error');
  return httpNote || null;
}

/**
 * One line per source that came back empty, e.g.
 *   "storynavigation: CSRF token mismatch. · anonstories: Too many requests"
 * null when every source answered validly — i.e. the account really has none.
 *
 * @param {Array<{name:string, text:?string, count:number, status?:number}>} attempts
 */
function emptyReason(attempts) {
  const failures = attempts
    .filter((attempt) => attempt.text !== null && !attempt.count)
    .map((attempt) => ({
      name: attempt.name,
      failure: describeFailure(attempt.text, attempt.status),
    }))
    .filter((attempt) => attempt.failure);
  if (!failures.length) return null;
  return failures.map((f) => `${f.name}: ${f.failure}`).join(' · ');
}

/**
 * Decide which of two payloads to hand the parser, and which source produced it.
 *
 * The raw body is not a usable health signal: storynavigation reports a failed
 * handshake as `{"message":"CSRF token mismatch."}`, a rate limit as an HTML
 * page, and an account it cannot read as `[]` — none of which the old
 * `includes('"Server Error"')` check caught, so the anonstories fallback never
 * ran and stories/highlights came back empty. Whether anything actually parsed
 * is the signal instead.
 *
 * @param {string} primary storynavigation body
 * @param {number} primaryCount items parsed out of it
 * @param {?string} fallback anonstories body (null when it was not fetched)
 * @param {number} fallbackCount items parsed out of it
 */
function pickPayload(primary, primaryCount, fallback, fallbackCount) {
  if (primaryCount) return { text: primary, source: 'storynavigation' };
  if (fallbackCount) return { text: fallback, source: 'anonstories' };
  // Nothing anywhere — keep whichever body still carries a profile, since that
  // is all the parser can salvage from it.
  return { text: hasProfileInfo(fallback) ? fallback : primary, source: null };
}

/** Does this payload carry a profile object the parser can read? */
function hasProfileInfo(text) {
  if (!text) return false;
  const obj = parseJson(text);
  return Boolean(obj.user_info || obj.accountInfo);
}

/**
 * Port of InstagramStoryViewModel.SearchUserIDExecute.
 *
 * The WPF command did: set IsProcessing -> GetUsersStories(username) ->
 * FetchMedia -> UpdateUI. Here that becomes a single awaitable that returns the
 * StoryCollection instead of pushing it into an ObservableCollection.
 *
 * @param {string} instaUsername handle or full instagram profile URL
 * @returns {Promise<{status:string, source:string, highlightSource:string, data:Object}>}
 */
async function searchUserId(instaUsername) {
  if (!instaUsername || !String(instaUsername).trim()) {
    // Mirrors SearchUserIDCanExecute
    const error = new Error('Username is required.');
    error.statusCode = 400;
    throw error;
  }

  const { model, source, highlightSource, storiesError, highlightsError } =
    await fetchMedia(instaUsername);
  const data = await resolveProfilePicture(model);
  return { status: 'Fetched Stories', source, highlightSource, storiesError, highlightsError, data };
}

/**
 * Port of FetchMedia. Order of operations is kept 1:1 with the C#:
 *   1. session cookies for storynavigation.com
 *   2. get-user-profile
 *   3. i.theasmn.com profile (optional, best effort)
 *   4. get-user-last-stories, falling back to anonstories.com
 *   5. get-user-highlights, falling back to anonstories.com
 *   6. parse, then optionally the puppeteer fallback for public accounts
 *
 * The storynavigation session cookies come back with the model so a follow-up
 * highlight-details pass can reuse them instead of re-handshaking per bubble.
 */
async function fetchMedia(instaUsername) {
  const username = fetcher.getInstaUsername(instaUsername);
  const sn = config.storyNavigation;

  let params = await fetcher.getParam(sn.baseUrl, sn.cookies);
  const origin = sn.origin;
  const referer = `${sn.origin}/user/${username}`;
  const jsonBody = JSON.stringify({ userName: username });

  // storynavigation rejects every call with "CSRF token mismatch." once its
  // session goes stale, which the harvested cookies cannot tell us in advance.
  // A single fresh handshake, shared by the calls that follow, recovers it.
  let rehandshaked = false;
  const snPost = async (api, body) => {
    let text = await fetcher.hitRequest(api, params, body, origin, referer);
    if (config.retry.enabled && !rehandshaked && HANDSHAKE_EXPIRED.test(describeFailure(text) || '')) {
      rehandshaked = true;
      params = await fetcher.getParam(sn.baseUrl, sn.cookies);
      text = await fetcher.hitRequest(api, params, body, origin, referer);
    }
    return text;
  };

  // anonstories throttles bursts with 429 "Too many requests" (and an HTML block
  // page when pushed). Requests to it are already spaced and cached inside
  // storyFetcher; this adds one backoff retry, since for some accounts it is the
  // only source of the highlight list.
  const anonPost = async (api) => {
    let result = await fetcher.hitStoryOrHighlights(api, username);
    const throttled = (r) =>
      r.status === 429 || RATE_LIMITED.test(describeFailure(r.body, r.status) || '');
    if (config.retry.enabled && throttled(result)) {
      await sleep(config.retry.delayMs);
      result = await fetcher.hitStoryOrHighlights(api, username);
    }
    return result;
  };

  const userInfo = await snPost(sn.userProfile, jsonBody);

  // Secondary profile source - failures here must not abort the request.
  let userInfoResponse = '';
  try {
    const asmn = config.theAsmn;
    const asmnParams = await fetcher.getParam(asmn.baseUrl, asmn.cookies);
    userInfoResponse = await fetcher.hitRequest(
      asmn.userApi,
      asmnParams,
      JSON.stringify({ username }),
      asmn.origin,
      asmn.referer
    );
  } catch {
    userInfoResponse = '';
  }

  // The C# reads these two straight out of the raw JSON text and interpolates
  // them into the next body, so the same values are reused verbatim here.
  const isPrivate = (getBetween(userInfo, '"isPrivate":', ',') || 'false').trim();
  const userId = (getBetween(userInfo, '"id":', ',') || '').replace(/"/g, '').trim();

  // instagramUserId goes out unquoted (a JSON number) exactly like the C#
  // string interpolation did; null when the profile call gave us nothing.
  const userIdLiteral = /^\d+$/.test(userId) ? userId : 'null';
  const userBody =
    `{"userName":"${username}","isPrivate":${isPrivate === 'true' ? 'true' : 'false'},` +
    `"instagramUserId":${userIdLiteral}}`;

  // --- stories: storynavigation, then anonstories -------------------------
  const snStories = await snPost(sn.lastStories, userBody);
  const snStoryCount = parseStoryItems(snStories).length;
  let anonStories = null;
  let anonStoryStatus;
  let anonStoryCount = 0;
  if (!snStoryCount) {
    const result = await anonPost(config.anonStories.story);
    anonStories = result.body;
    anonStoryStatus = result.status;
    anonStoryCount = parseStoryItems(anonStories).length;
  }
  const storyPick = pickPayload(snStories, snStoryCount, anonStories, anonStoryCount);
  const storiesError = emptyReason([
    { name: 'storynavigation', text: snStories, count: snStoryCount },
    { name: 'anonstories', text: anonStories, count: anonStoryCount, status: anonStoryStatus },
  ]);

  // --- highlights: same two sources, decided independently -----------------
  // The highlight list has its own fallback because storynavigation frequently
  // serves stories but answers `[]` for highlights (and vice versa).
  const highlightBody = `{"userName":"${username}","userId":${userIdLiteral}}`;
  const snHighlights = await snPost(sn.userHighlights, highlightBody);
  const snHighlightCount = parseHighlights(snHighlights).length;
  let anonHighlights = null;
  let anonHighlightStatus;
  let anonHighlightCount = 0;
  if (!snHighlightCount) {
    const result = await anonPost(config.anonStories.highlights);
    anonHighlights = result.body;
    anonHighlightStatus = result.status;
    anonHighlightCount = parseHighlights(anonHighlights).length;
  }
  const highlightPick = pickPayload(
    snHighlights,
    snHighlightCount,
    anonHighlights,
    anonHighlightCount
  );
  const highlightsError = emptyReason([
    { name: 'storynavigation', text: snHighlights, count: snHighlightCount },
    {
      name: 'anonstories',
      text: anonHighlights,
      count: anonHighlightCount,
      status: anonHighlightStatus,
    },
  ]);

  const parsed = parseStories(userInfo, storyPick.text, userInfoResponse, highlightPick.text);
  const model = parsed.model;
  if (!model.username) model.username = username;
  if (!model.profileUrl) model.profileUrl = `https://www.instagram.com/${username}/`;

  let source = storyPick.source;
  let highlightSource = highlightPick.source;

  // Public account with nothing to show -> browser scrape (optional).
  if (model.stories.length === 0 && !parsed.isPrivate && config.browser.enabled) {
    const before = model.highlights.length;
    await getStoryByBrowser(username, model);
    if (model.stories.length > 0) source = 'browser';
    if (model.highlights.length > before) highlightSource = 'browser';
  }

  return {
    model,
    source,
    highlightSource,
    // Only meaningful when the matching list came back empty: it names the
    // source(s) that failed, so "0 highlights" can be told apart from
    // "0 highlights because both sources were throttled".
    storiesError: model.stories.length ? null : storiesError,
    highlightsError: model.highlights.length ? null : highlightsError,
    params,
  };
}

/**
 * Port of the UpdateUI profile-picture check: Instagram CDN links expire, so a
 * dead one is swapped for the secondary source before the model is returned.
 */
async function resolveProfilePicture(model) {
  if (!config.validateProfilePic || !model.profilePic) return model;
  const isValid = await fetcher.isImageVisible(model.profilePic);
  if (!isValid && model.otherProfile) model.profilePic = model.otherProfile;
  return model;
}

/**
 * Port of GetHighlightDetails - the media behind one highlight bubble.
 * Not part of SearchUserIDExecute, but it consumes the highlight ids returned
 * by it, so it ships alongside.
 *
 * @param {string} highlightId
 * @param {string} [username]
 * @param {string} [userId] numeric Instagram id, for the anonstories fallback
 * @param {object} [opts]
 * @param {Array}  [opts.params] storynavigation session cookies to reuse
 */
async function getHighlightDetails(highlightId, username, userId, opts = {}) {
  if (!highlightId) {
    const error = new Error('highlightId is required.');
    error.statusCode = 400;
    throw error;
  }
  const sn = config.storyNavigation;
  const params = opts.params || (await fetcher.getParam(sn.baseUrl, sn.cookies));
  const referer = `${sn.origin}/user/${username || ''}`;
  const id = String(highlightId);

  const ask = (value) =>
    fetcher.hitRequest(
      sn.highlightStories,
      params,
      JSON.stringify({ highlightId: value }),
      sn.origin,
      referer
    );

  let snBody = await ask(id);
  let details = parseHighlightDetails(snBody);
  // The endpoint now answers a bare id with [] and only resolves the
  // "highlight:<id>" form, so retry with the prefix before giving up.
  if (!details.length && !id.startsWith('highlight:')) {
    snBody = await ask(`highlight:${id}`);
    details = parseHighlightDetails(snBody);
  }
  if (details.length) {
    return { title: null, items: details, source: 'storynavigation', error: null };
  }

  // Last fallback: anonstories.com/api/v1/highlight/stories, keyed by the
  // numeric instagram user id + username + highlight id.
  const bare = id.replace(/^highlight:/, '');
  const handle = fetcher.getInstaUsername(username);
  let result = await fetcher.hitHighlightStories(userId, handle, bare);
  let anon = parseAnonHighlightDetails(result.body);
  const throttled = () =>
    result.status === 429 || RATE_LIMITED.test(describeFailure(result.body, result.status) || '');
  if (!anon.items.length && config.retry.enabled && throttled()) {
    await sleep(config.retry.delayMs);
    result = await fetcher.hitHighlightStories(userId, handle, bare);
    anon = parseAnonHighlightDetails(result.body);
  }

  return {
    title: anon.title,
    items: anon.items,
    source: anon.items.length ? 'anonstories' : null,
    error: anon.items.length
      ? null
      : emptyReason([
          { name: 'storynavigation', text: snBody, count: 0 },
          { name: 'anonstories', text: result.body, count: 0, status: result.status },
        ]),
  };
}

/**
 * Everything about one handle's ephemeral media in a single call: profile,
 * active stories, highlight bubbles and — optionally — the media inside each
 * bubble.
 *
 * Never throws. The feed endpoint calls this as an enrichment step, so an
 * unreachable story source has to degrade into `error` rather than fail a feed
 * that otherwise succeeded.
 *
 * @param {string} instaUsername handle or full instagram profile URL
 * @param {object} [opts]
 * @param {boolean} [opts.includeHighlightDetails]
 * @param {number}  [opts.highlightDetailLimit] max bubbles to expand (0 = all)
 * @param {number}  [opts.highlightDetailConcurrency]
 * @returns {Promise<{profile:Object|null, stories:Array, highlights:Array,
 *   highlightDetails:Array, source:string|null, truncated:boolean,
 *   error:string|null}>}
 */
async function collectStoryBundle(instaUsername, opts = {}) {
  const {
    includeHighlightDetails = config.feed.includeHighlightDetails,
    highlightDetailLimit = config.feed.highlightDetailLimit,
    highlightDetailConcurrency = config.feed.highlightDetailConcurrency,
  } = opts;

  const empty = {
    profile: null,
    stories: [],
    highlights: [],
    highlightDetails: [],
    source: null,
    highlightSource: null,
    storiesError: null,
    highlightsError: null,
    truncated: false,
    error: null,
  };

  if (!instaUsername || !String(instaUsername).trim()) {
    return { ...empty, error: 'No username available for the story lookup.' };
  }

  let model;
  let source;
  let highlightSource;
  let storiesError;
  let highlightsError;
  let params;
  try {
    ({ model, source, highlightSource, storiesError, highlightsError, params } =
      await fetchMedia(instaUsername));
    model = await resolveProfilePicture(model);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[stories] lookup failed:', err.message);
    return { ...empty, error: err.message || 'Story lookup failed.' };
  }

  const highlights = model.highlights || [];
  const bundle = {
    profile: {
      id: model.id,
      username: model.username,
      fullName: model.fullName,
      profileUrl: model.profileUrl,
      profilePic: model.profilePic,
      biography: model.caption,
      isPrivate: model.isPrivate,
      postCount: model.postCount,
      followerCount: model.followerCount,
      followingCount: model.followingCount,
    },
    stories: model.stories || [],
    highlights,
    highlightDetails: [],
    // Tracked separately: stories and highlights fall back independently, so one
    // can come from storynavigation while the other came from anonstories.
    source,
    highlightSource,
    storiesError,
    highlightsError,
    truncated: false,
    error: null,
  };

  if (!includeHighlightDetails || !highlights.length) return bundle;

  // One upstream call per bubble, so cap the fan-out and record when we did.
  const expandable = highlights.filter((h) => h && h.id);
  const limit = highlightDetailLimit > 0 ? highlightDetailLimit : expandable.length;
  const selected = expandable.slice(0, limit);
  bundle.truncated = selected.length < expandable.length;

  bundle.highlightDetails = await mapWithConcurrency(
    selected,
    Math.max(1, highlightDetailConcurrency),
    async (highlight) => {
      try {
        const detail = await getHighlightDetails(highlight.id, model.username, model.id, {
          params,
        });
        return {
          id: highlight.id,
          title: detail.title || highlight.title || null,
          coverUrl: highlight.coverUrl || null,
          source: detail.source,
          count: detail.items.length,
          items: detail.items,
          error: detail.error || null,
        };
      } catch (err) {
        return {
          id: highlight.id,
          title: highlight.title || null,
          coverUrl: highlight.coverUrl || null,
          source: null,
          count: 0,
          items: [],
          error: err.message || 'Highlight lookup failed.',
        };
      }
    }
  );

  return bundle;
}

module.exports = {
  searchUserId,
  fetchMedia,
  getHighlightDetails,
  collectStoryBundle,
};
