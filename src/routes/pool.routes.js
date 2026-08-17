'use strict';

const express = require('express');
const {
  addSessions,
  listSessions,
  deleteSession,
  addProxies,
  listProxies,
  deleteProxy,
} = require('../controllers/pool.controller');

const router = express.Router();

// Sessions — stored encrypted, decrypted only when an IG request uses them.
router.post('/sessions', addSessions); // bulk add
router.get('/sessions', listSessions); // list (masked)
router.delete('/sessions/:id', deleteSession); // delete one
router.delete('/sessions', deleteSession); // clear all

// Proxies — credentials stored encrypted.
router.post('/proxies', addProxies); // bulk add
router.get('/proxies', listProxies); // list (no credentials)
router.delete('/proxies/:id', deleteProxy); // delete one
router.delete('/proxies', deleteProxy); // clear all

module.exports = router;
