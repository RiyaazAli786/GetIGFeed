'use strict';

const express = require('express');
const controller = require('./controller');

const router = express.Router();

// User details — the profile header on its own.
router.get('/user', controller.userDetails);
router.get('/user/:username', controller.userDetails);
router.post('/user', controller.userDetails);

// Profile tabs.
router.get('/posts/:username', controller.posts);
router.get('/reels/:username', controller.reels);
router.get('/stories/:username', controller.stories);
router.get('/highlights/:username', controller.highlights);

// Everything — posts, stories, highlights and each highlight's stories — in the
// converted (web_profile_info + story nodes) JSON the rest of the API returns.
router.get('/feed', controller.convertedFeed);
router.get('/feed/:username', controller.convertedFeed);
router.post('/feed', controller.convertedFeed);

// The same data in the module's own normalized shape.
router.get('/profile', controller.profile);
router.get('/profile/:username', controller.profile);
router.post('/profile', controller.profile);

// Handle autocomplete.
router.get('/suggestions', controller.suggestions);

// Diagnostics: what this host can reach, and where the signing chunk stands.
// Declared last so it cannot shadow a handle-shaped route above.
router.get('/status', controller.status);

module.exports = router;
