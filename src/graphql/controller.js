'use strict';

/**
 * src/graphql/controller.js
 *
 * Handles GET /api/graphql[/:username] and POST /api/graphql.
 * Resolves the handle, calls the Instagram doc_id GraphQL query via the pool,
 * and returns results in a web_profile_info-shaped envelope.
 */

const service = require('./service');

/** Extract username from path param, query string, or JSON body. */
function usernameFrom(req) {
  const src = {
    ...(req.params || {}),
    ...(req.query || {}),
    ...(req.body || {}),
  };
  return (
    src.username ||
    src.instaUsername ||
    src.handle ||
    src.user ||
    ''
  );
}

/**
 * GET  /api/graphql/:username[?first=12&after=<cursor>]
 * GET  /api/graphql?username=nasa&first=12
 * POST /api/graphql  { username, first?, after? }
 */
async function fetchFeed(req, res, next) {
  try {
    const username = usernameFrom(req);
    if (!username) {
      return res
        .status(400)
        .json({ success: false, error: 'username is required (path, query, or body).' });
    }

    const src = { ...(req.params || {}), ...(req.query || {}), ...(req.body || {}) };
    const opts = {
      first: src.first || 12,
      after: src.after || src.endCursor,
      includeStories:
        src.includeStories ??
        src.include_stories ??
        src.includeStoriesAndHighlights ??
        src.includeStoryHighlights ??
        src.stories,
    };

    const result = await service.fetchFromGraphQL(username, opts);
    res.json(result);
  } catch (err) {
    next(err);
  }
}

module.exports = { fetchFeed };
