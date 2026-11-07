'use strict';

const DEFAULT_TIMEOUT_MS = Number(process.env.FEEDPILOT_BRIDGE_TIMEOUT_MS || 35000);

const RESERVED_IG_ROUTES = new Set([
  'p',
  'reel',
  'reels',
  'tv',
  'stories',
  'explore',
  'accounts',
  'direct',
  'graphql',
  'feed',
  'api',
  'about',
  'developer',
  'legal',
  'privacy',
  'share',
  'tags',
]);

const POST_OR_REEL_PATTERN = /(?:^|\/|\?|#)(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)/i;
const STORIES_MEDIA_PATTERN = /(?:^|\/|\?|#)stories\/[^/?#]+\/\d+/i;

/**
 * Sanitize an Instagram username before dispatching to the FeedPilot Android Bridge.
 * - Strips leading '@' characters (e.g. @wwe -> wwe).
 * - Rejects any post URL, reels URL, TV URL, or media link (returns undefined).
 * - Resolves valid Instagram profile URLs (e.g. https://www.instagram.com/wwe/ -> wwe).
 * - Rejects strings containing internal '@' symbols.
 * - Rejects purely numeric IDs (numeric values are userIds, not username handles).
 * - Rejects reserved Instagram routes and invalid handle formats.
 *
 * @param {string|*} input
 * @returns {string|undefined} Clean handle or undefined
 */
function sanitizeBridgeUsername(input) {
  if (input == null) return undefined;
  let raw = String(input).trim();
  if (!raw) return undefined;

  // 1. Direct check for post, reel, reels, tv, or story media paths
  if (POST_OR_REEL_PATTERN.test(raw) || STORIES_MEDIA_PATTERN.test(raw)) {
    return undefined;
  }

  // 2. If it is formatted as a full URL or domain path
  if (/^https?:\/\//i.test(raw) || /(?:^|\.)(?:instagram\.com)\//i.test(raw)) {
    try {
      const urlStr = raw.startsWith('http://') || raw.startsWith('https://')
        ? raw
        : `https://${raw}`;
      const parsed = new URL(urlStr);
      let segments = parsed.pathname.split('/').filter(Boolean);
      if (!segments.length) return undefined;

      // Handle Instagram android deep link format /_u/<username>
      if (segments[0].toLowerCase() === '_u' && segments[1]) {
        segments = segments.slice(1);
      }

      const firstSegment = decodeURIComponent(segments[0]).toLowerCase().replace(/^@+/, '');
      if (RESERVED_IG_ROUTES.has(firstSegment)) {
        return undefined;
      }
      raw = decodeURIComponent(segments[0]);
    } catch {
      return undefined;
    }
  }

  // 3. Strip leading '@' characters
  raw = raw.replace(/^@+/, '').split(/[/?#]/)[0].trim();

  // 4. Must not contain any remaining '@' (e.g. emails or internal @)
  if (raw.includes('@')) {
    return undefined;
  }

  // 5. Must not be purely numeric (purely numeric is userId)
  if (/^\d+$/.test(raw)) {
    return undefined;
  }

  // 6. Must not be a reserved route or keyword
  if (RESERVED_IG_ROUTES.has(raw.toLowerCase())) {
    return undefined;
  }

  // 7. Must match valid Instagram username criteria (1-30 chars: a-z, 0-9, ., _)
  if (!/^[A-Za-z0-9._]{1,30}$/.test(raw)) {
    return undefined;
  }

  return raw;
}

function bridgeMode() {
  const mode = String(
    process.env.FEED_SOURCE_MODE ||
      process.env.FEEDPILOT_BRIDGE_MODE ||
      ''
  ).trim().toLowerCase();

  if (['pool', 'android_bridge', 'bridge_then_pool'].includes(mode)) {
    return mode;
  }

  if (bridgeEnabled()) return fallbackEnabled() ? 'bridge_then_pool' : 'android_bridge';
  return 'pool';
}

function bridgeEnabled() {
  const mode = String(
    process.env.FEED_SOURCE_MODE ||
      process.env.FEEDPILOT_BRIDGE_MODE ||
      ''
  ).trim().toLowerCase();
  if (mode === 'pool') return false;
  if (mode === 'android_bridge' || mode === 'bridge_then_pool') return true;
  return String(process.env.FEEDPILOT_BRIDGE_ENABLED || 'false').toLowerCase() === 'true';
}

function fallbackEnabled() {
  const mode = String(
    process.env.FEED_SOURCE_MODE ||
      process.env.FEEDPILOT_BRIDGE_MODE ||
      ''
  ).trim().toLowerCase();
  if (mode === 'android_bridge') return false;
  if (mode === 'bridge_then_pool') return true;
  return String(process.env.FEEDPILOT_BRIDGE_FALLBACK || 'true').toLowerCase() !== 'false';
}

function getBridgeConfig() {
  const baseUrl = String(process.env.FEEDPILOT_BRIDGE_URL || '').replace(/\/+$/, '');
  const key = process.env.FEEDPILOT_BRIDGE_KEY;
  return { baseUrl, key };
}

function isRetryableBridgeError(code, status) {
  return (
    status === 502 ||
    status === 503 ||
    status === 504 ||
    [
      'NO_ACTIVE_DEVICE',
      'NO_ACTIVE_SESSION',
      'NO_LOCAL_SESSION',
      'JOB_TIMEOUT',
      'DEVICE_OFFLINE',
      'TEMPORARY_NETWORK_ERROR',
      'NETWORK_TIMEOUT',
      'IG_EMPTY_FEED',
      'IG_PROFILE_MISMATCH',
      'IG_SESSION_EXPIRED',
      'IG_CHECKPOINT_REQUIRED',
      'IG_CAPTCHA_REQUIRED',
      'IG_RATE_LIMITED',
      'IG_UNKNOWN_ERROR',
    ].includes(code)
  );
}

async function fetchViaFeedPilotBridge(input = {}) {
  if (input.mode ? input.mode === 'pool' : !bridgeEnabled()) return { used: false };

  const { baseUrl, key } = getBridgeConfig();
  if (!baseUrl || !key) {
    return {
      used: true,
      ok: false,
      retryable: true,
      code: 'BRIDGE_NOT_CONFIGURED',
      message: 'FeedPilot bridge is enabled but URL/key is missing.',
    };
  }

  // Sanitize username: must not contain @ and must not be a post or reels URL
  const sanitizedUsername = sanitizeBridgeUsername(input.username);
  const rawUserId = input.userId ? String(input.userId).trim() : undefined;
  const isNumericUserId = rawUserId && /^\d+$/.test(rawUserId);

  // If a username was not provided in input.username, but a non-numeric handle was passed in input.userId
  const effectiveUsername =
    sanitizedUsername || (!isNumericUserId && rawUserId ? sanitizeBridgeUsername(rawUserId) : undefined);
  const effectiveUserId = isNumericUserId ? rawUserId : undefined;

  // If neither a valid username nor a valid numeric userId could be resolved, do not hit bridge
  if (!effectiveUsername && !effectiveUserId) {
    return {
      used: false,
      ok: false,
      retryable: true,
      code: 'INVALID_BRIDGE_TARGET',
      message: 'FeedPilot bridge requires a valid username handle (not a post/reel URL) or numeric userId.',
    };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

  try {
    const res = await fetch(`${baseUrl}/api/bridge/feed`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Bridge-Key': key,
        'X-Bridge-Client': 'GetIGFeed',
      },
      body: JSON.stringify({
        requestId: input.requestId,
        username: effectiveUsername,
        userId: effectiveUserId,
        limit: input.limit,
        maxId: input.maxId,
        includeStories: input.includeStories === true,
        client: 'GetIGFeed',
      }),
      signal: controller.signal,
    });

    const payload = await res.json().catch(() => null);
    if (res.ok && payload && payload.success) {
      return { used: true, ok: true, data: payload.data, bridge: payload };
    }

    const code = payload?.code || payload?.Code || `HTTP_${res.status}`;
    return {
      used: true,
      ok: false,
      retryable: isRetryableBridgeError(code, res.status),
      status: res.status,
      code,
      message: payload?.message || payload?.Message || 'FeedPilot bridge request failed.',
      bridge: payload,
    };
  } catch (err) {
    return {
      used: true,
      ok: false,
      retryable: true,
      code: err.name === 'AbortError' ? 'BRIDGE_TIMEOUT' : 'BRIDGE_REQUEST_FAILED',
      message: err.message,
    };
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = {
  bridgeMode,
  bridgeEnabled,
  fallbackEnabled,
  fetchViaFeedPilotBridge,
  sanitizeBridgeUsername,
};
