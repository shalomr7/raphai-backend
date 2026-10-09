// routes/passwordReset.js  (mounted under /api/auth)
// ------------------------------------------------------------
// POST /api/auth/forgot { email }  -> emails a 6-digit code (valid 15 min).
//   Always the same 200 answer, so it never reveals which emails exist.
//   Email not configured: 503 email_unavailable in production.
// POST /api/auth/reset { email, code, new_password }
//   Max 5 tries per code. Success: new password, every old token revoked,
//   security log row. The app then signs in again.
// Only an HMAC of the code is stored; the code itself is never logged.
// ------------------------------------------------------------
const crypto = require('crypto');
const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { validate, HttpError, asyncHandler } = require('../utils/http');
const { logSecurity } = require('../services/securityLog');
const email = require('../services/email');
const { rateLimit, hit, clear, byIp } = require('../middleware/rateLimit');

const router = express.Router();
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CODE_TTL_MIN = 15;
const MAX_TRIES = 5;
const SENT = { ok: true, message: `If an account exists for this email, we sent a 6-digit code. It is valid for ${CODE_TTL_MIN} minutes.` };

const forgotIpLimit = rateLimit({ name: 'forgot_ip', windowMs: 60 * 60 * 1000, max: 10, key: byIp,
  message: 'Too many reset requests. Please try again later.' });
const resetIpLimit = rateLimit({ name: 'reset_ip', windowMs: 15 * 60 * 1000, max: 20, key: byIp,
  message: 'Too many attempts. Please wait 15 minutes and try again.' });
const PER_EMAIL = { windowMs: 60 * 60 * 1000, max: 3 }; // codes sent per email per hour (silent)

const hashCode = (userId, code) =>
  crypto.createHmac('sha256', process.env.JWT_SECRET || 'dev-reset-secret').update(`${userId}:${code}`).digest('hex');

router.post('/forgot', forgotIpLimit, asyncHandler(async (req, res) => {
  const body = validate(req.body, { email: { type: 'string', required: true, pattern: EMAIL, maxLength: 120 } });
  const provider = email.getEmailProvider();
  if (!provider) {
    console.warn('Password reset requested but email not configured');
    if (process.env.NODE_ENV === 'production') {
      const e = new HttpError(503, 'Password reset by email is not available right now. Please contact support.');
      e.extra = { code: 'email_unavailable' };
      throw e;
    }
    return res.json(SENT);
  }
  const addr = body.email.toLowerCase();
  if (hit('forgot_email', addr, PER_EMAIL).limited) return res.json(SENT);
  const user = await db.get('SELECT id FROM users WHERE email = $1', [addr]);
  if (user) {
    const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    await db.tx(async (t) => {
      await t.run('UPDATE password_resets SET used_at = now() WHERE user_id = $1 AND used_at IS NULL', [user.id]);
      await t.run(`INSERT INTO password_resets (user_id, code_hash, expires_at) VALUES ($1, $2, now() + interval '${CODE_TTL_MIN} minutes')`,
        [user.id, hashCode(user.id, code)]);
    });
    await logSecurity('password_reset_requested', { req, userId: user.id });
    try {
      await provider.send({
        to: addr,
        subject: 'Your HeartPurse password reset code',
        text: `Your HeartPurse password reset code is ${code}\n\nIt is valid for ${CODE_TTL_MIN} minutes. If you did not ask for this, you can ignore this email; your password stays the same.`,
      });
    } catch (err) {
      console.error('Password reset email failed:', err.message);
    }
  }
  res.json(SENT);
}));

const BAD_CODE = 'That code is wrong or has expired. Please request a new one.';

router.post('/reset', resetIpLimit, asyncHandler(async (req, res) => {
  const body = validate(req.body, {
    email: { type: 'string', required: true, pattern: EMAIL, maxLength: 120 },
    code: { type: 'string', required: true, pattern: /^\d{6}$/, maxLength: 6 },
    new_password: { type: 'string', required: true, maxLength: 100 },
  });
  if (body.new_password.length < 8) throw new HttpError(400, 'Password must be at least 8 characters');
  const addr = body.email.toLowerCase();
  const user = await db.get('SELECT id FROM users WHERE email = $1', [addr]);
  const row = user && await db.get(`SELECT id, code_hash, attempts FROM password_resets
    WHERE user_id = $1 AND used_at IS NULL AND expires_at > now() ORDER BY id DESC LIMIT 1`, [user.id]);
  if (!row || row.attempts >= MAX_TRIES) throw new HttpError(400, BAD_CODE);

  const a = Buffer.from(hashCode(user.id, body.code)); const b = Buffer.from(row.code_hash);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    await db.run('UPDATE password_resets SET attempts = attempts + 1 WHERE id = $1', [row.id]);
    throw new HttpError(400, row.attempts + 1 >= MAX_TRIES ? BAD_CODE : 'That code is not right. Please check the email and try again.');
  }

  const hash = await bcrypt.hash(body.new_password, 10);
  const done = await db.tx(async (t) => {
    // Claim the code once (two parallel requests cannot both use it)
    const claimed = await t.run('UPDATE password_resets SET used_at = now() WHERE id = $1 AND used_at IS NULL', [row.id]);
    if (!claimed.changes) return false;
    await t.run('UPDATE users SET password_hash = $1, tokens_valid_after = now() WHERE id = $2', [hash, user.id]);
    return true;
  });
  if (!done) throw new HttpError(400, BAD_CODE);
  clear('login_fail', addr);
  await logSecurity('password_reset', { req, userId: user.id });
  res.json({ reset: true, message: 'Password changed. Please sign in with your new password.' });
}));

module.exports = router;
