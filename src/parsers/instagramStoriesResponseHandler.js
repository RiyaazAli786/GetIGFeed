'use strict';

const { parseJson, getValue, getArray, toInt, toBool } = require('../utils/json');
const {
  fromBase64,
  firstNonEmpty,
  parseCreatedTime,
  decodeEmbedUrl,
} = require('../utils/strings');

/**
 * Port of GramDominatorCore.Response.InstagramStoriesResponseHandler
 * (StorySource.Storynavigation, non-browser branch).
 *
 * Every section is individually try/catch-ed exactly like the C# original, so a
 * broken profile payload still lets the stories/highlights through.
 *
 * The story and highlight sections are also exported on their own: the service
 * decides whether to fall back to anonstories.com by asking whether a payload
 * actually parsed into anything, which is the only reliable health signal (see
 * instagramStory.service.js).
 */

/** Media urls arrive base64-encoded (storynavigation) or embed-wrapped (anon). */
function directUrl(value) {
  if (!value) return null;
  return fromBase64(value) || decodeEmbedUrl(value) || null;
}

/** First non-empty value among several spellings of the same field. */
function readFirst(obj, node, ...keys) {
  return firstNonEmpty(...keys.map((key) => getValue(obj, node, key)));
}

/**
 * Active stories, from either source shape:
 *   storynavigation -> { lastStories: [ { type, thumbnailUrl, videoUrl, createdTime } ] }
 *   anonstories     -> { stories:    [ { media_type, thumbnail, source, taken_at } ] }
 *
 * @param {string} storyResponse raw body
 * @param {string} [username] stamped onto each item
 * @returns {Array} never throws; [] when nothing parsed
 */
function parseStoryItems(storyResponse, username) {
  try {
    const obj = parseJson(storyResponse);
    let stories = getArray(obj.lastStories);
    if (!stories.length) stories = getArray(obj.stories);
    if (!stories.length) return [];

    const now = new Date();
    return stories.map((story) => {
      const media = {
        username: username || null,
        type: firstNonEmpty(getValue(story, 'type'), getValue(story, 'media_type')),
        // storynavigation base64-encodes its urls; anonstories wraps them in an
        // embed.anonstories.com proxy link.
        storyUrl: directUrl(
          firstNonEmpty(
            getValue(story, 'thumbnailUrl'),
            getValue(story, 'thumbnail'),
            getValue(story, 'source')
          )
        ),
        videoUrl:
          fromBase64(getValue(story, 'videoUrl')) ||
          (String(getValue(story, 'media_type') || getValue(story, 'type')).includes('vid')
            ? decodeEmbedUrl(firstNonEmpty(getValue(story, 'source')))
            : null),
        createdAt: null,
        storyDate: null,
      };

      const created = parseCreatedTime(getValue(story, 'createdTime').trim(), now);
      media.createdAt = media.storyDate = created || getValue(story, 'taken_at') || null;
      media.isVideo = String(media.type || '').includes('vid');
      return media;
    });
  } catch {
    return [];
  }
}

/**
 * Highlight bubbles, from either source shape:
 *   storynavigation -> [ { id, title, imageThumbnail } ]
 *   anonstories     -> { highlights: [ { node: { id, title, cover_media: { thumbnail_src } } } ] }
 *
 * @param {string} highlightsResponse raw body
 * @param {string} [username] stamped onto each bubble
 * @returns {Array} never throws; [] when nothing parsed
 */
function parseHighlights(highlightsResponse, username) {
  const bubbles = [];
  try {
    let highlights = getArray(highlightsResponse);
    if (!highlights.length) highlights = getArray(parseJson(highlightsResponse).highlights);
    if (!highlights.length) return bubbles;

    const seen = new Set();
    for (const highlight of highlights) {
      const id = firstNonEmpty(getValue(highlight, 'id'), getValue(highlight, 'node', 'id'));
      const title = firstNonEmpty(
        getValue(highlight, 'title'),
        getValue(highlight, 'node', 'title')
      );
      const coverUrl = directUrl(
        firstNonEmpty(
          getValue(highlight, 'imageThumbnail'),
          getValue(highlight, 'node', 'cover_media', 'thumbnail_src'),
          getValue(highlight, 'cover_media', 'thumbnail_src')
        )
      );

      // An id is what makes a bubble expandable, so a nameless entry is dropped.
      if (!id || seen.has(id)) continue;
      seen.add(id);
      bubbles.push({ id, title, coverUrl, username: username || null });
    }
  } catch {
    // ignored
  }
  return bubbles;
}

/**
 * Which payload carries the profile, and under which node.
 *
 * storynavigation answers `{ found: true, accountInfo: {…} }`, but a failed
 * handshake answers `{ message: "CSRF token mismatch." }` — in that case the
 * only profile left is the `user_info` object the anonstories story / highlight
 * payloads carry, so those are tried in turn.
 */
function pickProfileSource(profileResponse, storyResponse, highlightsResponse) {
  const profile = parseJson(profileResponse);
  const notFound = String(getValue(profile, 'found')) === 'false';
  if (profile.accountInfo && !notFound) return { source: profileResponse, node: 'accountInfo' };

  for (const candidate of [storyResponse, highlightsResponse]) {
    if (candidate && parseJson(candidate).user_info) {
      return { source: candidate, node: 'user_info' };
    }
  }
  return { source: profileResponse, node: 'accountInfo' };
}

/**
 * @param {string} profileResponse   get-user-profile body
 * @param {string} storyResponse     get-user-last-stories body (or anonstories)
 * @param {string} otherProfile      i.theasmn.com/api/user body
 * @param {string} highlightsResponse get-user-highlights body (or anonstories)
 * @returns {{success:boolean, isPrivate:boolean, model:Object}}
 */
function parseStories(profileResponse, storyResponse, otherProfile, highlightsResponse) {
  const model = {
    id: null,
    username: null,
    fullName: null,
    profileUrl: null,
    profilePic: null,
    otherProfile: null,
    caption: 'N/A',
    isPrivate: false,
    postCount: 0,
    followerCount: 0,
    followingCount: 0,
    stories: [],
    highlights: [],
  };

  if (!profileResponse) return { success: false, isPrivate: false, model };

  let isPrivate = false;

  // ---- profile -----------------------------------------------------------
  try {
    const { source, node } = pickProfileSource(profileResponse, storyResponse, highlightsResponse);
    const obj = parseJson(source);

    // Both spellings are read: the fallback payloads are snake_case.
    model.id = readFirst(obj, node, 'id') || null;
    model.username = readFirst(obj, node, 'username') || null;
    if (model.username) model.profileUrl = `https://www.instagram.com/${model.username}/`;
    model.fullName = readFirst(obj, node, 'fullName', 'full_name') || null;
    model.caption = readFirst(obj, node, 'biography', 'bio') || model.caption;
    model.postCount = toInt(readFirst(obj, node, 'mediaCount', 'media_count'));
    model.followerCount = toInt(
      readFirst(obj, node, 'followedByCount', 'follower_count', 'followers')
    );
    model.followingCount = toInt(
      readFirst(obj, node, 'followsCount', 'following_count', 'following')
    );
    isPrivate = toBool(readFirst(obj, node, 'isPrivate', 'is_private'));
    model.isPrivate = isPrivate;

    const profilePic = readFirst(obj, node, 'profilePicUrl', 'profile_pic_url');
    if (profilePic) model.profilePic = directUrl(profilePic);

    updateMissingDetails(otherProfile, model);
  } catch {
    // ignored, same as the original
  }

  // ---- stories / highlights ----------------------------------------------
  model.stories = parseStoryItems(storyResponse, model.username);
  model.highlights = parseHighlights(highlightsResponse, model.username);

  return { success: model.stories.length > 0, isPrivate, model };
}

/**
 * Port of UpdateMissingDetails - the i.theasmn.com payload backfills anything
 * storynavigation.com left blank and supplies the fallback profile picture.
 */
function updateMissingDetails(otherProfile, model) {
  try {
    const obj = parseJson(otherProfile);
    model.otherProfile = getValue(obj, 'data', 'image') || null;
    if (!model.profilePic) model.profilePic = model.otherProfile;
    if (!model.username) model.username = getValue(obj, 'data', 'username') || null;
    if (model.username) model.profileUrl = `https://www.instagram.com/${model.username}/`;
    if (!model.caption || model.caption === 'N/A') {
      model.caption = getValue(obj, 'data', 'bio') || model.caption;
    }
    if (!model.fullName) {
      const name = `${getValue(obj, 'data', 'first_name')} ${getValue(obj, 'data', 'last_name')}`.trim();
      model.fullName = name || null;
    }
    if (model.postCount === 0) model.postCount = toInt(getValue(obj, 'data', 'media_count'));
    if (model.followerCount === 0) model.followerCount = toInt(getValue(obj, 'data', 'followers'));
    if (model.followingCount === 0) model.followingCount = toInt(getValue(obj, 'data', 'following'));
  } catch {
    // ignored
  }
}

module.exports = { parseStories, parseStoryItems, parseHighlights };
