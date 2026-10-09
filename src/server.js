// server.js
// ------------------------------------------------------------
// The starting point. "npm start" runs this file.
// 1. Loads settings from .env
// 2. Connects to Postgres and creates tables + seed foods (safe every start)
// 3. Builds the app
// 4. Starts listening on PORT (default 4000; Render sets PORT for you)
// ------------------------------------------------------------

// Read the .env file into process.env (must be first!)
require('dotenv').config();

const db = require('./db');
const { createApp } = require('./app');
const { startDailyPurge } = require('./services/securityLog');
const { assertAuthConfig } = require('./middleware/auth');
const ai = require('./ai');

const PORT = Number(process.env.PORT) || 4000;

async function start() {
  // Refuse to start with an unsafe login secret (production)
  assertAuthConfig();

  await db.init();
  const applied = db.appliedMigrations();
  console.log(`Database ready (${applied.length ? `applied migrations: ${applied.join(', ')}` : 'no new migrations'}; foods seeded)`);

  if (process.env.NODE_ENV === 'production' && String(process.env.CORS_ORIGIN || '').trim() === '*') {
    console.warn('CORS_ORIGIN="*" is ignored in production: no browser origin may call the API. List exact origins to allow some.');
  }

  // Gemini when GEMINI_API_KEY is set; otherwise the rule-based coach only
  console.log(ai.configureFromEnv().message);

  // Delete security logs older than 1 year (and consent records 1 year after
  // an account was deleted): now, then once a day.
  startDailyPurge();

  const app = createApp();
  const server = app.listen(PORT, () => {
    console.log(`HeartPurse API running on http://localhost:${PORT}`);
    console.log(`Try: http://localhost:${PORT}/api/health-check`);
  });

  // Render stops the server with SIGTERM when it redeploys. Close cleanly.
  const stop = () => {
    server.close(() => db.close().finally(() => process.exit(0)));
    setTimeout(() => process.exit(0), 10000).unref();
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

start().catch((err) => {
  console.error('Could not start HeartPurse:', err.message);
  process.exit(1);
});
