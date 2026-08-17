'use strict';

const express = require('express');
const controller = require('../controllers/story.controller');

const router = express.Router();

// Stories + highlights for one handle (SearchUserIDExecute).
router.post('/search', controller.searchUserId);
router.get('/search', controller.searchUserId);
router.get('/search/:username', controller.searchUserId);
// Readable aliases for the same lookup.
router.post('/stories', controller.searchUserId);
router.get('/stories/:username', controller.searchUserId);
router.post('/story', controller.searchUserId);
router.get('/story/:username', controller.searchUserId);

// GetHighlightDetails (storynavigation -> anonstories fallback)
router.get('/highlights/:highlightId', controller.highlightDetails);

// Downloads: single file / inline preview, and bulk zip
router.get('/media', controller.media);
router.post('/download/zip', controller.downloadZip);

// Bulk zip with progress: start a job, follow it over SSE, then fetch the file
router.post('/download/zip/start', controller.startZip);
router.get('/download/zip/:jobId/events', controller.zipEvents);
router.get('/download/zip/:jobId/file', controller.zipFile);

module.exports = router;
