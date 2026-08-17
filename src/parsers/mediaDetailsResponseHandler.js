'use strict';

const { getArray, getValue, parseJson } = require('../utils/json');
const { fromBase64, parseCreatedTime, decodeEmbedUrl } = require('../utils/strings');

/**
 * Port of GramDominatorCore.Response.MediaDetailsResponseHandler - the items
 * behind a single highlight bubble, as returned by
 * storynavigation.com/get-highlight-stories.
 *
 * Note: the C# dedupe check (`!Any(x => x.MediaUrl != model.MediaUrl)`) drops
 * every item after the first whenever URLs differ, which is clearly not the
 * intent. Here it dedupes by mediaUrl and keeps the rest.
 */
function parseHighlightDetails(response) {
  const details = [];
  try {
    const items = getArray(response);
    const seen = new Set();
    const now = new Date();

    for (const item of items) {
      const mediaUrl = fromBase64(getValue(item, 'thumbnailUrl'));
      if (!mediaUrl || seen.has(mediaUrl)) continue;
      seen.add(mediaUrl);

      const type = getValue(item, 'type') || null;

      details.push({
        mediaUrl,
        videoUrl: fromBase64(getValue(item, 'videoUrl')),
        type,
        isVideo: type === 'video',
        created: parseCreatedTime(getValue(item, 'createdTime'), now),
      });
    }
  } catch {
    // ignored
  }
  return details;
}

/**
 * anonstories.com/api/v1/highlight/stories fallback.
 *
 * Shape: { title, cover_media, latest_reel_media, items: [
 *   { media_type, source, thumbnail, taken_at, mentions, link } ] }
 * where source/thumbnail are embed.anonstories.com proxy links.
 *
 * @returns {{title: (string|null), items: Array}}
 */
function parseAnonHighlightDetails(response) {
  const result = { title: null, items: [] };
  try {
    const root = parseJson(response);
    result.title = root.title || null;

    const items = getArray(root.items);
    const seen = new Set();

    for (const item of items) {
      const type = getValue(item, 'media_type') || null;
      const isVideo = type.toLowerCase().includes('vid');
      const source = decodeEmbedUrl(getValue(item, 'source')) || null;
      const thumbnail = decodeEmbedUrl(getValue(item, 'thumbnail')) || null;

      const mediaUrl = isVideo ? thumbnail || source : source || thumbnail;
      if (!mediaUrl || seen.has(mediaUrl)) continue;
      seen.add(mediaUrl);

      result.items.push({
        mediaUrl,
        videoUrl: isVideo ? source : null,
        type: isVideo ? 'video' : 'image',
        isVideo,
        created: getValue(item, 'taken_at') || null,
        link: getValue(item, 'link') || null,
        mentions: getArray(item.mentions),
      });
    }
  } catch {
    // ignored
  }
  return result;
}

module.exports = { parseHighlightDetails, parseAnonHighlightDetails };
