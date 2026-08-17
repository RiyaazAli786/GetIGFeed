'use strict';

const express = require('express');
const {
  postAuthToken,
  getAuthToken,
} = require('../controllers/authToken.controller');

const router = express.Router();

// POST /api/auth-token  → fetch from shared_data, rotate + persist, return
router.post('/auth-token', postAuthToken);

// GET  /api/auth-token  → read currently stored token (no rotation)
router.get('/auth-token', getAuthToken);

module.exports = router;
