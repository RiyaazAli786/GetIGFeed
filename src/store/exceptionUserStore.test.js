'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

test('exception usernames persist, deduplicate, validate and survive pool updates', async () => {
  const previousDir = process.env.DATA_DIR;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'getig-exceptions-'));
  process.env.DATA_DIR = directory;
  const { getBackend } = require('./poolBackend');
  const users = require('./exceptionUserStore');
  try {
    assert.deepEqual(await users.add(' @Example.User '), { username: 'example.user', added: true });
    assert.deepEqual(await users.add('EXAMPLE.USER'), { username: 'example.user', added: false });
    assert.equal(await users.has('@Example.User'), true);
    assert.equal(await users.has('someone_else'), false);
    const concurrent = await Promise.all([users.add('Concurrent'), users.add('@CONCURRENT')]);
    assert.deepEqual(concurrent.map((result) => result.added), [true, false]);
    for (const input of [undefined, {}, '', '12345', 'bad/name']) {
      await assert.rejects(users.add(input), { status: 400 });
    }
    const backend = getBackend();
    const pool = await backend.load();
    pool.proxies.push({ id: 'test-proxy' });
    await backend.save(pool);
    assert.equal(await users.has('example.user'), true);
    assert.deepEqual(await users.list({ search: 'EXAMPLE', page: 8, pageSize: 1 }), {
      users: ['example.user'], total: 1, page: 1, pageSize: 1, pages: 1,
    });
    await assert.rejects(users.update('missing', 'new_user'), { status: 404 });
    await assert.rejects(users.update('example.user', 'concurrent'), { status: 409 });
    assert.deepEqual(await users.update('example.user', '@Renamed'), { username: 'renamed' });
    assert.equal(await users.has('example.user'), false);
    assert.equal(await users.has('renamed'), true);
    assert.deepEqual(await users.remove('@RENAMED'), { username: 'renamed', deleted: true });
    assert.equal(await users.has('renamed'), false);
    await assert.rejects(users.remove('renamed'), { status: 404 });
    await users.add('example.user');
    const saved = JSON.parse(fs.readFileSync(path.join(directory, 'pool.json'), 'utf8'));
    assert.deepEqual(saved.exceptionUsers, ['concurrent', 'example.user']);
  } finally {
    if (previousDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = previousDir;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
