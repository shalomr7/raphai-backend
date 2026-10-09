// services/account.js
// ------------------------------------------------------------
// Deleting an account. Used by BOTH:
//   DELETE /api/auth/me     (in the app, logged in)
//   POST   /delete-account  (public web page, email + password)
// so the two can never behave differently.
//
// What happens (matches the Privacy Policy / the /delete-account page):
//   - the user row is deleted; "ON DELETE CASCADE" removes every row that
//     belongs to them (profile, logs, money data, insights, usage counts ...)
//   - custom foods stay in the shared food library, without the link to them
//   - Google Play purchase records stay (tax law) but lose the link (SET NULL)
//   - consent records are kept for 1 year after deletion, then purged
//   - a security log row "account_deleted" is written (kept 1 year)
// ------------------------------------------------------------

const bcrypt = require('bcryptjs');
const db = require('../db');
const { logSecurity } = require('./securityLog');

// Returns the user row if email + password match, otherwise null.
// Always runs bcrypt once, so a wrong email and a wrong password take
// about the same time.
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 10);
async function checkCredentials(email, password) {
  const row = await db.get('SELECT * FROM users WHERE email = $1', [String(email || '').trim().toLowerCase()]);
  const ok = await bcrypt.compare(String(password || ''), row ? row.password_hash : DUMMY_HASH);
  return row && ok ? row : null;
}

async function deleteAccount(userId, { req } = {}) {
  await db.tx(async (t) => {
    // Custom foods may be used by other people, so we keep them but remove the link to this user
    await t.run('UPDATE foods SET created_by = NULL WHERE created_by = $1', [userId]);
    // Consent records are kept for 1 year after deletion (proof of consent)
    await t.run('UPDATE consents SET account_deleted_at = now() WHERE user_id = $1 AND account_deleted_at IS NULL', [userId]);
    await t.run('DELETE FROM users WHERE id = $1', [userId]);
  });
  await logSecurity('account_deleted', { req, userId });
}

module.exports = { deleteAccount, checkCredentials };
