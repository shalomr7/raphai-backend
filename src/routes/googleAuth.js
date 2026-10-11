// routes/googleAuth.js  (mounted under /api/auth)
// ------------------------------------------------------------
// Google sign-in (Android). The app gets an ID token from Google Sign-In
// (audience = our WEB client id) and sends it here; we verify it ourselves.
//
// POST   /api/auth/google { idToken, accepted_terms? }  (public)
//   1. Google account already linked        -> sign in that user
//   2. Not linked, a user has the same email -> link it automatically, then
//      sign in (Google says the email is verified; recorded in security_logs
//      as google_auto_linked)
//   3. Nobody has it                        -> new account. Needs
//      accepted_terms: true (same consent as sign-up); without it we answer
//      200 { needs_consent: true, ... } and create nothing.
//   Tokens whose email Google has NOT verified are refused (403), so an
//   unverified email can never take over an account.
//   Success: { token, user } exactly like /login, plus { created, linked }.
// GET    /api/auth/identities        (login) -> { password, google: { linked, email } }
// POST   /api/auth/google/link   { idToken } (login) -> link Google to me
// DELETE /api/auth/google/unlink         (login) -> refused if it is my only way in
// Not configured (GOOGLE_WEB_CLIENT_ID unset) -> 503 "Google sign-in not configured".
// ------------------------------------------------------------
const express = require('express');
const db = require('../db');
const { requireAuth, signToken, touchLastActive } = require('../middleware/auth');
const { validate, HttpError, asyncHandler } = require('../utils/http');
const { logSecurity } = require('../services/securityLog');
const { TERMS_VERSION } = require('./consents');
const { rateLimit, byIp, byUser } = require('../middleware/rateLimit');
const google = require('../services/googleIdentity');

const router = express.Router();

const googleIpLimit = rateLimit({ name: 'google_ip', windowMs: 15 * 60 * 1000, max: 30, key: byIp,
  message: 'Too many sign-in attempts. Please wait 15 minutes and try again.' });
const linkUserLimit = rateLimit({ name: 'google_link_user', windowMs: 15 * 60 * 1000, max: 10, key: byUser,
  message: 'Too many attempts. Please wait 15 minutes and try again.' });

const TOKEN_RULE = { idToken: { type: 'string', required: true, maxLength: 4096 } };

function requireConfigured(req, res, next) {
  return google.isConfigured() ? next() : next(google.notConfigured());
}

function unverified() {
  const e = new HttpError(403, 'This Google account\'s email is not verified. Please verify it with Google, or sign in with email and password.');
  e.extra = { code: 'google_email_unverified' };
  return e;
}

const touchIdentity = (id) => db.run('UPDATE user_identities SET last_used_at = now() WHERE id = $1', [id])
  .catch((err) => console.error('Could not update identity last_used_at:', err.code || err.message));

function signedIn(res, row, extra = {}, status = 200) {
  touchLastActive(row.id);
  const user = { id: Number(row.id), name: row.name, email: row.email };
  res.status(status).json({ token: signToken(user), user, ...extra });
}

router.post('/google', googleIpLimit, requireConfigured, asyncHandler(async (req, res) => {
  const { idToken } = validate(req.body, TOKEN_RULE);
  const g = await google.verifyGoogleIdToken(idToken);
  if (!g.email_verified || !g.email) {
    await logSecurity('google_login_rejected', { req, detail: { reason: 'email_unverified' } });
    throw unverified();
  }

  // 1. Already linked
  const linked = await db.get(`SELECT i.id AS identity_id, u.id, u.name, u.email FROM user_identities i
    JOIN users u ON u.id = i.user_id WHERE i.provider = 'google' AND i.provider_sub = $1`, [g.sub]);
  if (linked) {
    touchIdentity(linked.identity_id);
    await logSecurity('login_success', { req, userId: linked.id, detail: { method: 'google' } });
    return signedIn(res, linked, { created: false, linked: false });
  }

  // 2. Same (Google-verified) email as an existing account -> safe auto-link
  const existing = await db.get('SELECT id, name, email FROM users WHERE email = $1', [g.email]);
  if (existing) {
    const has = await db.get("SELECT id FROM user_identities WHERE user_id = $1 AND provider = 'google'", [existing.id]);
    if (has) {
      // That account is already linked to a DIFFERENT Google account: do not add a second one
      await logSecurity('google_login_rejected', { req, userId: existing.id, detail: { reason: 'other_google_linked' } });
      const e = new HttpError(409, 'This email\'s HeartPurse account is linked to a different Google account. Please sign in with that Google account or with your password.');
      e.extra = { code: 'google_other_linked' };
      throw e;
    }
    try {
      await db.run(`INSERT INTO user_identities (user_id, provider, provider_sub, email, email_verified, last_used_at)
        VALUES ($1, 'google', $2, $3, true, now())`, [existing.id, g.sub, g.email]);
    } catch (err) {
      if (err.code === '23505') throw new HttpError(409, 'This Google account was just linked. Please try signing in again.');
      throw err;
    }
    await logSecurity('google_auto_linked', { req, userId: existing.id, detail: { reason: 'verified_email_match' } });
    await logSecurity('login_success', { req, userId: existing.id, detail: { method: 'google' } });
    return signedIn(res, existing, { created: false, linked: true });
  }

  // 3. New account: same consent as sign-up
  if (req.body.accepted_terms !== true) {
    return res.json({ needs_consent: true, terms_version: TERMS_VERSION, email: g.email, name: g.name });
  }
  const name = (g.name || g.email.split('@')[0]).trim().slice(0, 80) || 'HeartPurse user';
  let id;
  try {
    id = await db.tx(async (t) => {
      const userId = (await t.get('INSERT INTO users (name, email, password_hash) VALUES ($1, $2, NULL) RETURNING id', [name, g.email])).id;
      await t.run(`INSERT INTO user_identities (user_id, provider, provider_sub, email, email_verified, last_used_at)
        VALUES ($1, 'google', $2, $3, true, now())`, [userId, g.sub, g.email]);
      await t.run('INSERT INTO profiles (user_id) VALUES ($1)', [userId]);
      await t.run("INSERT INTO subscriptions (user_id, plan) VALUES ($1, 'free')", [userId]);
      await t.run('INSERT INTO reminder_settings (user_id) VALUES ($1)', [userId]);
      await t.run("INSERT INTO consents (user_id, type, version, granted) VALUES ($1, 'terms_privacy', $2, true)", [userId, TERMS_VERSION]);
      await t.run('UPDATE users SET last_active_at = now() WHERE id = $1', [userId]);
      return Number(userId);
    });
  } catch (err) {
    // Two requests for the same new Google account at the same moment
    if (err.code === '23505') throw new HttpError(409, 'This account was just created. Please try signing in again.');
    throw err;
  }
  await logSecurity('google_signup', { req, userId: id });
  signedIn(res, { id, name, email: g.email }, { created: true, linked: false }, 201);
}));

router.get('/identities', requireAuth, asyncHandler(async (req, res) => {
  const u = await db.get('SELECT password_hash IS NOT NULL AS has_password FROM users WHERE id = $1', [req.user.id]);
  const g = await db.get("SELECT email FROM user_identities WHERE user_id = $1 AND provider = 'google'", [req.user.id]);
  res.json({
    password: Boolean(u && u.has_password),
    google: { linked: Boolean(g), email: g ? g.email : null, available: google.isConfigured() },
  });
}));

router.post('/google/link', requireAuth, linkUserLimit, requireConfigured, asyncHandler(async (req, res) => {
  const { idToken } = validate(req.body, TOKEN_RULE);
  const g = await google.verifyGoogleIdToken(idToken);
  if (!g.email_verified || !g.email) throw unverified();
  const owner = await db.get("SELECT user_id FROM user_identities WHERE provider = 'google' AND provider_sub = $1", [g.sub]);
  if (owner && Number(owner.user_id) === req.user.id) return res.json({ linked: true, email: g.email });
  if (owner) {
    const e = new HttpError(409, 'This Google account is already linked to another HeartPurse account.');
    e.extra = { code: 'google_in_use' };
    throw e;
  }
  const mine = await db.get("SELECT id FROM user_identities WHERE user_id = $1 AND provider = 'google'", [req.user.id]);
  if (mine) {
    const e = new HttpError(409, 'A different Google account is already linked. Unlink it first.');
    e.extra = { code: 'google_other_linked' };
    throw e;
  }
  try {
    await db.run(`INSERT INTO user_identities (user_id, provider, provider_sub, email, email_verified)
      VALUES ($1, 'google', $2, $3, true)`, [req.user.id, g.sub, g.email]);
  } catch (err) {
    if (err.code === '23505') throw new HttpError(409, 'This Google account is already linked to a HeartPurse account.');
    throw err;
  }
  await logSecurity('google_linked', { req, userId: req.user.id });
  res.status(201).json({ linked: true, email: g.email });
}));

router.delete('/google/unlink', requireAuth, linkUserLimit, asyncHandler(async (req, res) => {
  const u = await db.get('SELECT password_hash IS NOT NULL AS has_password FROM users WHERE id = $1', [req.user.id]);
  const g = await db.get("SELECT id FROM user_identities WHERE user_id = $1 AND provider = 'google'", [req.user.id]);
  if (!g) return res.json({ linked: false });
  if (!u || !u.has_password) {
    const e = new HttpError(409, 'Google is your only way to sign in. Set a password first (use "Forgot password" with your email), then unlink Google.');
    e.extra = { code: 'last_login_method' };
    throw e;
  }
  await db.run('DELETE FROM user_identities WHERE id = $1', [g.id]);
  await logSecurity('google_unlinked', { req, userId: req.user.id });
  res.json({ linked: false });
}));

module.exports = router;
