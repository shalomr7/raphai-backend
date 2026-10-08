// app.js
// ------------------------------------------------------------
// Builds the Express app: middleware + all routes.
// It does NOT start listening (server.js does that). Keeping them
// separate lets the smoke test start the app on any free port.
// ------------------------------------------------------------

const express = require('express');
const cors = require('cors');

const { requireAuth } = require('./middleware/auth');
const { requirePlan } = require('./middleware/requirePlan');
const { notFound, errorHandler } = require('./middleware/errors');

const authRoutes = require('./routes/auth');
const { router: profileRoutes } = require('./routes/profile');
const healthRoutes = require('./routes/health');
const { foodsRouter, logsRouter } = require('./routes/foods');
const wealthRoutes = require('./routes/wealth');
const { plansRouter, subRouter, webhookRouter } = require('./routes/subscription');
const { googleSubRouter, googleRtdnRouter } = require('./routes/googlePlay');
const dashboardRoutes = require('./routes/dashboard');
const coachRoutes = require('./routes/coach');
const exportRoutes = require('./routes/export');
const legalRoutes = require('./routes/legal');

function createApp() {
  const app = express();

  // CORS lets a web app on another address call this API.
  // CORS_ORIGIN="*" allows all (fine for development).
  const origin = process.env.CORS_ORIGIN && process.env.CORS_ORIGIN !== '*'
    ? process.env.CORS_ORIGIN.split(',').map((s) => s.trim())
    : '*';
  app.use(cors({ origin }));

  // The Razorpay webhook needs the RAW body to check the signature,
  // so it is added BEFORE express.json().
  app.use('/api/webhooks', express.raw({ type: '*/*', limit: '1mb' }), webhookRouter);

  // Read JSON bodies (e.g. { "email": "..." }) into req.body
  app.use(express.json({ limit: '100kb' }));

  // A quick "is the server alive?" check
  app.get('/api/health-check', (req, res) => res.json({ ok: true, app: 'RaphAi', time: new Date().toISOString() }));

  // ---- Public routes (no login needed) ----
  app.use('/', legalRoutes); // GET /privacy and GET /terms (web pages)
  app.use('/api/auth', authRoutes);
  app.use('/api/plans', plansRouter);
  // Google Play Real-time Developer Notifications (Pub/Sub push). Public, but
  // protected by ?secret= (and optionally Pub/Sub's signed token).
  app.use('/api/subscription/google/rtdn', googleRtdnRouter);

  // ---- Everything below needs a login token ----
  app.use('/api/profile', requireAuth, profileRoutes);
  app.use('/api/health', requireAuth, healthRoutes);
  app.use('/api/foods', requireAuth, foodsRouter);
  app.use('/api/food-logs', requireAuth, logsRouter);
  app.use('/api/wealth', requireAuth, wealthRoutes);
  app.use('/api/subscription/google', requireAuth, googleSubRouter);
  app.use('/api/subscription', requireAuth, subRouter);
  app.use('/api/dashboard', requireAuth, dashboardRoutes);
  app.use('/api/export', requireAuth, exportRoutes);

  // ---- Pro plan (or higher) needed ----
  app.use('/api/coach', requireAuth, requirePlan('pro'), coachRoutes);

  // Unknown URL -> 404, and any error -> clean JSON
  app.use(notFound);
  app.use(errorHandler);

  return app;
}

module.exports = { createApp };
