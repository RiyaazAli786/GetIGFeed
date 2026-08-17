'use strict';

const poolStore = require('../store/poolStore');

/**
 * Endpoints for managing the encrypted pool of Instagram sessions and proxies.
 * Session ids / cookies and proxy credentials are stored encrypted (AES-256-GCM)
 * and only decrypted when an Instagram request actually uses them.
 */

/** Pull the array of items from a request body, supporting a few shapes. */
function itemsFrom(body, key) {
  if (Array.isArray(body)) return body;
  if (Array.isArray(body?.[key])) return body[key];
  if (body?.[key] != null) return [body[key]];
  // Also accept a newline/comma-separated raw string.
  const raw = body?.raw ?? body?.text;
  if (typeof raw === 'string') {
    return raw
      .split(/[\r\n,]+/)
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return [];
}

// --- Sessions --------------------------------------------------------------

/** POST /api/sessions — bulk add sessions. */
async function addSessions(req, res, next) {
  try {
    const items = itemsFrom(req.body, 'sessions');
    if (!items.length) {
      return res
        .status(400)
        .json({ success: false, error: 'No sessions provided.' });
    }
    const result = await poolStore.addSessions(items);
    return res.status(201).json({ success: true, ...result });
  } catch (err) {
    return next(err);
  }
}

/** GET /api/sessions — list sessions (masked). */
function listSessions(req, res, next) {
  try {
    const sessions = poolStore.listSessions();
    return res.status(200).json({ success: true, count: sessions.length, sessions });
  } catch (err) {
    return next(err);
  }
}

/** DELETE /api/sessions/:id — delete one; DELETE /api/sessions — clear all. */
async function deleteSession(req, res, next) {
  try {
    const { id } = req.params;
    if (!id) {
      const removed = await poolStore.clearSessions();
      return res.status(200).json({ success: true, removed });
    }
    const removed = await poolStore.deleteSession(id);
    if (!removed) {
      return res.status(404).json({ success: false, error: 'Session not found.' });
    }
    return res.status(200).json({ success: true, removed: 1 });
  } catch (err) {
    return next(err);
  }
}

// --- Proxies ---------------------------------------------------------------

/** POST /api/proxies — bulk add proxies. */
async function addProxies(req, res, next) {
  try {
    const items = itemsFrom(req.body, 'proxies');
    if (!items.length) {
      return res
        .status(400)
        .json({ success: false, error: 'No proxies provided.' });
    }
    const result = await poolStore.addProxies(items);
    return res.status(201).json({ success: true, ...result });
  } catch (err) {
    return next(err);
  }
}

/** GET /api/proxies — list proxies (credentials never returned). */
function listProxies(req, res, next) {
  try {
    const proxies = poolStore.listProxies();
    return res.status(200).json({ success: true, count: proxies.length, proxies });
  } catch (err) {
    return next(err);
  }
}

/** DELETE /api/proxies/:id — delete one; DELETE /api/proxies — clear all. */
async function deleteProxy(req, res, next) {
  try {
    const { id } = req.params;
    if (!id) {
      const removed = await poolStore.clearProxies();
      return res.status(200).json({ success: true, removed });
    }
    const removed = await poolStore.deleteProxy(id);
    if (!removed) {
      return res.status(404).json({ success: false, error: 'Proxy not found.' });
    }
    return res.status(200).json({ success: true, removed: 1 });
  } catch (err) {
    return next(err);
  }
}

module.exports = {
  addSessions,
  listSessions,
  deleteSession,
  addProxies,
  listProxies,
  deleteProxy,
};
