'use strict';

const test = require('node:test');
const assert = require('node:assert');
const config = require('./config');
const { IGram } = require('./client');
const service = require('./service');
const { buildConvertedFeed } = require('../fastdl/convertedFeed');

test('IGram configuration and client methods', () => {
  assert.strictEqual(config.workerHub, 'https://api-wn.igram.world');
  const client = new IGram();
  assert.strictEqual(typeof client.userInfo, 'function');
  assert.strictEqual(typeof client.highlightStoriesRaw, 'function');
  assert.strictEqual(typeof client.close, 'function');
  client.close();
});

test('IGram parses handles, profile URLs, and highlight IDs', () => {
  assert.deepStrictEqual(service.parseTargetInput('nasa'), { type: 'handle', value: 'nasa' });
  assert.deepStrictEqual(service.parseTargetInput('https://www.instagram.com/nasa/'), { type: 'handle', value: 'nasa' });
  assert.deepStrictEqual(service.parseTargetInput('highlight:18201653992314974'), { type: 'highlight', value: '18201653992314974' });
  assert.deepStrictEqual(service.parseTargetInput('18201653992314974'), { type: 'highlight', value: '18201653992314974' });
  assert.strictEqual(service.parseTargetInput('invalid handle with spaces'), null);
});

test('IGram feed conversion can omit stories for user-feed fallback requests', async () => {
  let storyCalls = 0;
  let highlightCalls = 0;
  const fakeHub = {
    source: 'igram',
    ErrorType: Error,
    concurrency: 1,
    userInfo: async () => ({ result: [{ user: { id: '1', username: 'nasa', media_count: 1 } }] }),
    postsPage: async () => ({ result: { edges: [], page_info: {} } }),
    storiesRaw: async () => { storyCalls += 1; return { result: [] }; },
    highlightsRaw: async () => { highlightCalls += 1; return { result: [] }; },
  };
  const result = await buildConvertedFeed(fakeHub, 'nasa', {
    includeStories: false,
    includeHighlightDetails: false,
  });
  assert.strictEqual(storyCalls, 0);
  assert.strictEqual(highlightCalls, 0);
  assert.strictEqual(result.stories.source, null);
  assert.strictEqual(result.highlights.source, null);
});
