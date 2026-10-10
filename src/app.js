// app.js
// ------------------------------------------------------------
// Builds the Express app: middleware + all routes.
// It does NOT start listening (server.js does that). Keeping them
// separate lets the smoke test start the app on any free port.
// ------------------------------------------------------------

const express = require('express');
const cors = require('cors');

const { requireAuth } = require('./middleware/auth');
const { corsOptions, securityHeaders } = require('./middleware/security');
const { rateLimit, byIp, byUser } = require('./middleware/rateLimit');
const { requirePlan } = require('./middleware/requirePlan');
const { notFound, errorHandler } = require('./middleware/errors');
const { requestMetrics } = require('./middleware/requestMetrics');

const authRoutes = require('./routes/auth');
const { router: profileRoutes } = require('./routes/profile');
const healthRoutes = require('./routes/health');
const { foodsRouter, logsRouter } = require('./routes/foods');
const wealthRoutes = require('./routes/wealth');
const { plansRouter, subRouter } = require('./routes/subscription');
const { googleSubRouter, googleRtdnRouter } = require('./routes/googlePlay');
const dashboardRoutes = require('./routes/dashboard');
const coachRoutes = require('./routes/coach');
const exportRoutes = require('./routes/export');
const legalRoutes = require('./routes/legal');
const insightsRoutes = require('./routes/insights');
const foodRoutes = require('./routes/food');
const activityRoutes = require('./routes/activity');
const { router: consentRoutes } = require('./routes/consents');
const { router: deleteAccountRoutes } = require('./routes/deleteAccount');
const adminRoutes = require('./routes/admin');
const adminPageRoutes = require('./routes/adminPage');

function createApp() {
  const app = express();

  // Render puts one proxy in front of us. Trust it, so req.ip is the real
  // user's IP (used by security logs and the /delete-account rate limit).
  app.set('trust proxy', Number(process.env.TRUST_PROXY_HOPS ?? 1));

  // Security headers on every response (helmet: CSP, HSTS, nosniff, frame-deny ...)
  app.disable('x-powered-by');
  app.use(securityHeaders());

  // Request counts / errors / latency per route pattern, in memory (admin "App health")
  app.use(requestMetrics());

  // CORS: see middleware/security.js. In production only the origins listed
  // in CORS_ORIGIN may call the API from a browser ("*" is ignored there).
  const { mode, ...cors_ } = corsOptions();
  app.use(cors(cors_));

  // A rough per-IP cap on the whole API (stops floods; normal use is far below it)
  app.use('/api', rateLimit({ name: 'api_ip', windowMs: 60 * 1000, max: Number(process.env.API_RATE_LIMIT_PER_MIN) || 600, key: byIp }));

  // Read JSON bodies (e.g. { "email": "..." }) into req.body
  app.use(express.json({ limit: '100kb' }));

  // A quick "is the server alive?" check (both paths, no login, no data)
  const alive = (req, res) => res.set('Cache-Control', 'no-store').json({ ok: true, app: 'HeartPurse', time: new Date().toISOString() });
  app.get('/api/health-check', alive);
  app.get('/health', alive);

  // ---- Public routes (no login needed) ----
  app.use('/', legalRoutes); // GET /privacy and GET /terms (web pages)
  app.use('/', deleteAccountRoutes); // GET + POST /delete-account (web page, no app needed)
  app.use('/api/auth', authRoutes);
  app.use('/api/auth', require('./routes/passwordReset'));
  app.use('/api/plans', plansRouter);
  // Google Play Real-time Developer Notifications (Pub/Sub push). Public, but
  // protected by ?secret= (and optionally Pub/Sub's signed token).
  app.use('/api/subscription/google/rtdn', googleRtdnRouter);

  // ---- Owner-only admin dashboard (own admin sign-in + second step; see admin/auth.js) ----
  app.use('/admin', adminPageRoutes);
  app.use('/api/admin', adminRoutes);

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
  app.use('/api/consents', requireAuth, consentRoutes);
  // HeartPurse Intelligence (each route checks the plan itself: utils/plans.js FEATURE_TIERS)
  app.use('/api/insights', requireAuth, insightsRoutes);
  app.use('/api/food', requireAuth, rateLimit({ name: 'food_parse_user', windowMs: 60 * 1000, max: 30, key: byUser }), foodRoutes); // POST /api/food/parse
  app.use('/api/activity', requireAuth, activityRoutes);

  // Coach: Free gets a daily allowance; paid plans unlimited + daily AI allowance (checked in the route)
  // Burst limit on top of the daily plan limits: 30 questions a minute per user (COACH_RATE_LIMIT_PER_MIN)
  app.use('/api/coach', requireAuth, rateLimit({ name: 'coach_user', windowMs: 60 * 1000, max: Number(process.env.COACH_RATE_LIMIT_PER_MIN) || 30, key: byUser,
    message: 'You are asking very quickly. Please wait a minute and try again.' }), coachRoutes);

  // Unknown URL -> 404, and any error -> clean JSON
  app.use(notFound);
  app.use(errorHandler);

  return app;
}

module.exports = { createApp, corsMode: () => corsOptions().mode };
