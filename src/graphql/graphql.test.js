'use strict';

const test = require('node:test');
const assert = require('node:assert');
const service = require('./service');

test('GraphQL Service exports', (t) => {
  assert.strictEqual(typeof service.resolveUserId, 'function');
  assert.strictEqual(typeof service.fetchFromGraphQL, 'function');
});
