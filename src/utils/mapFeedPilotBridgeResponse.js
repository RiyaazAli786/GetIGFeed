'use strict';

function mapStoryItem(item) {
  return {
    id: item.id || item.mediaId || '',
    code: item.code || null,
    mediaType: Number(item.mediaType || 1),
    displayUrl: item.displayUrl || item.videoUrl || null,
    videoUrl: item.videoUrl || null,
    takenAt: Number(item.takenAt || 0),
    expiringAt: Number(item.expiringAt || 0),
    mediaId: item.mediaId || item.id || '',
    url: item.code ? `https://www.instagram.com/stories/${item.code}/` : null,
  };
}

function mapFeedPilotBridgeResponse(input, bridgeMeta = {}) {
  const profile = input?.profile || {};
  const items = Array.isArray(input?.items) ? input.items : [];
  const stories = Array.isArray(input?.stories) ? input.stories : [];
  const highlights = Array.isArray(input?.highlights) ? input.highlights : [];

  const response = {
    data: {
      user: {
        id: profile.id || '',
        username: profile.username || '',
        full_name: profile.fullName || '',
        biography: profile.biography || '',
        profile_pic_url: profile.profilePicUrl || '',
        profile_pic_url_hd: profile.profilePicUrl || '',
        is_private: Boolean(profile.isPrivate),
        is_verified: Boolean(profile.isVerified),
        edge_followed_by: { count: Number(profile.followerCount || 0) },
        edge_follow: { count: Number(profile.followingCount || 0) },
        edge_owner_to_timeline_media: {
          count: Number(profile.mediaCount || items.length),
          page_info: {
            has_next_page: Boolean(input?.hasMore),
            end_cursor: input?.maxId || null,
          },
          edges: items.map((item) => ({
            node: {
              id: item.id || item.mediaId || item.code || '',
              shortcode: item.code || '',
              code: item.code || '',
              media_id: item.mediaId || item.id || '',
              display_url: item.displayUrl || item.videoUrl || null,
              video_url: item.videoUrl || null,
              is_video: Number(item.mediaType) === 2,
              media_type: Number(item.mediaType || 1),
              taken_at_timestamp: Number(item.takenAt || 0),
              edge_liked_by: { count: Number(item.likeCount || 0) },
              edge_media_to_comment: { count: Number(item.commentCount || 0) },
              edge_media_to_caption: {
                edges: item.caption
                  ? [{ node: { text: item.caption } }]
                  : [],
              },
              accessibility_caption: item.caption || null,
            },
          })),
        },
      },
    },
    feedpilot_bridge: {
      source: 'android-device',
      jobId: bridgeMeta.jobId || null,
      deviceId: bridgeMeta.deviceId || null,
      accountUsername: bridgeMeta.accountUsername || null,
      durationMs: bridgeMeta.durationMs || null,
    },
  };

  response.stories = {
    available: stories.length > 0,
    count: stories.length,
    source: stories.length > 0 ? 'android-device' : null,
    error: null,
    items: stories.map(mapStoryItem),
  };

  response.highlights = {
    available: highlights.length > 0,
    count: highlights.length,
    source: highlights.length > 0 ? 'android-device' : null,
    error: null,
    items: highlights.map((highlight) => ({
      id: highlight.id,
      title: highlight.title || null,
      coverUrl: highlight.coverUrl || null,
      itemCount: Array.isArray(highlight.items) ? highlight.items.length : 0,
    })),
  };

  response.highlight_details = {
    available: highlights.some((highlight) => Array.isArray(highlight.items) && highlight.items.length > 0),
    count: highlights.length,
    truncated: false,
    error: null,
    items: Object.fromEntries(
      highlights
        .filter((highlight) => highlight && highlight.id)
        .map((highlight) => [
          highlight.id,
          {
            id: highlight.id,
            title: highlight.title || null,
            coverUrl: highlight.coverUrl || null,
            source: Array.isArray(highlight.items) && highlight.items.length > 0 ? 'android-device' : null,
            count: Array.isArray(highlight.items) ? highlight.items.length : 0,
            items: Array.isArray(highlight.items) ? highlight.items.map(mapStoryItem) : [],
            error: null,
          },
        ])
    ),
  };

  return response;
}

module.exports = { mapFeedPilotBridgeResponse };
