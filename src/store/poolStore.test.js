'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { parseSessionInput } = require('./poolStore');

const chromeCookies = [
  { domain: '.instagram.com', name: 'csrftoken', value: 'csrf123', path: '/' },
  { domain: '.instagram.com', name: 'ds_user_id', value: '12345', path: '/' },
  { domain: '.instagram.com', name: 'mid', value: 'mid123', path: '/' },
  { domain: '.instagram.com', name: 'sessionid', value: '12345%3Aabc%3A17', path: '/' },
];

test('parseSessionInput accepts a Chrome cookie export array', () => {
  const parsed = parseSessionInput(chromeCookies);

  assert.strictEqual(parsed.secret.sessionid, '12345%3Aabc%3A17');
  assert.strictEqual(parsed.secret.csrftoken, 'csrf123');
  assert.strictEqual(parsed.secret.dsUserId, '12345');
  assert.strictEqual(parsed.secret.mid, 'mid123');
  assert.strictEqual(parsed.dsUserId, '12345');
  assert.strictEqual(parsed.secret.cookies.length, 4);
});

test('parseSessionInput extracts required cookies from object.cookies', () => {
  const parsed = parseSessionInput({ label: 'chrome-export', cookies: chromeCookies });

  assert.strictEqual(parsed.label, 'chrome-export');
  assert.strictEqual(parsed.secret.sessionid, '12345%3Aabc%3A17');
  assert.strictEqual(parsed.secret.csrftoken, 'csrf123');
  assert.strictEqual(parsed.secret.dsUserId, '12345');
});
