'use strict';

const { getBackend } = require('./poolBackend');

function normalizeUsername(value) {
  if (typeof value !== 'string') return null;
  const username = value.trim().replace(/^@/, '').toLowerCase();
  return /^[a-z0-9._]{1,30}$/.test(username) && !/^\d+$/.test(username)
    ? username : null;
}

let pendingAdd = Promise.resolve();

function add(value) {
  // Serialize registrations so simultaneous requests cannot insert duplicates.
  const result = pendingAdd.then(() => addUser(value));
  pendingAdd = result.catch(() => {});
  return result;
}

async function addUser(value) {
  const username = normalizeUsername(value);
  if (!username) {
    const error = new Error('username must be a valid Instagram handle (1–30 letters, digits, dots or underscores; not a numeric ID).');
    error.status = 400;
    throw error;
  }
  const backend = getBackend();
  const store = await backend.load();
  const users = store.exceptionUsers || [];
  const added = !users.includes(username);
  if (added) {
    store.exceptionUsers = [...users, username];
    await backend.save(store);
  }
  return { username, added };
}

async function has(value) {
  const username = normalizeUsername(value);
  if (!username) return false;
  const store = await getBackend().load();
  return (store.exceptionUsers || []).includes(username);
}

module.exports = { add, has, normalizeUsername };
