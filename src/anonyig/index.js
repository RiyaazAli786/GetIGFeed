'use strict';

/**
 * anonyig — self-contained module for the anonyig worker-hub Instagram API
 * (merged in from the standalone `anonyig` client project).
 *
 *   src/anonyig/
 *     routes.js         /api/anonyig/* wiring
 *     controller.js     request shaping
 *     service.js        shared client, validation, upstream -> HTTP errors
 *     convertedFeed.js  /feed — raw payloads -> this project's converted JSON
 *     client.js         the client library (transport, signing, normalizers)
 *     signer.js         runs the site's signing chunk in a vm sandbox
 *     chunk.js          fetches that chunk (npm run anonyig:chunk)
 *     config.js         env-driven settings
 *
 * See ./README.md for the endpoint list and how the request signing works.
 */

const routes = require('./routes');
const service = require('./service');
const { AnonyIG, AnonyIGError } = require('./client');

module.exports = { routes, service, AnonyIG, AnonyIGError };
