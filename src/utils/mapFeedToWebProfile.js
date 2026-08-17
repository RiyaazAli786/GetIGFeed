'use strict';

/**
 * Convert Instagram private feed/user `items[]` into the public
 * web_profile_info response shape:
 *   { data: { user: { edge_owner_to_timeline_media: { edges: [{ node }] } } }, status }
 *
 * Only fields available from the feed/user payload are populated.
 */

const TYPENAME = { 1: 'GraphImage', 2: 'GraphVideo', 8: 'GraphSidecar' };

/** Largest image candidate (candidates[0] is the biggest). */
function bestImageUrl(media) {
  const c = media?.image_versions2?.candidates;
  return Array.isArray(c) && c.length ? c[0].url : null;
}

/** A ~640px (or smallest available ≥640) thumbnail url. */
function thumbUrl(media) {
  const c = media?.image_versions2?.candidates;
  if (!Array.isArray(c) || !c.length) return null;
  const sorted = [...c].sort((a, b) => a.width - b.width);
  return (sorted.find((x) => x.width >= 640) || sorted[sorted.length - 1]).url;
}

/** thumbnail_resources for the standard sizes web_profile_info exposes. */
function thumbResources(media) {
  const c = media?.image_versions2?.candidates;
  if (!Array.isArray(c) || !c.length) return [];
  const sorted = [...c].sort((a, b) => a.width - b.width);
  return [150, 240, 320, 480, 640].map((w) => {
    const pick = sorted.find((x) => x.width >= w) || sorted[sorted.length - 1];
    return { src: pick.url, config_width: w, config_height: w };
  });
}

function captionEdges(item) {
  const text = item.caption?.text;
  return { edges: text ? [{ node: { text } }] : [] };
}

function taggedUsers(item) {
  const ins = item.usertags?.in || [];
  return {
    edges: ins.map((t) => ({
      node: {
        user: {
          full_name: t.user?.full_name ?? '',
          followed_by_viewer: false,
          id: String(t.user?.pk ?? t.user?.id ?? ''),
          is_verified: Boolean(t.user?.is_verified),
          profile_pic_url: t.user?.profile_pic_url ?? null,
          username: t.user?.username ?? '',
        },
        x: Array.isArray(t.position) ? t.position[0] : 0,
        y: Array.isArray(t.position) ? t.position[1] : 0,
      },
    })),
  };
}

/**
 * Read a count that Instagram spells differently depending on which endpoint
 * the profile came from (private feed/user info vs. public web_profile_info).
 * Returns null when none of the aliases are present, so callers can tell
 * "not in the response" apart from a genuine 0.
 */
function pickCount(user, ...keys) {
  for (const key of keys) {
    const v = user?.[key];
    if (typeof v === 'number') return v;
    // web_profile_info style: { count: n }
    if (v && typeof v.count === 'number') return v.count;
  }
  return null;
}

/**
 * The user's numeric pk, as a string. `pk_id` (private API) and `id` (web API)
 * are the string spellings and are preferred over the numeric `pk`, which can
 * lose precision in JSON.parse for very large ids. Falls back to whatever the
 * caller looked the user up by when the response carried no id at all.
 */
function pickId(user, fallback) {
  for (const v of [user?.pk_id, user?.id, user?.pk]) {
    if (v === null || v === undefined) continue;
    const s = String(v).trim();
    if (/^\d+$/.test(s)) return s;
  }
  return String(fallback ?? '');
}

/** The highest-resolution profile picture the payload offers. */
function hdProfilePic(user) {
  const info = user?.hd_profile_pic_url_info?.url;
  if (info) return info;

  const versions = user?.hd_profile_pic_versions;
  if (Array.isArray(versions) && versions.length) {
    const biggest = [...versions].sort((a, b) => (b.width ?? 0) - (a.width ?? 0))[0];
    if (biggest?.url) return biggest.url;
  }

  // Already-mapped payloads, then the standard-res picture as the fallback —
  // web_profile_info always populates profile_pic_url_hd.
  return user?.profile_pic_url_hd ?? user?.profile_pic_url ?? null;
}

function mapLocation(loc) {
  if (!loc) return null;
  return {
    id: String(loc.pk ?? loc.id ?? ''),
    has_public_page: Boolean(loc.has_public_page),
    name: loc.name ?? null,
    slug: loc.slug ?? '',
  };
}

/** The image used for display_url (carousel → first child). */
function displayUrl(item) {
  if (item.media_type === 8 && Array.isArray(item.carousel_media) && item.carousel_media.length) {
    return bestImageUrl(item.carousel_media[0]);
  }
  return bestImageUrl(item);
}

/** Build one edge node from a feed/user media item. */
function buildNode(item) {
  const isVideo = item.media_type === 2;
  const node = {
    __typename: TYPENAME[item.media_type] || 'GraphImage',
    id: String(item.pk ?? item.id ?? ''),
    shortcode: item.code ?? null,
    dimensions: {
      height: item.original_height ?? null,
      width: item.original_width ?? null,
    },
    display_url: displayUrl(item),
    edge_media_to_tagged_user: taggedUsers(item),
    fact_check_overall_rating: null,
    fact_check_information: null,
    gating_info: null,
    sharing_friction_info: { should_have_sharing_friction: false, bloks_app_url: null },
    media_overlay_info: null,
    owner: {
      id: String(item.user?.pk ?? item.user?.id ?? ''),
      username: item.user?.username ?? null,
    },
    is_video: isVideo,
    accessibility_caption: item.accessibility_caption ?? null,
    edge_media_to_caption: captionEdges(item),
    edge_media_to_comment: { count: item.comment_count ?? 0 },
    comments_disabled: Boolean(item.comments_disabled),
    taken_at_timestamp: item.taken_at ?? null,
    edge_liked_by: { count: item.like_count ?? 0 },
    edge_media_preview_like: { count: item.like_count ?? 0 },
    location: mapLocation(item.location),
    thumbnail_src: thumbUrl(item),
    thumbnail_resources: thumbResources(item),
    viewer_can_reshare: true,
    like_and_view_counts_disabled: Boolean(item.like_and_view_counts_disabled),
    product_type: item.product_type ?? null,
  };

  if (isVideo) {
    node.has_audio = item.has_audio ?? true;
    node.video_url = item.video_versions?.[0]?.url ?? null;
    node.video_view_count = item.play_count ?? item.view_count ?? item.ig_play_count ?? 0;
    node.dash_info = {
      is_dash_eligible: false,
      video_dash_manifest: null,
      number_of_qualities: Array.isArray(item.video_versions) ? item.video_versions.length : 0,
    };
  }

  // Carousel children (edge_sidecar_to_children), when present.
  if (item.media_type === 8 && Array.isArray(item.carousel_media)) {
    node.edge_sidecar_to_children = {
      edges: item.carousel_media.map((child) => ({
        node: {
          __typename: child.media_type === 2 ? 'GraphVideo' : 'GraphImage',
          id: String(child.pk ?? child.id ?? ''),
          shortcode: child.code ?? item.code ?? null,
          dimensions: {
            height: child.original_height ?? null,
            width: child.original_width ?? null,
          },
          display_url: bestImageUrl(child),
          is_video: child.media_type === 2,
          ...(child.media_type === 2
            ? { video_url: child.video_versions?.[0]?.url ?? null }
            : {}),
        },
      })),
    };
  }

  return node;
}

/**
 * Build the full web_profile_info-shaped response from feed items.
 * @param {object[]} items - feed/user items[]
 * @param {object} meta - { userId, hasMore, maxId, count, user }
 * @param {object} [meta.user] - the profile object from the original Instagram
 *   response (feed `user`, or `users/{id}/info/` → `user`). Merged under the
 *   per-item owner, which only carries a thin subset of the profile.
 */
function buildWebProfileResponse(items, meta = {}) {
  const list = Array.isArray(items) ? items : [];
  const edges = list.map((it) => ({ node: buildNode(it) }));
  // The per-item owner is a thin copy of the profile; the standalone profile
  // object from the response (when present) is richer and wins.
  const owner = { ...(list[0]?.user || {}), ...(meta.user || {}) };

  return {
    data: {
      user: {
        // The numeric pk from the response, not meta.userId — callers may pass a
        // username there (the feed endpoint accepts either), and `id` must be
        // the pk. pk_id / id come first because they are the string forms and
        // survive JSON.parse intact; meta.userId is only the last resort.
        id: pickId(owner, meta.userId),
        username: owner.username ?? null,
        full_name: owner.full_name ?? null,
        is_private: owner.is_private ?? false,
        is_verified: owner.is_verified ?? false,
        profile_pic_url: owner.profile_pic_url ?? null,
        profile_pic_url_hd: hdProfilePic(owner),
        // Consumers treat these as required — always emit a number rather than
        // letting a missing count surface as undefined.
        edge_followed_by: {
          count: pickCount(owner, 'follower_count', 'edge_followed_by', 'followers_count') ?? 0,
        },
        edge_follow: {
          count: pickCount(owner, 'following_count', 'edge_follow', 'follows_count') ?? 0,
        },
        edge_owner_to_timeline_media: {
          count: meta.count ?? edges.length,
          page_info: {
            has_next_page: Boolean(meta.hasMore),
            end_cursor: meta.maxId ?? null,
          },
          edges,
        },
      },
    },
    status: 'ok',
  };
}

module.exports = { buildWebProfileResponse, buildNode, pickCount };
