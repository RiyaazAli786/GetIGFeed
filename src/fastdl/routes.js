'use strict';

const express = require('express');
const controller = require('./controller');

const router = express.Router();

// Consolidated endpoint: accepts post URL, profile URL, or handle.
router.get('/', controller.fetchAll);
router.post('/', controller.fetchAll);

// Highlight details: stories inside a single bubble
router.get('/highlights/:highlightId', controller.highlightDetails);

// Support path-param username directly
router.get('/:username', controller.fetchAll);


// Diagnostics endpoint: verify connection to main site and worker hub
router.get('/status', controller.status);



module.exports = router;
