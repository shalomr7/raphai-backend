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

const PORT = Number(process.env.PORT) || 4000;

async function start() {
  await db.init();
  console.log('Database ready (tables checked, foods seeded)');

  const app = createApp();
  const server = app.listen(PORT, () => {
    console.log(`RaphAi API running on http://localhost:${PORT}`);
    console.log(`Try: http://localhost:${PORT}/api/health-check`);
    if (!process.env.RAZORPAY_KEY_ID) console.log('Razorpay: STUB mode (no keys set, nothing will be charged)');
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
  console.error('Could not start RaphAi:', err.message);
  process.exit(1);
});
