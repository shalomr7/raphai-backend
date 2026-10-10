// admin/auth.js
// ------------------------------------------------------------
// Owner-only access to the admin dashboard (/admin, /api/admin/*).
//
// Who: only accounts whose email is in ADMIN_EMAILS (comma separated,
// default rooppashalemraju@gmail.com). Checked again on EVERY request,
// so removing an email from ADMIN_EMAILS locks it out at once.
//
// How (two steps):
//   1. POST /api/admin/login  { email, password }   the normal HeartPurse login
//   2. POST /api/admin/verify { challenge, code }    an extra admin step:
//        ADMIN_SECOND_FACTOR=email     a 6-digit code emailed to the admin
//                                      (needs RESEND_API_KEY + EMAIL_FROM)
//        ADMIN_SECOND_FACTOR=password  a separate admin password whose bcrypt
//                                      hash is in ADMIN_PASSWORD_HASH
//      Default: email if email sending is configured, else password if
//      ADMIN_PASSWORD_HASH is set, else admin login is switched off (503).
//   -> a short-lived admin token (ADMIN_SESSION_MINUTES, default 30).
//
// The admin token is signed with a key DERIVED from JWT_SECRET
// (HMAC "heartpurse-admin-v1"), audience "heartpurse-admin". So a normal app
// token never works on /api/admin (-> 403) and an admin token never works on
// the app API (-> 401). "Log out everywhere" (users.tokens_valid_after) also
// ends admin sessions.
// Rate limits: login 10 / 15 min per IP and 5 wrong passwords per email;
// verify 10 / 15 min per IP and 5 wrong codes per challenge.
// ------------------------------------------------------------

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { jwtSecret, verifyToken, ALGORITHM } = require('../middleware/auth');
const { HttpError } = require('../utils/http');
const { getEmailProvider } = require('../services/email');

const DEFAULT_ADMIN = 'rooppashalemraju@gmail.com';
const AUDIENCE = 'heartpurse-admin';
const CHALLENGE_TTL_MS = 10 * 60 * 1000;
const MAX_CODE_ATTEMPTS = 5;

function adminEmails(env = process.env) {
  const raw = env.ADMIN_EMAILS === undefined ? DEFAULT_ADMIN : String(env.ADMIN_EMAILS);
  return raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
}
const isAdminEmail = (email) => adminEmails().includes(String(email || '').trim().toLowerCase());

function secondFactorMode(env = process.env) {
  const want = String(env.ADMIN_SECOND_FACTOR || '').trim().toLowerCase();
  const emailOk = Boolean(getEmailProvider());
  const pwOk = Boolean(String(env.ADMIN_PASSWORD_HASH || '').trim());
  if (want === 'email') return emailOk ? 'email' : null;
  if (want === 'password') return pwOk ? 'password' : null;
  if (emailOk) return 'email';
  if (pwOk) return 'password';
  return null;
}

function adminKey() {
  return crypto.createHmac('sha256', jwtSecret()).update('heartpurse-admin-v1').digest('hex');
}
const sessionMinutes = () => Math.min(120, Math.max(5, Number(process.env.ADMIN_SESSION_MINUTES) || 30));

function signAdminToken(userId) {
  return jwt.sign({ sub: String(userId), adm: 1 }, adminKey(), { algorithm: ALGORITHM, audience: AUDIENCE, expiresIn: `${sessionMinutes()}m` });
}

// ---- Step-2 challenges (in memory: Render runs one instance) ----
const challenges = new Map(); // id -> { userId, mode, codeHash, expiresAt, attempts }
const hmac = (s) => crypto.createHmac('sha256', adminKey()).update(String(s)).digest('hex');
function sweep() { const now = Date.now(); for (const [k, c] of challenges) if (c.expiresAt <= now) challenges.delete(k); }

async function startChallenge(user) {
  sweep();
  const mode = secondFactorMode();
  if (!mode) throw new HttpError(503, 'Admin sign-in is not set up yet (no second step configured).');
  const id = crypto.randomBytes(24).toString('base64url');
  const c = { userId: user.id, mode, codeHash: null, expiresAt: Date.now() + CHALLENGE_TTL_MS, attempts: 0 };
  if (mode === 'email') {
    const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    c.codeHash = hmac(`${id}:${code}`);
    await getEmailProvider().send({
      to: user.email,
      subject: 'HeartPurse admin sign-in code',
      text: `Your HeartPurse admin sign-in code is ${code}. It works once, for 10 minutes.\n\nIf you did not try to sign in to the admin dashboard, change your password now.`,
    });
  }
  challenges.set(id, c);
  return { challenge: id, step: mode === 'email' ? 'email_code' : 'admin_password', expires_in_s: CHALLENGE_TTL_MS / 1000 };
}

// Returns the userId on success; throws 401 otherwise.
async function finishChallenge(id, code) {
  sweep();
  const c = challenges.get(String(id || ''));
  if (!c) throw new HttpError(401, 'This sign-in has expired. Please start again.');
  c.attempts += 1;
  if (c.attempts > MAX_CODE_ATTEMPTS) { challenges.delete(id); throw new HttpError(401, 'Too many wrong tries. Please start again.'); }
  let ok = false;
  if (c.mode === 'email') {
    const a = Buffer.from(hmac(`${id}:${String(code || '').trim()}`)); const b = Buffer.from(c.codeHash);
    ok = a.length === b.length && crypto.timingSafeEqual(a, b);
  } else {
    ok = await bcrypt.compare(String(code || ''), String(process.env.ADMIN_PASSWORD_HASH || '').trim());
  }
  if (!ok) throw new HttpError(401, c.mode === 'email' ? 'Wrong code' : 'Wrong admin password');
  challenges.delete(id);
  return c.userId;
}

// ---- requireAdmin middleware ----
// No/garbage token -> 401. A valid APP token (any user) -> 403.
// Admin token whose user is gone, revoked or no longer in ADMIN_EMAILS -> 403.
function requireAdmin(onDenied) {
  return async (req, res, next) => {
    const [kind, token] = String(req.headers.authorization || '').split(' ');
    if (kind !== 'Bearer' || !token) return next(new HttpError(401, 'Admin sign-in required'));
    let payload = null;
    try {
      payload = jwt.verify(token, adminKey(), { algorithms: [ALGORITHM], audience: AUDIENCE });
    } catch {
      let appUser = null;
      try { appUser = verifyToken(token); } catch { /* not an app token either */ }
      if (appUser) {
        if (onDenied) onDenied(req, Number(appUser.sub));
        return next(new HttpError(403, 'This area is for the HeartPurse owner only.'));
      }
      return next(new HttpError(401, 'Admin sign-in expired. Please sign in again.'));
    }
    const id = Number(payload.sub);
    try {
      const row = Number.isInteger(id) ? await db.get('SELECT id, email, tokens_valid_after FROM users WHERE id = $1', [id]) : null;
      const revoked = row && row.tokens_valid_after && Number(payload.iat) < Math.floor(new Date(row.tokens_valid_after).getTime() / 1000);
      if (!row || revoked || !isAdminEmail(row.email)) {
        if (onDenied) onDenied(req, id);
        return next(new HttpError(403, 'This area is for the HeartPurse owner only.'));
      }
      req.admin = { id: row.id };
      next();
    } catch (err) { next(err); }
  };
}

function resetChallenges() { challenges.clear(); } // tests

module.exports = {
  adminEmails, isAdminEmail, secondFactorMode, signAdminToken, startChallenge, finishChallenge,
  requireAdmin, resetChallenges, AUDIENCE, DEFAULT_ADMIN,
};
