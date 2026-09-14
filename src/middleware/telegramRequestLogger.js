'use strict';

const DEFAULT_MAX_BODY = 1800;
const TELEGRAM_LIMIT = 3900;

const SECRET_KEYS = [
  'authorization',
  'cookie',
  'set-cookie',
  'x-bridge-key',
  'apiKey',
  'api_key',
  'password',
  'pass',
  'token',
  'authToken',
  'sessionid',
  'sessionId',
  'csrfToken',
  'csrftoken',
  'proxyPassword',
];

const { formatFeedResolutionText } = require('../utils/feedResolution');

function isFeedRoute(path) {
  if (!path) return false;
  return (
    path === '/api/user-feed' ||
    path.startsWith('/api/user-feed/') ||
    path === '/admin/user-feed' ||
    path.startsWith('/admin/user-feed/') ||
    path.startsWith('/api/v1/feed/user/')
  );
}

function enabled(isFeed = false) {
  const allEnabled = String(process.env.TELEGRAM_LOG_ENABLED || 'false').toLowerCase() === 'true';
  const feedEnabled = String(process.env.TELEGRAM_FEED_LOG_ENABLED || 'false').toLowerCase() === 'true';
  if (isFeed) return allEnabled || feedEnabled;
  return allEnabled;
}

function maxBody() {
  const n = Number(process.env.TELEGRAM_LOG_MAX_BODY || DEFAULT_MAX_BODY);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_MAX_BODY;
}

function shouldLogPath(path) {
  const mode = String(process.env.TELEGRAM_LOG_SCOPE || 'api').toLowerCase();
  if (mode === 'all') return true;
  if (isFeedRoute(path)) return true;
  return path === '/api' || path.startsWith('/api/');
}

function redact(value, key = '') {
  if (value === null || value === undefined) return value;
  const keyLower = String(key).toLowerCase();
  if (SECRET_KEYS.some((secret) => keyLower.includes(secret.toLowerCase()))) {
    return '[redacted]';
  }
  if (Array.isArray(value)) return value.map((item) => redact(item));
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = redact(v, k);
    return out;
  }
  if (typeof value === 'string') {
    return value
      .replace(/sessionid=([^;\s]+)/gi, 'sessionid=[redacted]')
      .replace(/csrftoken=([^;\s]+)/gi, 'csrftoken=[redacted]')
      .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]');
  }
  return value;
}

function summarizeFeedResponse(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const user = obj.data?.user || obj.user;
  if (!user) return obj;

  const postEdges = user.edge_owner_to_timeline_media?.edges || [];
  const totalCount =
    user.edge_owner_to_timeline_media?.count ??
    user.media_count ??
    user.posts_count ??
    postEdges.length;
  const followerCount =
    user.edge_followed_by?.count ??
    user.follower_count ??
    user.followers ??
    0;
  const followingCount =
    user.edge_follow?.count ??
    user.following_count ??
    user.following ??
    0;

  const previewEdges = postEdges.slice(0, 2).map((edge) => {
    const node = edge?.node || edge || {};
    const captionRaw =
      node.edge_media_to_caption?.edges?.[0]?.node?.text ||
      node.caption?.text ||
      node.caption ||
      '';
    const captionSnippet =
      typeof captionRaw === 'string' && captionRaw.trim()
        ? (captionRaw.trim().length > 60
            ? `${captionRaw.trim().slice(0, 60)}...`
            : captionRaw.trim()
          ).replace(/\r?\n|\r/g, ' ')
        : undefined;

    return {
      node: {
        id: String(node.id || node.pk || ''),
        shortcode: node.shortcode || node.code || undefined,
        type: node.__typename || (node.is_video ? 'GraphVideo' : 'GraphImage'),
        is_video: Boolean(node.is_video),
        caption: captionSnippet,
        likes: node.edge_liked_by?.count ?? node.edge_media_preview_like?.count ?? node.like_count ?? 0,
        comments: node.edge_media_to_comment?.count ?? node.comment_count ?? 0,
      },
    };
  });

  const userSummary = {
    id: user.id || user.pk,
    username: user.username,
    full_name: user.full_name || undefined,
    is_private: Boolean(user.is_private),
    is_verified: Boolean(user.is_verified),
    profile_pic_url: user.profile_pic_url || undefined,
    follower_count: followerCount,
    following_count: followingCount,
    media_count: totalCount,
    edge_followed_by: { count: followerCount },
    edge_follow: { count: followingCount },
    edge_owner_to_timeline_media: {
      count: totalCount,
      returned: postEdges.length,
      ...(user.edge_owner_to_timeline_media?.page_info
        ? { page_info: user.edge_owner_to_timeline_media.page_info }
        : {}),
      ...(previewEdges.length ? { edges: previewEdges } : {}),
    },
  };

  const summary = {
    ...(obj.data ? { data: { user: userSummary } } : { user: userSummary }),
    status: obj.status || 'ok',
    source: obj.source || undefined,
    stories: obj.stories?.count ?? (obj.stories?.available ? 'available' : 0),
    highlights: obj.highlights?.count ?? (obj.highlights?.available ? 'available' : 0),
  };

  if (obj.fallback) {
    summary.fallback = {
      used: true,
      provider: obj.fallback.provider,
      failedSource: obj.fallback.failedSource || undefined,
      triggerReason: obj.fallback.triggerReason || obj.fallback.reason || undefined,
    };
  }
  if (obj.errors && Object.keys(obj.errors).length) summary.errors = obj.errors;
  return summary;
}

function simplifyRequestInfo(info) {
  if (!info || typeof info !== 'object') return info;
  const out = {
    method: info.method,
    path: info.path,
  };
  if (info.ip) out.ip = String(info.ip).replace('::ffff:', '');
  if (info.query && Object.keys(info.query).length) out.query = info.query;
  if (info.body && Object.keys(info.body).length) out.body = info.body;
  const ua = info.headers?.['user-agent'];
  if (ua) out.userAgent = ua;
  return out;
}

function compactJson(value, limit = maxBody()) {
  if (limit === 0) return '[disabled]';
  let text;
  try {
    const cleaned = redact(summarizeFeedResponse(value));
    text = typeof cleaned === 'string' ? cleaned : JSON.stringify(cleaned);
  } catch {
    text = '[unserializable]';
  }
  if (!text) return '';
  return text.length > limit ? `${text.slice(0, limit)}... [truncated ${text.length - limit}]` : text;
}

function textBlock(label, value) {
  if (label.includes('Request') && typeof value === 'object') {
    value = simplifyRequestInfo(value);
  }
  const text = compactJson(value);
  return `${label}: ${text || '(empty)'}`;
}

async function sendTelegram(message) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;

  const chunks = [];
  for (let i = 0; i < message.length; i += TELEGRAM_LIMIT) {
    chunks.push(message.slice(i, i + TELEGRAM_LIMIT));
  }

  for (const chunk of chunks) {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: chunk,
        disable_web_page_preview: true,
      }),
    }).catch(() => {});
  }
}

function formatTelegramMessage({
  statusCode,
  method,
  url,
  durationMs,
  feedResolution = null,
  requestInfo,
  responseBody,
}) {
  const statusEmoji =
    statusCode >= 200 && statusCode < 300
      ? '🟢'
      : statusCode >= 400 && statusCode < 500
        ? '🟡'
        : '🔴';

  const sections = [
    `${statusEmoji} GetIGFeed API ${statusCode} ${method} ${url}`,
    `⏱️ Duration: ${durationMs}ms`,
  ];

  if (feedResolution) {
    const feedResolutionBlock = formatFeedResolutionText(feedResolution);
    if (feedResolutionBlock) {
      sections.push(`🔄 ${feedResolutionBlock}`);
    }
  }

  sections.push(textBlock('📥 Request', requestInfo));
  sections.push(textBlock('📤 Response', responseBody));

  return sections.join('\n\n');
}

function telegramRequestLogger(req, res, next) {
  const isFeed = isFeedRoute(req.path);
  if (!enabled(isFeed) || !shouldLogPath(req.path)) return next();

  const startedAt = Date.now();
  const chunks = [];
  const originalWrite = res.write.bind(res);
  const originalEnd = res.end.bind(res);

  res.write = function write(chunk, encoding, callback) {
    if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding));
    return originalWrite(chunk, encoding, callback);
  };

  res.end = function end(chunk, encoding, callback) {
    if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding));
    return originalEnd(chunk, encoding, callback);
  };

  res.on('finish', () => {
    const durationMs = Date.now() - startedAt;
    const responseText = Buffer.concat(chunks).toString('utf8');
    let responseBody = responseText;
    try {
      responseBody = JSON.parse(responseText);
    } catch {
      // keep text response
    }

    const requestInfo = {
      method: req.method,
      path: req.originalUrl || req.url,
      ip: req.ip,
      query: redact(req.query),
      body: redact(req.body),
      headers: redact({
        authorization: req.headers.authorization,
        'content-type': req.headers['content-type'],
        'user-agent': req.headers['user-agent'],
        'x-forwarded-for': req.headers['x-forwarded-for'],
      }),
    };

    const message = formatTelegramMessage({
      statusCode: res.statusCode,
      method: req.method,
      url: req.originalUrl || req.url,
      durationMs,
      feedResolution: res.locals?.feedResolution,
      requestInfo,
      responseBody,
    });

    sendTelegram(message);
  });

  next();
}

module.exports = {
  telegramRequestLogger,
  formatTelegramMessage,
  summarizeFeedResponse,
  sendTelegram,
  isFeedRoute,
  shouldLogPath,
};
