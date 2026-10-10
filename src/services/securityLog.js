// services/securityLog.js
// ------------------------------------------------------------
// Security logs (Privacy Policy: "Security logs ... kept for 1 year in
// India"). They live in the main database (Supabase, Mumbai), table
// security_logs. We write one row on:
//   login_success | login_failed | password_change | account_deleted | export
// Rows older than 1 year are purged at startup and once a day.
// Writing a log must NEVER break the request, so errors are only printed.
// ------------------------------------------------------------

const db = require('../db');

const EVENTS = ['login_success', 'login_failed', 'password_change', 'account_deleted', 'export', 'logout_all', 'password_reset_requested', 'password_reset',
  // Admin dashboard (routes/admin.js). actor_id = the admin, user_id = the customer concerned.
  'admin_login_failed', 'admin_second_step_sent', 'admin_login_success', 'admin_denied', 'admin_view',
  'admin_customer_list', 'admin_customer_search', 'admin_customer_view', 'admin_phone_reveal',
  'admin_customer_csv', 'admin_user_export', 'admin_user_delete'];
const RETENTION = '1 year';
const DAY_MS = 24 * 60 * 60 * 1000;

function clientIp(req) {
  if (!req) return null;
  return (req.ip || (req.socket && req.socket.remoteAddress) || '').slice(0, 64) || null;
}
function userAgent(req) {
  const ua = req && req.headers && req.headers['user-agent'];
  return ua ? String(ua).slice(0, 300) : null;
}

// logSecurity('login_failed', { req, userId })  -> resolves, never throws
// Admin events also pass actorId (the admin) and a small detail object.
async function logSecurity(event, { req, userId = null, actorId = null, detail = null } = {}) {
  if (!EVENTS.includes(event)) throw new Error(`Unknown security event: ${event}`);
  const num = (v) => (v === null || v === undefined ? null : Number(v));
  try {
    await db.run('INSERT INTO security_logs (user_id, event, ip, user_agent, actor_id, detail) VALUES ($1, $2, $3, $4, $5, $6)',
      [num(userId), event, clientIp(req), userAgent(req), num(actorId), detail ? JSON.stringify(detail) : null]);
  } catch (err) {
    console.error('Could not write security log:', err.code || err.message);
  }
}

// Delete security logs older than 1 year, and consent records of deleted
// accounts more than 1 year after the deletion. Returns how many rows went.
async function purgeOldRecords() {
  const logs = await db.run(`DELETE FROM security_logs WHERE created_at < now() - interval '${RETENTION}'`);
  const consents = await db.run(`DELETE FROM consents WHERE account_deleted_at IS NOT NULL AND account_deleted_at < now() - interval '${RETENTION}'`);
  return { security_logs: logs.changes, consents: consents.changes };
}

// Run the purge now and then every 24 hours. Returns the timer (unref'd so it
// never keeps the process alive).
function startDailyPurge() {
  const runOnce = () => purgeOldRecords()
    .then((n) => { if (n.security_logs || n.consents) console.log('Purged old records:', n); })
    .catch((err) => console.error('Purge of old records failed:', err.message));
  runOnce();
  const timer = setInterval(runOnce, DAY_MS);
  if (timer.unref) timer.unref();
  return timer;
}

module.exports = { logSecurity, purgeOldRecords, startDailyPurge, EVENTS };
