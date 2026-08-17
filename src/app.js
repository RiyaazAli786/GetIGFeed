'use strict';

const express = require('express');
const morgan = require('morgan');

const userFeedRoutes = require('./routes/userFeed.routes');
const authTokenRoutes = require('./routes/authToken.routes');
const poolRoutes = require('./routes/pool.routes');
const adminRoutes = require('./routes/admin.routes');
const storyRoutes = require('./routes/story.routes');
const healthRoutes = require('./routes/health.routes');
const adminController = require('./controllers/admin.controller');
const anonyigRoutes = require('./anonyig/routes');
const fastdlRoutes = require('./fastdl/routes');
const graphqlRoutes = require('./graphql/routes');
const { notFound, errorHandler } = require('./middleware/errorHandler');

const app = express();

// Core middleware
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));

// Health check
app.use(healthRoutes);

// Public pages
app.get('/instagram-view.html', adminController.serveInstagramView);

// Admin dashboard (passcode-gated UI + CRUD over the pool)
app.use('/admin', adminRoutes);

// API routes
app.use('/api', poolRoutes);
app.use('/api', authTokenRoutes);
app.use('/api', userFeedRoutes);
// Stories / highlights / media downloads (no session or proxy needed).
app.use('/api/instagram', storyRoutes);
// User details, posts, reels, stories and highlights from the anonyig worker
// hub — a separate upstream with its own signed HTTP/2 transport (src/anonyig).
app.use('/api/anonyig', anonyigRoutes);
// Single hit download and diagnostics for fastdl.app integration (src/fastdl).
app.use('/api/fastdl', fastdlRoutes);
// GraphQL timeline media fetch via direct doc_id query (src/graphql).
app.use('/api/graphql', graphqlRoutes);


// Fallbacks
app.use(notFound);
app.use(errorHandler);

module.exports = app;
