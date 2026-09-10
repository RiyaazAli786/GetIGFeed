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

function enabled() {
  return String(process.env.TELEGRAM_LOG_ENABLED || 'false').toLowerCase() === 'true';
}

function maxBody() {
  const n = Number(process.env.TELEGRAM_LOG_MAX_BODY || DEFAULT_MAX_BODY);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_MAX_BODY;
}

function shouldLogPath(path) {
  const mode = String(process.env.TELEGRAM_LOG_SCOPE || 'api').toLowerCase();
  if (mode === 'all') return true;
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

function compactJson(value, limit = maxBody()) {
  if (limit === 0) return '[disabled]';
  let text;
  try {
    text = typeof value === 'string' ? value : JSON.stringify(redact(value));
  } catch {
    text = '[unserializable]';
  }
  if (!text) return '';
  return text.length > limit ? `${text.slice(0, limit)}... [truncated ${text.length - limit}]` : text;
}

function textBlock(label, value) {
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

function telegramRequestLogger(req, res, next) {
  if (!enabled() || !shouldLogPath(req.path)) return next();

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

    const message = [
      `GetIGFeed API ${res.statusCode} ${req.method} ${req.originalUrl || req.url}`,
      `Duration: ${durationMs}ms`,
      textBlock('Request', requestInfo),
      textBlock('Response', responseBody),
    ].join('\n\n');

    sendTelegram(message);
  });

  next();
}

module.exports = { telegramRequestLogger };
