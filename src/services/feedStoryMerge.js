'use strict';

const storyConfig = require('../config/story');
const { collectStoryBundle } = require('./instagramStory.service');

/**
 * Glue between the feed and the story/highlight sources.
 *
 * The feed comes from Instagram's private API (pooled session + proxy); the
 * stories and highlights come from third-party viewers over a plain fetch. This
 * module decides whether to run the second lookup for a feed request and how the
 * result is grafted onto the converted web_profile_info JSON as its own nodes:
 *
 *   { data: { user: … }, status, stories, highlights, highlight_details }
 */

/** Query strings deliver booleans as text, so accept both spellings. */
function flag(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  const s = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(s)) return true;
  if (['0', 'false', 'no', 'off'].includes(s)) return false;
  return fallback;
}

function int(value, fallback) {
  const parsed = parseInt(value, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

/**
 * Merge env defaults with the per-request overrides a caller may send:
 *   includeStories / includeStoryHighlights - run the lookup at all
 *   includeHighlightDetails                 - expand each highlight bubble
 *   highlightDetailLimit                    - cap the expansion (0 = all)
 */
function resolveStoryOptions(opts = {}) {
  const defaults = storyConfig.feed;
  const rawValue =
    opts.includeStories ??
    opts.include_stories ??
    opts.includeStoriesAndHighlights ??
    opts.includeStoryHighlights ??
    opts.stories;
  const enabled = flag(rawValue, false);
  return {
    enabled,
    includeHighlightDetails: flag(
      opts.includeHighlightDetails ?? opts.highlightDetails,
      defaults.includeHighlightDetails
    ),
    highlightDetailLimit: int(opts.highlightDetailLimit, defaults.highlightDetailLimit),
    highlightDetailConcurrency: defaults.highlightDetailConcurrency,
  };
}

/**
 * Fetch stories + highlights for a handle. Thin wrapper that keeps this
 * module's option names and, like collectStoryBundle, never rejects — the feed
 * must survive a broken story source.
 */
function fetchStoryBundle(username, options) {
  return collectStoryBundle(username, {
    includeHighlightDetails: options.includeHighlightDetails,
    highlightDetailLimit: options.highlightDetailLimit,
    highlightDetailConcurrency: options.highlightDetailConcurrency,
  }).catch((err) => ({
    profile: null,
    stories: [],
    highlights: [],
    highlightDetails: [],
    source: null,
    highlightSource: null,
    truncated: false,
    error: err.message || 'Story lookup failed.',
  }));
}

/**
 * Reshape the expanded highlights into one node per highlight, keyed by the
 * highlight id:
 *
 *   { "18142207969557132": { id, title, coverUrl, source, count, error, items } }
 *
 * A map rather than a list so a consumer holding a highlight id can read its
 * media directly, without scanning.
 *
 * @param {Array} details bundle.highlightDetails
 * @returns {Object}
 */
function detailsById(details) {
  const byId = {};
  for (const detail of details || []) {
    if (detail && detail.id) byId[detail.id] = detail;
  }
  return byId;
}

/**
 * Graft the bundle onto a converted feed response as separate top-level nodes.
 *
 * The nodes are always present once the lookup ran, each with an `available`
 * flag, so consumers can rely on the shape instead of probing for keys. Empty
 * results carry `available: false` plus the reason in `error` when there was one.
 *
 * @param {object} response web_profile_info-shaped feed response (mutated)
 * @param {object|null} bundle result of fetchStoryBundle
 * @param {object} options resolved story options
 * @returns {object} the same response object
 */
function attachStoryNodes(response, bundle, options = {}) {
  if (!response || typeof response !== 'object') return response;

  const stories = bundle?.stories || [];
  const highlights = bundle?.highlights || [];
  const details = bundle?.highlightDetails || [];
  const byId = detailsById(details);
  const error = bundle?.error || null;

  response.stories = {
    available: stories.length > 0,
    count: stories.length,
    source: bundle?.source || null,
    // A zero count is only "this account has none" when error is null; when a
    // source was throttled or its session expired, that is named here instead.
    error: error || bundle?.storiesError || null,
    items: stories,
  };

  response.highlights = {
    available: highlights.length > 0,
    count: highlights.length,
    // Its own source: the highlight list falls back to anonstories independently
    // of the stories, so this often differs from stories.source.
    source: bundle?.highlightSource || null,
    error: error || bundle?.highlightsError || null,
    items: highlights.map((highlight) => ({
      ...highlight,
      // Cross-reference: the key to look this bubble up under highlight_details.
      itemCount: byId[highlight.id]?.count ?? null,
    })),
  };

  if (options.includeHighlightDetails) {
    response.highlight_details = {
      available: details.some((d) => d.count > 0),
      count: details.length,
      // True when there were more bubbles than highlightDetailLimit allowed.
      truncated: Boolean(bundle?.truncated),
      error: error || bundle?.highlightsError || null,
      // One node per highlight, keyed by highlight id.
      items: byId,
    };
  }

  return response;
}

/**
 * The handle to look stories up by. The feed endpoint accepts a numeric pk or a
 * username, but the story sources only understand a username, so prefer what
 * the feed response resolved and fall back to a non-numeric input.
 */
function storyHandle(response, userId) {
  const fromFeed = response?.data?.user?.username;
  if (fromFeed) return fromFeed;
  const raw = String(userId ?? '').trim();
  return raw && !/^\d+$/.test(raw) ? raw : null;
}

module.exports = {
  resolveStoryOptions,
  fetchStoryBundle,
  attachStoryNodes,
  detailsById,
  storyHandle,
  flag,
};
