'use strict';

const { rotateAuthToken } = require('../services/authToken.service');
const tokenStore = require('../store/tokenStore');

/**
 * POST /api/auth-token
 *
 * Fetches a fresh CSRF token from Instagram's shared_data endpoint, rotates
 * (persists) it into the JSON store, and returns the new token. Runs on every
 * request so the stored token is always freshly rotated.
 *
 * Body (optional):
 * { "dominatorAccount": { ... } }   // for cookies/proxy context
 */
async function postAuthToken(req, res, next) {
  try {
    const { dominatorAccount } = req.body || {};
    const entry = await rotateAuthToken(dominatorAccount);

    return res.status(200).json({
      success: true,
      csrfToken: entry.csrfToken,
      rotatedAt: entry.rotatedAt,
      source: entry.source,
    });
  } catch (err) {
    return next(err);
  }
}

/**
 * GET /api/auth-token
 * Returns the currently stored token without rotating.
 */
function getAuthToken(req, res) {
  const current = tokenStore.getCurrent();
  if (!current) {
    return res
      .status(404)
      .json({ success: false, error: 'No token stored yet.' });
  }
  return res.status(200).json({ success: true, ...current });
}

module.exports = { postAuthToken, getAuthToken };
