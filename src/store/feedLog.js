'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/**
 * Writes one JSON file per user-feed call to data/feeds/. Each file contains
 * only the converted (web_profile_info-shaped) result — nothing else.
 */

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', '..', 'data');
const FEED_DIR = path.join(DATA_DIR, 'feeds');

function ensureDir() {
  if (!fs.existsSync(FEED_DIR)) fs.mkdirSync(FEED_DIR, { recursive: true });
}

/** Windows-safe timestamp for filenames (no ':' or '.'). */
const safeStamp = (iso) => iso.replace(/[:.]/g, '-');

/**
 * Persist the converted feed result to its own JSON file.
 * @param {object} args
 * @param {string} args.userId
 * @param {object} [args.request] sanitized request params (not written; kept
 *   for API compatibility)
 * @param {object} args.result   the converted (web_profile_info) result — this
 *   is exactly what gets written to the file
 * @returns {string|null} the file path written, or null on failure
 */
function logFeed({ userId, result }) {
  try {
    ensureDir();
    const loggedAt = new Date().toISOString();
    const suffix = crypto.randomUUID().slice(0, 8);
    const file = path.join(
      FEED_DIR,
      `${safeStamp(loggedAt)}_${userId || 'unknown'}_${suffix}.json`
    );

    // Write only the converted result.
    fs.writeFileSync(file, JSON.stringify(result, null, 2));
    return file;
  } catch (err) {
    // Logging must never break the request.
    // eslint-disable-next-line no-console
    console.error('[feedLog] failed to write log:', err.message);
    return null;
  }
}

module.exports = { logFeed, FEED_DIR };
