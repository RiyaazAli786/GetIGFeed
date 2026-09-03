'use strict';

/**
 * convertedFeed.js — fetches user, posts, stories, highlights and highlight
 * stories from the FastDL hub, emitted in the converted JSON shape:
 *
 *   { data: { user: … }, status, source: "fastdl", stories, highlights, highlight_details }
 */

const { mapWithConcurrency } = require('../utils/helpers');
const { pickCount } = require('../utils/mapFeedToWebProfile');
const { FastDLError } = require('./client');

const THUMBNAIL_SIZES = [150, 240, 320, 480, 640];

const num = (value) => (typeof value === 'number' ? value : null);
const str = (value) => (value === null || value === undefined ? null : String(value));

function resolutions(node) {
  const list = Array.isArray(node?.display_resources) ? node.display_resources : [];
  return list
    .map((r) => ({ url: r.src ?? r.url ?? null, width: r.config_width ?? r.width ?? 0 }))
    .filter((r) => r.url)
    .sort((a, b) => a.width - b.width);
}

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

const bestCandidate = (item) => {
  const candidates = item?.image_versions2?.candidates;
  return (Array.isArray(candidates) && candidates[0]?.url) || null;
};

const videoOf = (item) => (Array.isArray(item?.video_versions) ? item.video_versions[0]?.url : null) || null;

// ------------------------------------------------------------------ profile

function toUserNode(user) {
  return {
    id: str(user?.pk ?? user?.id ?? ''),
    username: user?.username ?? null,
    full_name: user?.full_name ?? null,
    is_private: Boolean(user?.is_private),
    is_verified: Boolean(user?.is_verified),
    profile_pic_url: user?.profile_pic_url ?? null,
    profile_pic_url_hd: user?.profile_pic_url_hd ?? user?.profile_pic_url ?? null,
    edge_followed_by: {
      count: pickCount(user, 'follower_count', 'edge_followed_by', 'followers_count', 'followers') ?? 0,
    },
    edge_follow: {
      count: pickCount(user, 'following_count', 'edge_follow', 'follows_count', 'following') ?? 0,
    },
  };
}

// -------------------------------------------------------------------- posts

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

function toHighlightBubble(highlight, username) {
  return {
    id: str(highlight?.id).replace(/^highlight:/, ''),
    title: highlight?.title ?? null,
    coverUrl: highlight?.cover_media?.cropped_image_version?.url ?? null,
    username: username || null,
  };
}

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

async function collectHighlights(ig, username, userId, { withDetails, limit, concurrency }) {
  const payload = await ig.highlightsRaw(userId);
  const trays = payload?.result || [];
  const bubbles = trays.map((tray) => toHighlightBubble(tray, username));

  if (!withDetails || !bubbles.length) {
    return { bubbles, details: [], truncated: false };
  }

  const selected = limit > 0 ? trays.slice(0, limit) : trays;
  const details = await mapWithConcurrency(selected, Math.max(1, concurrency), async (tray) => {
    const bubble = toHighlightBubble(tray, username);
    try {
      const stories = await ig.highlightStoriesRaw(tray.id);
      const items = (stories?.result || []).map(toHighlightItem);
      return { ...bubble, source: 'fastdl', count: items.length, items, error: null };
    } catch (err) {
      return { ...bubble, source: null, count: 0, items: [], error: err.message };
    }
  });

  return { bubbles, details, truncated: selected.length < trays.length };
}

async function buildConvertedFeed(ig, username, opts = {}) {
  const {
    pages = 1,
    includeHighlightDetails = true,
    highlightDetailLimit = 0,
    highlightDetailConcurrency = ig.concurrency || 4,
  } = opts;

  const profile = await ig.userInfo(username);
  const user = profile?.result?.[0]?.user;
  if (!user) {
    throw new FastDLError(`no user data for "${username}"`, {
      code: 'USER_NOT_FOUND',
      endpoint: 'userInfo',
      body: profile,
    });
  }

  const userNode = toUserNode(user);
  const owner = { id: userNode.id, username: userNode.username };
  const errors = {};

  const [posts, stories, highlights] = await Promise.all([
    collectPosts(ig, username, pages).catch((err) => {
      errors.posts = err.message;
      return { edges: [], pageInfo: null };
    }),
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
  ]);

  const detailsById = {};
  for (const detail of highlights.details) {
    if (detail.id) detailsById[detail.id] = detail;
  }

  const response = {
    data: {
      user: {
        ...userNode,
        edge_owner_to_timeline_media: {
          count: pickCount(user, 'media_count', 'edge_owner_to_timeline_media', 'posts_count') ?? posts.edges.length,
          page_info: {
            has_next_page: Boolean(posts.pageInfo?.has_next_page),
            end_cursor: posts.pageInfo?.end_cursor ?? null,
          },
          edges: posts.edges.map((edge) => ({ node: toPostNode(edge?.node, owner) })),
        },
      },
    },
    status: 'ok',
    source: 'fastdl',
    errors: Object.keys(errors).length ? errors : null,

    stories: {
      available: stories.length > 0,
      count: stories.length,
      source: errors.stories ? null : 'fastdl',
      error: errors.stories || null,
      items: stories,
    },

    highlights: {
      available: highlights.bubbles.length > 0,
      count: highlights.bubbles.length,
      source: errors.highlights ? null : 'fastdl',
      error: errors.highlights || null,
      items: highlights.bubbles.map((bubble) => ({
        ...bubble,
        itemCount: detailsById[bubble.id]?.count ?? null,
      })),
    },
  };

  if (includeHighlightDetails) {
    response.highlight_details = {
      available: highlights.details.some((d) => d.count > 0),
      count: highlights.details.length,
      truncated: highlights.truncated,
      error: errors.highlights || null,
      items: detailsById,
    };
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
