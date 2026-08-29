'use strict';

/**
 * convertedFeed.js — one handle's posts, stories, highlights and highlight
 * stories from the anonyig hub, emitted in this project's **converted** JSON:
 * the web_profile_info-shaped feed response with the story nodes grafted on.
 *
 *   { data: { user: … }, status, stories, highlights, highlight_details }
 *
 * That is the same contract /api/user-feed produces via
 * ../utils/mapFeedToWebProfile.js + ../services/feedStoryMerge.js, so a client
 * that already reads the feed reads this unchanged — the difference is only
 * where it came from: one upstream, no pooled session and no proxy.
 *
 * The mappers work off the hub's **raw** payloads rather than ./client.js's
 * normalizers, because the converted shape needs what those flatten away:
 * carousel children grouped under their parent, thumbnail ladders, and the
 * profile counts. Everything is read defensively — a missing field becomes
 * null, never an exception, since a single odd post must not fail the request.
 */

const { mapWithConcurrency } = require('../utils/helpers');
const { AnonyIGError } = require('./client');

const THUMBNAIL_SIZES = [150, 240, 320, 480, 640];

const num = (value) => (typeof value === 'number' ? value : null);
const str = (value) => (value === null || value === undefined ? null : String(value));

/** display_resources / candidates -> [{ url, width }], smallest first. */
function resolutions(node) {
  const list = Array.isArray(node?.display_resources) ? node.display_resources : [];
  return list
    .map((r) => ({ url: r.src ?? r.url ?? null, width: r.config_width ?? r.width ?? 0 }))
    .filter((r) => r.url)
    .sort((a, b) => a.width - b.width);
}

/** Smallest rendition at least `width` wide, else the largest there is. */
function atLeast(sorted, width) {
  if (!sorted.length) return null;
  return (sorted.find((r) => r.width >= width) || sorted[sorted.length - 1]).url;
}

function thumbnailResources(sorted) {
  if (!sorted.length) return [];
  return THUMBNAIL_SIZES.map((w) => ({
    src: atLeast(sorted, w),
    config_width: w,
    config_height: w,
  }));
}

/** Largest image candidate from a story / highlight item. */
const bestCandidate = (item) => {
  const candidates = item?.image_versions2?.candidates;
  return (Array.isArray(candidates) && candidates[0]?.url) || null;
};

const videoOf = (item) => (Array.isArray(item?.video_versions) ? item.video_versions[0]?.url : null) || null;

// ------------------------------------------------------------------ profile

/**
 * The hub's userInfo user -> the converted `data.user`, minus the media edges.
 * Field-for-field the same object buildWebProfileResponse emits.
 */
function toUserNode(user) {
  return {
    id: str(user?.pk ?? user?.id ?? ''),
    username: user?.username ?? null,
    full_name: user?.full_name ?? null,
    is_private: Boolean(user?.is_private),
    is_verified: Boolean(user?.is_verified),
    profile_pic_url: user?.profile_pic_url ?? null,
    profile_pic_url_hd: user?.profile_pic_url_hd ?? user?.profile_pic_url ?? null,
    edge_followed_by: { count: num(user?.follower_count) ?? 0 },
    edge_follow: { count: num(user?.following_count) ?? 0 },
  };
}

// -------------------------------------------------------------------- posts

/** One carousel child of a GraphSidecar. */
function toChildNode(child, parent) {
  const isVideo = Boolean(child?.is_video);
  return {
    __typename: child?.__typename ?? (isVideo ? 'GraphVideo' : 'GraphImage'),
    id: str(child?.id ?? ''),
    shortcode: child?.shortcode ?? parent?.shortcode ?? null,
    dimensions: {
      height: num(child?.dimensions?.height),
      width: num(child?.dimensions?.width),
    },
    display_url: child?.display_url ?? atLeast(resolutions(child), 1080),
    is_video: isVideo,
    ...(isVideo ? { video_url: child?.video_url_downloadable ?? child?.video_url ?? null } : {}),
  };
}

/** A postsV2 edge node -> a converted `edge_owner_to_timeline_media` node. */
function toPostNode(node, owner) {
  const sorted = resolutions(node);
  const isVideo = Boolean(node?.is_video);
  const children = node?.edge_sidecar_to_children?.edges;

  const converted = {
    __typename: node?.__typename ?? (isVideo ? 'GraphVideo' : 'GraphImage'),
    id: str(node?.id ?? ''),
    shortcode: node?.shortcode ?? null,
    dimensions: {
      height: num(node?.dimensions?.height),
      width: num(node?.dimensions?.width),
    },
    display_url: node?.display_url ?? atLeast(sorted, 1080),
    edge_media_to_tagged_user: { edges: node?.edge_media_to_tagged_user?.edges ?? [] },
    fact_check_overall_rating: null,
    fact_check_information: null,
    gating_info: null,
    sharing_friction_info: { should_have_sharing_friction: false, bloks_app_url: null },
    media_overlay_info: null,
    owner: { id: owner.id, username: owner.username },
    is_video: isVideo,
    accessibility_caption: node?.accessibility_caption ?? null,
    edge_media_to_caption: { edges: node?.edge_media_to_caption?.edges ?? [] },
    edge_media_to_comment: { count: num(node?.edge_media_to_comment?.count) ?? 0 },
    comments_disabled: Boolean(node?.comments_disabled),
    taken_at_timestamp: num(node?.taken_at_timestamp),
    edge_liked_by: { count: num(node?.edge_media_preview_like?.count) ?? 0 },
    edge_media_preview_like: { count: num(node?.edge_media_preview_like?.count) ?? 0 },
    location: node?.location ?? null,
    thumbnail_src: atLeast(sorted, 640),
    thumbnail_resources: thumbnailResources(sorted),
    viewer_can_reshare: true,
    like_and_view_counts_disabled: Boolean(node?.like_and_view_counts_disabled),
    product_type: node?.product_type ?? null,
  };

  if (isVideo) {
    converted.has_audio = node?.has_audio ?? true;
    converted.video_url = node?.video_url_downloadable ?? node?.video_url ?? null;
    converted.video_view_count = num(node?.video_view_count) ?? 0;
    converted.dash_info = {
      is_dash_eligible: false,
      video_dash_manifest: null,
      number_of_qualities: 0,
    };
  }

  if (children?.length) {
    converted.edge_sidecar_to_children = {
      edges: children.map((edge) => ({ node: toChildNode(edge?.node, node) })),
    };
  }

  return converted;
}

// ------------------------------------------------------- stories & highlights

/**
 * A story item -> the shape parseStoryItems() produces for the other sources
 * (`storyUrl` is the image or video poster; `videoUrl` is set only for video).
 */
function toStoryItem(item, username) {
  const video = videoOf(item);
  return {
    username: username || null,
    type: video ? 'video' : 'image',
    storyUrl: bestCandidate(item),
    videoUrl: video,
    createdAt: num(item?.taken_at),
    storyDate: num(item?.taken_at),
    isVideo: Boolean(video),
  };
}

/** A highlight tray -> the bubble shape parseHighlights() produces. */
function toHighlightBubble(highlight, username) {
  return {
    // Numeric, matching the ids the other story sources return and the ones
    // /api/instagram/highlights/:highlightId expects.
    id: str(highlight?.id).replace(/^highlight:/, ''),
    title: highlight?.title ?? null,
    coverUrl: highlight?.cover_media?.cropped_image_version?.url ?? null,
    username: username || null,
  };
}

/** A highlight's story -> the shape parseHighlightDetails() produces. */
function toHighlightItem(item) {
  const video = videoOf(item);
  return {
    mediaUrl: bestCandidate(item),
    videoUrl: video,
    type: video ? 'video' : 'image',
    isVideo: Boolean(video),
    created: num(item?.taken_at),
  };
}

// ----------------------------------------------------------------- assembly

/** Walk `pages` of the posts feed, keeping the raw edges. */
async function collectPosts(ig, username, pages) {
  const edges = [];
  let pageInfo = null;
  let cursor = '';

  for (let i = 0; i < pages; i++) {
    const payload = await ig.postsPage(username, cursor);
    const result = payload?.result;
    if (!result) break;
    edges.push(...(result.edges || []));
    pageInfo = result.page_info || null;
    if (!pageInfo?.has_next_page || !pageInfo.end_cursor) break;
    cursor = pageInfo.end_cursor;
  }

  return { edges, pageInfo };
}

/**
 * Highlight trays plus the stories inside each one, fanned out `concurrency` at
 * a time. A bubble that fails carries its own `error` instead of sinking the
 * others — the same bargain collectStoryBundle() makes.
 */
async function collectHighlights(ig, username, userId, { withDetails, limit, concurrency }) {
  const payload = await ig.highlightsRaw(userId);
  const trays = payload?.result || [];
  const bubbles = trays.map((tray) => toHighlightBubble(tray, username));

  if (!withDetails || !bubbles.length) {
    return { bubbles, details: [], truncated: false };
  }

  // One upstream call per bubble, so honour the cap and record when it bit.
  const selected = limit > 0 ? trays.slice(0, limit) : trays;
  const details = await mapWithConcurrency(selected, Math.max(1, concurrency), async (tray) => {
    const bubble = toHighlightBubble(tray, username);
    try {
      const stories = await ig.highlightStoriesRaw(tray.id);
      const items = (stories?.result || []).map(toHighlightItem);
      return { ...bubble, source: 'anonyig', count: items.length, items, error: null };
    } catch (err) {
      return { ...bubble, source: null, count: 0, items: [], error: err.message };
    }
  });

  return { bubbles, details, truncated: selected.length < trays.length };
}

/**
 * Build the converted response for one handle.
 *
 * The profile header is resolved first (the highlights tray is keyed by the
 * numeric user id), then posts, stories and highlights run concurrently over the
 * client's single h2 session. Only a failure to resolve the handle rejects;
 * anything else is reported in the node it belongs to, so a partial answer still
 * comes back — a private account has posts and no stories, and that is a valid
 * result rather than an error.
 *
 * @param {import('./client').AnonyIG} ig
 * @param {string} username
 * @param {object} [opts]
 * @param {number}  [opts.pages=1]                  post pages to walk
 * @param {boolean} [opts.includeHighlightDetails]  expand each bubble's stories
 * @param {number}  [opts.highlightDetailLimit=0]   0 = expand every bubble
 * @param {number}  [opts.highlightDetailConcurrency]
 */
async function buildConvertedFeed(ig, username, opts = {}) {
  const {
    pages = 1,
    includeStories = false,
    includeHighlightDetails = true,
    highlightDetailLimit = 0,
    highlightDetailConcurrency = ig.concurrency,
  } = opts;

  const errors = {};

  const [profile, posts] = await Promise.all([
    ig.userInfo(username),
    collectPosts(ig, username, pages).catch((err) => {
      errors.posts = err.message;
      return { edges: [], pageInfo: null };
    }),
  ]);

  const user = profile?.result?.[0]?.user;
  if (!user) {
    throw new AnonyIGError(`no user data for "${username}"`, {
      code: 'USER_NOT_FOUND',
      endpoint: 'userInfo',
      body: profile,
    });
  }

  const userNode = toUserNode(user);
  const owner = { id: userNode.id, username: userNode.username };

  const [stories, highlights] = includeStories
    ? await Promise.all([
        ig
          .storiesRaw(username)
          .then((payload) => (payload?.result || []).map((item) => toStoryItem(item, userNode.username)))
          .catch((err) => {
            errors.stories = err.message;
            return [];
          }),
        collectHighlights(ig, username, userNode.id, {
          withDetails: includeHighlightDetails,
          limit: highlightDetailLimit,
          concurrency: highlightDetailConcurrency,
        }).catch((err) => {
          errors.highlights = err.message;
          return { bubbles: [], details: [], truncated: false };
        }),
      ])
    : [[], { bubbles: [], details: [], truncated: false }];

  // Keyed by highlight id, so a consumer holding one can read its media without
  // scanning — the same map feedStoryMerge.detailsById() builds.
  const detailsById = {};
  for (const detail of highlights.details) {
    if (detail.id) detailsById[detail.id] = detail;
  }

  const response = {
    data: {
      user: {
        ...userNode,
        edge_owner_to_timeline_media: {
          count: num(user.media_count) ?? posts.edges.length,
          page_info: {
            has_next_page: Boolean(posts.pageInfo?.has_next_page),
            end_cursor: posts.pageInfo?.end_cursor ?? null,
          },
          edges: posts.edges.map((edge) => ({ node: toPostNode(edge?.node, owner) })),
        },
      },
    },
    status: 'ok',
    source: 'anonyig',
    // Present only when a part failed; the nodes below still describe themselves.
    errors: Object.keys(errors).length ? errors : null,
  };

  if (includeStories) {
    response.stories = {
      available: stories.length > 0,
      count: stories.length,
      source: errors.stories ? null : 'anonyig',
      error: errors.stories || null,
      items: stories,
    };

    response.highlights = {
      available: highlights.bubbles.length > 0,
      count: highlights.bubbles.length,
      source: errors.highlights ? null : 'anonyig',
      error: errors.highlights || null,
      items: highlights.bubbles.map((bubble) => ({
        ...bubble,
        // Cross-reference: the key to look this bubble up under highlight_details.
        itemCount: detailsById[bubble.id]?.count ?? null,
      })),
    };

    if (includeHighlightDetails) {
      response.highlight_details = {
        available: highlights.details.some((d) => d.count > 0),
        count: highlights.details.length,
        // True when there were more bubbles than highlightDetailLimit allowed.
        truncated: highlights.truncated,
        error: errors.highlights || null,
        items: detailsById,
      };
    }
  }

  return response;
}

module.exports = {
  buildConvertedFeed,
  toUserNode,
  toPostNode,
  toStoryItem,
  toHighlightBubble,
  toHighlightItem,
};
