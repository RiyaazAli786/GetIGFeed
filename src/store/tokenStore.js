'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Simple JSON-file backed store for the current auth (csrf) token.
 * Keeps a small rotation history so the last-used tokens are auditable.
 */

// Overridable so tokens can live on a mounted persistent disk (see poolStore).
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', '..', 'data');
const STORE_PATH = path.join(DATA_DIR, 'authToken.json');
const MAX_HISTORY = 20;

function ensureStore() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(STORE_PATH)) {
    fs.writeFileSync(
      STORE_PATH,
      JSON.stringify({ current: null, history: [] }, null, 2)
    );
  }
}

/** Read the whole store ({ current, history }). */
function read() {
  ensureStore();
  try {
    return JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
  } catch {
    return { current: null, history: [] };
  }
}

/** Return the currently stored token entry (or null). */
function getCurrent() {
  return read().current;
}

/**
 * Persist a new token, pushing the previous "current" into history.
 * @param {{ csrfToken: string, source?: string, rotatedAt: string }} entry
 * @returns {object} the saved entry
 */
function save(entry) {
  ensureStore();
  const store = read();

  if (store.current) {
    store.history.unshift(store.current);
    store.history = store.history.slice(0, MAX_HISTORY);
  }
  store.current = entry;

  // Write to a temp file then rename for an atomic-ish update.
  const tmp = `${STORE_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2));
  fs.renameSync(tmp, STORE_PATH);

  return entry;
}

/**
 * Update the current token entry in place, WITHOUT rotating it into history.
 * Used to bump the per-token use counter between rotations.
 * @param {object} entry
 * @returns {object} the saved entry
 */
function updateCurrent(entry) {
  ensureStore();
  const store = read();
  store.current = entry;

  const tmp = `${STORE_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2));
  fs.renameSync(tmp, STORE_PATH);

  return entry;
}

module.exports = { read, getCurrent, save, updateCurrent, STORE_PATH };
