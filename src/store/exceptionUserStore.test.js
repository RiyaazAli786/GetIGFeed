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
    const saved = JSON.parse(fs.readFileSync(path.join(directory, 'pool.json'), 'utf8'));
    assert.deepEqual(saved.exceptionUsers, ['example.user', 'concurrent']);
  } finally {
    if (previousDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = previousDir;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
