'use strict';

const service = require('./service');

/**
 * anonyig endpoints — user details, posts, reels, stories and highlights for a
 * public handle, straight from the anonyig worker hub.
 *
 * Like /api/instagram/*, these need neither a pooled session nor a proxy. They
 * are kept apart from that group because they are a different upstream with its
 * own transport (signed HTTP/2) rather than another story-viewer source.
 *
 * Every handler accepts the handle from the path, the query string or the body,
 * so `GET /user/nasa`, `GET /user?username=nasa` and `POST /user {username}`
 * are all the same call.
 */

const handleFrom = (req) => {
  const src = { ...(req.params || {}), ...(req.query || {}), ...(req.body || {}) };
  return src.username || src.instaUsername || src.handle;
};

const flag = (value, fallback) => {
  if (value === undefined || value === null || value === '') return fallback;
  return !['false', '0', 'no', 'off'].includes(String(value).toLowerCase());
};

const pagesFrom = (req) => ({ ...(req.query || {}), ...(req.body || {}) }).pages;

/**
 * GET  /api/anonyig/user/:username
 * GET  /api/anonyig/user?username=
 * POST /api/anonyig/user   body: { username }
 *
 * Profile header only — id, name, bio, counts, verification, avatar. This is
 * the cheapest call in the module: one upstream request, and the result is
 * cached in-process for ANONYIG_USER_CACHE_TTL_MS.
 */
async function userDetails(req, res, next) {
  try {
    const user = await service.getUser(handleFrom(req));
    res.json({ success: true, source: 'anonyig', data: user });
  } catch (error) {
    next(error);
  }
}

/** GET /api/anonyig/posts/:username?pages=  — carousels expand per child. */
async function posts(req, res, next) {
  try {
    const result = await service.getPosts(handleFrom(req), { pages: pagesFrom(req) });
    res.json({
      success: true,
      source: 'anonyig',
      count: result.count,
      pages: result.pages,
      pageInfo: result.pageInfo,
      data: result.items,
    });
  } catch (error) {
    next(error);
  }
}

/**
 * GET /api/anonyig/reels/:username?pages=
 * Derived from the posts feed — the site has no reels endpoint of its own.
 */
async function reels(req, res, next) {
  try {
    const result = await service.getReels(handleFrom(req), { pages: pagesFrom(req) });
    res.json({
      success: true,
      source: 'anonyig',
      count: result.count,
      pages: result.pages,
      pageInfo: result.pageInfo,
      data: result.items,
    });
  } catch (error) {
    next(error);
  }
}

/** GET /api/anonyig/stories/:username — active stories, empty when there are none. */
async function stories(req, res, next) {
  try {
    const result = await service.getStories(handleFrom(req));
    res.json({ success: true, source: 'anonyig', count: result.count, data: result.items });
  } catch (error) {
    next(error);
  }
}

/**
 * GET /api/anonyig/highlights/:username?withItems=false
 *
 * Each bubble arrives with its stories already attached; pass `withItems=false`
 * for covers and titles only, which is one upstream call instead of one per
 * highlight. A highlight that failed on its own carries `error`.
 */
async function highlights(req, res, next) {
  try {
    const withItems = flag(({ ...req.query, ...req.body }).withItems, true);
    const result = await service.getHighlights(handleFrom(req), { withItems });
    res.json({ success: true, source: 'anonyig', count: result.count, data: result.items });
  } catch (error) {
    next(error);
  }
}

/**
 * GET  /api/anonyig/profile/:username?pages=&withHighlightItems=
 * POST /api/anonyig/profile  body: { username, pages?, withHighlightItems? }
 *
 * Everything the site's profile page shows, tabs fetched concurrently over one
 * h2 session. A tab that fails is reported in `errors` rather than failing the
 * request, so a partial profile still comes back.
 */
async function profile(req, res, next) {
  try {
    const src = { ...(req.query || {}), ...(req.body || {}) };
    const result = await service.getProfile(handleFrom(req), {
      pages: src.pages,
      withHighlightItems: flag(src.withHighlightItems, true),
    });
    res.json({
      success: true,
      source: 'anonyig',
      errors: result.errors,
      fetchedAt: result.fetchedAt,
      data: {
        user: result.user,
        posts: result.posts,
        reels: result.reels,
        stories: result.stories,
        highlights: result.highlights,
      },
    });
  } catch (error) {
    next(error);
  }
}

/**
 * GET  /api/anonyig/feed/:username?pages=&includeHighlightDetails=&highlightDetailLimit=
 * POST /api/anonyig/feed  body: { username, pages?, … }
 *
 * The single call for everything — posts, stories, highlight bubbles and the
 * stories inside each bubble — returned in this project's converted JSON:
 *
 *   { data: { user: … }, status, source, errors, stories, highlights,
 *     highlight_details }
 *
 * Byte-for-byte the contract /api/user-feed returns, so an existing consumer
 * needs no changes; the difference is the source (one upstream, no pooled
 * session, no proxy) rather than the shape.
 */
async function convertedFeed(req, res, next) {
  try {
    const src = { ...(req.query || {}), ...(req.body || {}) };
    const result = await service.getConvertedFeed(handleFrom(req), {
      pages: src.pages,
      includeHighlightDetails: flag(src.includeHighlightDetails ?? src.highlightDetails, true),
      highlightDetailLimit: src.highlightDetailLimit,
    });
    res.json(result);
  } catch (error) {
    next(error);
  }
}

/**
 * GET /api/anonyig/status — diagnostics, no handle required.
 *
 * Probes anonyig.com and the worker hub separately and reports the signing
 * chunk's state, because a failed request cannot tell you which of the two is
 * blocked: the chunk is fetched first, so a refused site masks the hub.
 */
async function status(req, res, next) {
  try {
    res.json({ success: true, ...(await service.getStatus()) });
  } catch (error) {
    next(error);
  }
}

/** GET /api/anonyig/suggestions?query= — handle autocomplete. */
async function suggestions(req, res, next) {
  try {
    const src = { ...(req.params || {}), ...(req.query || {}), ...(req.body || {}) };
    const items = await service.getSuggestions(src.query || src.username);
    res.json({ success: true, source: 'anonyig', count: items.length, data: items });
  } catch (error) {
    next(error);
  }
}

module.exports = {
  userDetails,
  posts,
  reels,
  stories,
  highlights,
  profile,
  convertedFeed,
  suggestions,
  status,
};
