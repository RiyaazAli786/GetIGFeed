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

function mutate(action) {
  const result = pendingAdd.then(action);
  pendingAdd = result.catch(() => {});
  return result;
}

function valid(value) {
  const username = normalizeUsername(value);
  if (!username) throw Object.assign(new Error('Invalid Instagram username.'), { status: 400 });
  return username;
}

async function list({ search = '', page = 1, pageSize = 25 } = {}) {
  await pendingAdd;
  page = Math.max(1, Number.parseInt(page, 10) || 1);
  pageSize = Math.min(100, Math.max(1, Number.parseInt(pageSize, 10) || 25));
  const store = await getBackend().load();
  const users = (store.exceptionUsers || []).filter(user => user.includes(String(search).trim().replace(/^@/, '').toLowerCase())).sort();
  const total = users.length;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  page = Math.min(page, pages);
  return { users: users.slice((page - 1) * pageSize, page * pageSize), total, page, pageSize, pages };
}

function update(value, replacement) {
  return mutate(async () => {
    const username = valid(value);
    const newUsername = valid(replacement);
    const backend = getBackend();
    const store = await backend.load();
    const users = store.exceptionUsers || [];
    if (!users.includes(username)) throw Object.assign(new Error('Exception user not found.'), { status: 404 });
    if (username !== newUsername && users.includes(newUsername)) throw Object.assign(new Error('Exception user already exists.'), { status: 409 });
    store.exceptionUsers = users.map(user => user === username ? newUsername : user);
    await backend.save(store);
    return { username: newUsername };
  });
}

function remove(value) {
  return mutate(async () => {
    const username = valid(value);
    const backend = getBackend();
    const store = await backend.load();
    const users = store.exceptionUsers || [];
    if (!users.includes(username)) throw Object.assign(new Error('Exception user not found.'), { status: 404 });
    store.exceptionUsers = users.filter(user => user !== username);
    await backend.save(store);
    return { username, deleted: true };
  });
}

module.exports = { add, has, list, update, remove, normalizeUsername };
