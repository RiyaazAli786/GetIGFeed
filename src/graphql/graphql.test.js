'use strict';

const test = require('node:test');
const assert = require('node:assert');
const service = require('./service');

test('GraphQL Service exports', (t) => {
  assert.strictEqual(typeof service.resolveUserId, 'function');
  assert.strictEqual(typeof service.fetchFromGraphQL, 'function');
});

test('GraphQL web headers do not include mobile Authorization', () => {
  const headers = service.graphQLWebHeaders(
    {
      authorization: 'Bearer IGT:2:redacted',
      xIgClaim: 'claim-token',
    },
    'csrf-token'
  );

  assert.strictEqual(headers.Authorization, undefined);
  assert.strictEqual(headers['x-csrftoken'], 'csrf-token');
  assert.strictEqual(headers['x-ig-www-claim'], 'claim-token');
});
