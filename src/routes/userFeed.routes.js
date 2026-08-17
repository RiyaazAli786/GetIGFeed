'use strict';

const express = require('express');
const { postUserFeed } = require('../controllers/userFeed.controller');

const router = express.Router();

// Fetch a user feed. Same handler for POST (JSON body) and GET (query string /
// :userId path param).
router.post('/user-feed', postUserFeed);
router.get('/user-feed/:userId', postUserFeed); // GET /api/user-feed/123
router.get('/user-feed', postUserFeed); // GET /api/user-feed?userId=123
// Compatibility alias for callers using Instagram's private API path against
// this service host: /api/v1/feed/user/:userId/username/?count=12
router.get('/v1/feed/user/:userId/username', postUserFeed);

module.exports = router;
