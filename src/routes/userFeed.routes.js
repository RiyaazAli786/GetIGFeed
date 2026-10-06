'use strict';

const express = require('express');
const { postUserFeed } = require('../controllers/userFeed.controller');
const exceptionUsers = require('../store/exceptionUserStore');

const router = express.Router();

async function addExceptionUser(req, res, next) {
  try {
    const result = await exceptionUsers.add(req.method === 'GET' ? req.query.username : req.body?.username);
    res.setHeader('Cache-Control', 'no-store');
    res.status(result.added ? 201 : 200).json({
      success: true,
      ...result,
      userExist: !result.added,
      status: result.added ? 'added' : 'exists',
      feedSourceMode: 'bridge_then_pool',
    });
  } catch (err) {
    next(err);
  }
}

// Preserve legacy GET registration when username is supplied.
router.get('/exception-users', async (req, res, next) => {
  if (req.query.username !== undefined) return addExceptionUser(req, res, next);
  try {
    res.setHeader('Cache-Control', 'no-store');
    res.json({ success: true, ...await exceptionUsers.list(req.query) });
  } catch (err) { next(err); }
});
router.put('/exception-users/:username', async (req, res, next) => {
  try {
    res.setHeader('Cache-Control', 'no-store');
    res.json({ success: true, ...await exceptionUsers.update(req.params.username, req.body?.username) });
  } catch (err) { next(err); }
});
router.delete('/exception-users/:username', async (req, res, next) => {
  try {
    res.setHeader('Cache-Control', 'no-store');
    res.json({ success: true, ...await exceptionUsers.remove(req.params.username) });
  } catch (err) { next(err); }
});
router.post('/exception-users', addExceptionUser);

// Fetch a user feed. Same handler for POST (JSON body) and GET (query string /
// :userId path param).
router.post('/user-feed', postUserFeed);
router.get('/user-feed/:userId', postUserFeed); // GET /api/user-feed/123
router.get('/user-feed', postUserFeed); // GET /api/user-feed?userId=123
// Compatibility alias for callers using Instagram's private API path against
// this service host: /api/v1/feed/user/:userId/username/?count=12
router.get('/v1/feed/user/:userId/username', postUserFeed);

module.exports = router;
