// routes/auth.js
// ------------------------------------------------------------
// POST /api/auth/register  -> create account, returns a token. Needs
//                             "accepted_terms": true (18+ and agrees to the
//                             Terms and Privacy Policy); we store that consent.
// POST /api/auth/login     -> check password, returns a token
// GET  /api/auth/me        -> who am I? (needs token)
// POST /api/auth/logout-all -> every token issued so far stops working
// DELETE /api/auth/me      -> delete my account and ALL my data (needs token
//                             + { "password": "..." } to confirm)
// Passwords are never stored. We store a bcrypt "hash" (a one-way scramble).
// ------------------------------------------------------------

const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { requireAuth, signToken, touchLastActive } = require('../middleware/auth');
const { validate, HttpError, asyncHandler } = require('../utils/http');
const { logSecurity } = require('../services/securityLog');
const { deleteAccount } = require('../services/account');
const { TERMS_VERSION } = require('./consents');
const { rateLimit, hit, peek, clear, tooMany, byIp } = require('../middleware/rateLimit');

const router = express.Router();

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ---- Rate limits (in memory; see middleware/rateLimit.js) ----
// Sign-ups: 20 per IP per hour.
const registerLimit = rateLimit({ name: 'register', windowMs: 60 * 60 * 1000, max: 20, key: byIp,
  message: 'Too many sign-ups from this network. Please try again later.' });
// Logins: 30 attempts per IP per 15 minutes ...
const loginIpLimit = rateLimit({ name: 'login_ip', windowMs: 15 * 60 * 1000, max: 30, key: byIp,
  message: 'Too many login attempts. Please wait 15 minutes and try again.' });
// ... and 8 WRONG passwords per email per 15 minutes (stops password guessing
// on one account from many IPs). A successful login clears the count.
const LOGIN_FAIL = { windowMs: 15 * 60 * 1000, max: 8 };

router.post('/register', registerLimit, asyncHandler(async (req, res) => {
  const body = validate(req.body, {
    name: { type: 'string', required: true, maxLength: 80 },
    email: { type: 'string', required: true, pattern: EMAIL, maxLength: 120 },
    password: { type: 'string', required: true, maxLength: 100 },
  });
  if (body.password.length < 8) throw new HttpError(400, 'Password must be at least 8 characters');
  // Must be exactly true (the app's required checkbox)
  if (req.body.accepted_terms !== true) {
    throw new HttpError(400, 'Please confirm you are 18 or older and agree to the Terms and Privacy Policy', ['accepted_terms must be true']);
  }

  const email = body.email.toLowerCase();
  const exists = await db.get('SELECT id FROM users WHERE email = $1', [email]);
  if (exists) throw new HttpError(409, 'An account with this email already exists');

  // 10 "rounds" = good balance between safety and speed
  // (async so a sign-up never blocks other requests)
  const hash = await bcrypt.hash(body.password, 10);

  // Create the user + empty profile + free plan + default reminders, all at once
  let id;
  try {
    id = await db.tx(async (t) => {
      const userId = (await t.get('INSERT INTO users (name, email, password_hash) VALUES ($1, $2, $3) RETURNING id', [body.name, email, hash])).id;
      await t.run('INSERT INTO profiles (user_id) VALUES ($1)', [userId]);
      await t.run("INSERT INTO subscriptions (user_id, plan) VALUES ($1, 'free')", [userId]);
      await t.run('INSERT INTO reminder_settings (user_id) VALUES ($1)', [userId]);
      await t.run("INSERT INTO consents (user_id, type, version, granted) VALUES ($1, 'terms_privacy', $2, true)", [userId, TERMS_VERSION]);
      await t.run('UPDATE users SET last_active_at = now() WHERE id = $1', [userId]);
      return Number(userId);
    });
  } catch (err) {
    // Two sign-ups with the same email at the same moment
    if (err.code === '23505') throw new HttpError(409, 'An account with this email already exists');
    throw err;
  }

  const user = { id, name: body.name, email };
  res.status(201).json({ token: signToken(user), user });
}));

// Always compare against SOME hash, so a wrong email takes as long as a wrong password
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password-raphai', 10);

router.post('/login', loginIpLimit, asyncHandler(async (req, res) => {
  const body = validate(req.body, {
    email: { type: 'string', required: true, maxLength: 120 },
    password: { type: 'string', required: true, maxLength: 100 },
  });
  const email = body.email.toLowerCase();
  const locked = peek('login_fail', email, LOGIN_FAIL);
  if (locked.limited) throw tooMany(locked.resetMs, 'Too many wrong passwords for this account. Please wait 15 minutes and try again.');

  const row = await db.get('SELECT * FROM users WHERE email = $1', [email]);
  const ok = await bcrypt.compare(body.password, row ? row.password_hash : DUMMY_HASH);

  // Same message for "no such email" and "wrong password" (safer)
  if (!row || !ok) {
    hit('login_fail', email, LOGIN_FAIL);
    await logSecurity('login_failed', { req, userId: row ? row.id : null });
    throw new HttpError(401, 'Wrong email or password');
  }
  clear('login_fail', email);
  await logSecurity('login_success', { req, userId: row.id });
  touchLastActive(row.id);
  const user = { id: row.id, name: row.name, email: row.email };
  res.json({ token: signToken(user), user });
}));

router.get('/me', requireAuth, asyncHandler(async (req, res) => {
  const user = await db.get('SELECT id, name, email, created_at FROM users WHERE id = $1', [req.user.id]);
  if (!user) throw new HttpError(404, 'User not found');
  res.json({ user });
}));

// Delete account. We ask for the password again so nobody can do it
// by accident (or with a stolen phone that is still logged in).
// The actual deleting is in services/account.js (shared with the public
// /delete-account web page).
router.delete('/me', requireAuth, asyncHandler(async (req, res) => {
  const { password } = validate(req.body, { password: { type: 'string', required: true, maxLength: 100 } });
  const row = await db.get('SELECT * FROM users WHERE id = $1', [req.user.id]);
  if (!row) throw new HttpError(404, 'User not found');
  if (!(await bcrypt.compare(password, row.password_hash))) throw new HttpError(401, 'Wrong password');
  await deleteAccount(row.id, { req });
  res.json({ deleted: true });
}));

// Log out on EVERY device: tokens issued before now stop working.
// (The app should then sign in again to get a fresh token.)
router.post('/logout-all', requireAuth, asyncHandler(async (req, res) => {
  await db.run('UPDATE users SET tokens_valid_after = now() WHERE id = $1', [req.user.id]);
  await logSecurity('logout_all', { req, userId: req.user.id });
  res.json({ logged_out_everywhere: true });
}));

module.exports = router;
