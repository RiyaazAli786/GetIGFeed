'use strict';

const crypto = require('crypto');

/**
 * Passcode gate + short-lived token store for the admin dashboard.
 *
 * A valid passcode (ADMIN_PASSCODE) exchanges for an opaque bearer token. The
 * token has a SLIDING idle expiry: every authenticated request pushes the
 * expiry forward, but 30s with no request auto-locks it server-side. The
 * dashboard mirrors this with its own inactivity timer, so both the UI and the
 * API lock in step.
 *
 * Tokens live only in process memory — a restart (or 30s of silence) forces a
 * re-entry of the passcode.
 */

// Auto-lock window. Kept in sync with the dashboard's client-side timer.
const IDLE_MS = parseInt(process.env.ADMIN_IDLE_MS || '30000', 10);

/** token -> expiresAt (epoch ms) */
const tokens = new Map();

/** The configured passcode, or '' when the dashboard is disabled. */
function getPasscode() {
  let p = process.env.ADMIN_PASSCODE || '';
  // Tolerate common env-dashboard copy-paste mistakes: surrounding whitespace,
  // and one layer of matching surrounding quotes (e.g. someone pastes the
  // dotenv-quoted form `"secret"` into a hosting UI that stores it literally).
  p = p.trim();
  if (
    p.length >= 2 &&
    ((p[0] === '"' && p[p.length - 1] === '"') ||
      (p[0] === "'" && p[p.length - 1] === "'"))
  ) {
    p = p.slice(1, -1);
  }
  return p;
}

/** True once a passcode is configured (dashboard usable). */
function isConfigured() {
  return getPasscode().length > 0;
}

/** Constant-time passcode comparison. */
function checkPasscode(input) {
  const expected = getPasscode();
  if (!expected) return false;
  const a = Buffer.from(String(input == null ? '' : input));
  const b = Buffer.from(expected);
  // timingSafeEqual requires equal lengths; compare against a padded copy so a
  // length mismatch still costs the same as a value mismatch.
  if (a.length !== b.length) {
    crypto.timingSafeEqual(b, b);
    return false;
  }
  return crypto.timingSafeEqual(a, b);
}

/** Issue a fresh token with a full idle window. */
function issueToken() {
  const token = crypto.randomBytes(32).toString('hex');
  tokens.set(token, Date.now() + IDLE_MS);
  return { token, idleMs: IDLE_MS };
}

/** Validate a token and, if still live, slide its expiry forward. */
function verifyToken(token) {
  if (!token) return false;
  const expiresAt = tokens.get(token);
  if (!expiresAt) return false;
  if (Date.now() > expiresAt) {
    tokens.delete(token);
    return false;
  }
  tokens.set(token, Date.now() + IDLE_MS);
  return true;
}

/** Drop a token (explicit lock / logout). */
function revokeToken(token) {
  return tokens.delete(token);
}

// Sweep expired tokens so a long-idle process doesn't leak them.
const sweep = setInterval(() => {
  const now = Date.now();
  for (const [token, expiresAt] of tokens) {
    if (now > expiresAt) tokens.delete(token);
  }
}, IDLE_MS);
if (typeof sweep.unref === 'function') sweep.unref();

/** Express middleware: gate a route behind a live admin token. */
function requireAuth(req, res, next) {
  const header = req.get('authorization') || '';
  const token = req.get('x-admin-token') || header.replace(/^Bearer\s+/i, '');
  if (!verifyToken(token)) {
    return res
      .status(401)
      .json({ success: false, error: 'Locked. Enter the passcode.' });
  }
  req.adminToken = token;
  return next();
}

module.exports = {
  IDLE_MS,
  getPasscode,
  isConfigured,
  checkPasscode,
  issueToken,
  verifyToken,
  revokeToken,
  requireAuth,
};
