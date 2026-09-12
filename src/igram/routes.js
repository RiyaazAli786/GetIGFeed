'use strict';

const express = require('express');
const controller = require('./controller');

const router = express.Router();
router.get('/status', controller.status);
router.get('/highlights/:highlightId', controller.highlightDetails);
router.get('/', controller.fetchAll);
router.post('/', controller.fetchAll);
router.get('/:username', controller.fetchAll);

module.exports = router;
