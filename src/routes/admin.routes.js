'use strict';

const express = require('express');

const admin = require('../controllers/admin.controller');
const { requireAuth } = require('../services/adminAuth');

const router = express.Router();

// Page + auth (public).
router.get('/', admin.serveDashboard); // GET /admin
router.get('/status', admin.status); // is a passcode configured?
router.post('/login', admin.login); // passcode -> token
router.post('/logout', requireAuth, admin.logout); // manual lock

// Feed fetch — intentionally NOT token-gated. The passcode/auto-lock only
// protects session/proxy management (which exposes/edits secrets); fetching a
// feed is the same non-sensitive capability as the public /api/user-feed.
// Available as POST (JSON body) and GET (query string / :userId path param).
router.post('/user-feed', admin.fetchUserFeed);
router.get('/user-feed/:userId', admin.fetchUserFeed);
router.get('/user-feed', admin.fetchUserFeed);

// Stories & highlights — same reasoning as the feed fetch: no secrets involved,
// so not token-gated.
router.post('/story-highlight', admin.fetchStoryHighlight);
router.get('/story-highlight/:username', admin.fetchStoryHighlight);
router.get('/story-highlight', admin.fetchStoryHighlight);
router.get('/highlight-details/:highlightId', admin.fetchHighlightDetails);

// Sessions CRUD (token-gated).
router.get('/sessions', requireAuth, admin.listSessions);
router.post('/sessions', requireAuth, admin.addSessions);
router.put('/sessions/:id', requireAuth, admin.updateSession);
router.delete('/sessions/:id', requireAuth, admin.deleteSession);
router.delete('/sessions', requireAuth, admin.deleteSession); // clear all

// Instagram view — proxy with session (token-gated).
router.get('/instagram', requireAuth, admin.proxyInstagram);
router.get('/instagram/check-session', requireAuth, admin.checkInstagramSession);

// Proxies CRUD (token-gated).
router.get('/proxies', requireAuth, admin.listProxies);
router.post('/proxies', requireAuth, admin.addProxies);
router.post('/proxies/:id/check', requireAuth, admin.checkProxyStatus); // liveness check
router.put('/proxies/:id', requireAuth, admin.updateProxy);
router.delete('/proxies/:id', requireAuth, admin.deleteProxy);
router.delete('/proxies', requireAuth, admin.deleteProxy); // clear all

module.exports = router;
