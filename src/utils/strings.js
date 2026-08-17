'use strict';

/**
 * Port of DominatorHouseCore.Utility.Utilities.GetBetween.
 * Returns '' when either delimiter is missing (never throws).
 */
function getBetween(source, start, end) {
  try {
    if (!source || !source.includes(start) || !source.includes(end)) return '';
    const startIndex = source.indexOf(start) + start.length;
    const endIndex = source.indexOf(end, startIndex);
    if (endIndex < 0 || startIndex < 0) return '';
    return source.substring(startIndex, endIndex);
  } catch {
    return '';
  }
}

/**
 * Port of the private FromBase64 helpers in the response handlers.
 * C#'s Convert.FromBase64String throws on non base64 input and the callers
 * swallow that into null, so a plain URL passes through as null. Buffer.from
 * is lenient, hence the round-trip check.
 */
function fromBase64(value) {
  try {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    if (!trimmed || trimmed.length % 4 !== 0) return null;
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(trimmed)) return null;
    const buffer = Buffer.from(trimmed, 'base64');
    if (buffer.toString('base64') !== trimmed) return null;
    return buffer.toString('utf8');
  } catch {
    return null;
  }
}

/**
 * anonstories hands back media as https://embed.anonstories.com/<base64 url>.
 * Unwrap it to the direct CDN link; anything else passes through untouched.
 */
function decodeEmbedUrl(url) {
  if (!url || typeof url !== 'string') return url;
  if (!url.includes('embed.anonstories.com/')) return url;
  try {
    const encoded = url.split('/').filter(Boolean).pop();
    const decoded = Buffer.from(decodeURIComponent(encoded), 'base64').toString('utf8');
    return /^https?:\/\//i.test(decoded) ? decoded : url;
  } catch {
    return url;
  }
}

/** First non-null / non-empty string of the arguments, otherwise null. */
function firstNonEmpty(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.length > 0) return value;
    if (typeof value === 'number') return String(value);
  }
  return null;
}

// Path.GetInvalidFileNameChars() on Windows: these plus the control range.
// A Set avoids any regex-escaping hazard around the backslash, and mirrors
// the C# loop (Array.IndexOf(invalidChars, ch)) one for one.
const INVALID_FILENAME_CHARS = new Set(['<', '>', ':', '"', '/', '|', '?', '*', String.fromCharCode(92)]); // 92 = backslash
const RESERVED_DEVICE_NAMES = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i;

/**
 * Port of GramStatic.SanitizeFileName, plus the guards a zip needs so the
 * entries extract cleanly on Windows (no trailing dot/space, no device names).
 */
function sanitizeFileName(name, replacement = '_') {
  if (!name) return 'unknown';
  const cleaned = [...String(name)]
    .map((ch) => (INVALID_FILENAME_CHARS.has(ch) || ch.charCodeAt(0) < 32 ? replacement : ch))
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '');
  if (!cleaned) return 'unknown';
  return RESERVED_DEVICE_NAMES.test(cleaned) ? `_${cleaned}` : cleaned;
}

/** Mirrors the "dd-MM-yyyy hh:mm:ss tt" format used by the response handler. */
function formatDate(date) {
  const pad = (n) => String(n).padStart(2, '0');
  let hours = date.getHours();
  const suffix = hours >= 12 ? 'PM' : 'AM';
  hours = hours % 12 || 12;
  return (
    `${pad(date.getDate())}-${pad(date.getMonth() + 1)}-${date.getFullYear()} ` +
    `${pad(hours)}:${pad(date.getMinutes())}:${pad(date.getSeconds())} ${suffix}`
  );
}

/**
 * The upstream APIs express "createdTime" as an age ("h:m:s" ago), exactly how
 * InstagramStoriesResponseHandler treats it: now - h - m - s.
 */
function relativeAgeToDate(created, now = new Date()) {
  if (!created) return null;
  const value = String(created).trim();
  // Absolute timestamps ("2026-06-07 19:56:27") also show up on the highlight
  // endpoint; only the bare "h:m:s" form is an age.
  if (/^\d{4}-\d{2}-\d{2}/.test(value)) return null;
  const parts = value.split(':');
  if (parts.length < 3) return null;
  const hours = parseInt(parts[0], 10) || 0;
  const minutes = parseInt(parts[1], 10) || 0;
  const seconds = parseInt(String(parts[2]).replace(/AM|PM/gi, ''), 10) || 0;
  return new Date(now.getTime() - ((hours * 3600 + minutes * 60 + seconds) * 1000));
}

/**
 * Normalises whatever "createdTime" the upstream hands back into the
 * "dd-MM-yyyy hh:mm:ss tt" string the C# produced: an age is subtracted from
 * now, an absolute timestamp is reformatted, anything else passes through.
 */
function parseCreatedTime(created, now = new Date()) {
  if (!created) return null;
  const age = relativeAgeToDate(created, now);
  if (age) return formatDate(age);

  const value = String(created).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(value)) {
    const parsed = new Date(value.replace(' ', 'T'));
    if (!Number.isNaN(parsed.getTime())) return formatDate(parsed);
  }
  return value;
}

/** Best-effort file extension for a media url, falling back to the item type. */
function mediaExtension(url, type) {
  const match = /\.(jpe?g|png|webp|mp4|mov|gif)(?:$|\?)/i.exec(String(url || ''));
  if (match) return match[1].toLowerCase();
  return String(type || '').toLowerCase() === 'video' ? 'mp4' : 'jpg';
}

module.exports = {
  getBetween,
  fromBase64,
  decodeEmbedUrl,
  mediaExtension,
  firstNonEmpty,
  sanitizeFileName,
  formatDate,
  relativeAgeToDate,
  parseCreatedTime,
};
