'use strict';

const express = require('express');
const controller = require('./controller');

const router = express.Router();

// GET /api/graphql?username=nasa&first=12&after=<cursor>
// POST /api/graphql { username, first?, after? }
router.get('/', controller.fetchFeed);
router.post('/', controller.fetchFeed);

// GET /api/graphql/nasa[?first=12&after=<cursor>]
router.get('/:username', controller.fetchFeed);

module.exports = router;
