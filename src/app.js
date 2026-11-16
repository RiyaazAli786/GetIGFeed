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
const igramRoutes = require('./igram/routes');
const graphqlRoutes = require('./graphql/routes');
const { notFound, errorHandler } = require('./middleware/errorHandler');
const { telegramRequestLogger } = require('./middleware/telegramRequestLogger');

const app = express();

// Core middleware
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));
app.use(telegramRequestLogger);

// Health check
app.use(healthRoutes);

// Favicon
const faviconSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><defs><linearGradient id="g" x1="0%" y1="100%" x2="100%" y2="0%"><stop offset="0%" stop-color="#fdf497"/><stop offset="5%" stop-color="#fdf497"/><stop offset="45%" stop-color="#fd5949"/><stop offset="60%" stop-color="#d6249f"/><stop offset="90%" stop-color="#285AEB"/></linearGradient></defs><rect width="32" height="32" rx="9" fill="url(#g)"/><rect x="6.5" y="6.5" width="19" height="19" rx="5.5" fill="none" stroke="#ffffff" stroke-width="2.2"/><circle cx="16" cy="16" r="4.2" fill="none" stroke="#ffffff" stroke-width="2.2"/><circle cx="21.8" cy="10.2" r="1.3" fill="#ffffff"/></svg>`;
app.get(['/favicon.ico', '/favicon.svg'], (req, res) => {
  res.setHeader('Content-Type', 'image/svg+xml');
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.send(faviconSvg);
});

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
// IGram profile-viewer worker hub, including highlight stories.
app.use('/api/igram', igramRoutes);
// GraphQL timeline media fetch via direct doc_id query (src/graphql).
app.use('/api/graphql', graphqlRoutes);


// Fallbacks
app.use(notFound);
app.use(errorHandler);

module.exports = app;
