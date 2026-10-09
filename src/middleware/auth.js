// middleware/auth.js
// ------------------------------------------------------------
// "requireAuth" protects routes. The phone app must send:
//     Authorization: Bearer <token>
// The token is what /api/auth/login (or register) returned.
// A token is accepted only if:
//   - it is signed with JWT_SECRET using HS256 (no other algorithm),
//   - it has not expired (JWT_EXPIRES_IN, default 7 days),
//   - its user still exists (a deleted account's token stops working), and
//   - it was issued after users.tokens_valid_after ("log out everywhere").
// Then req.user = { id } and the request continues.
// ------------------------------------------------------------

const jwt = require('jsonwebtoken');
const { HttpError } = require('../utils/http');
const db = require('../db');

const ALGORITHM = 'HS256';
const MIN_SECRET_LENGTH = 32;
const DEV_SECRET = 'dev-only-secret-change-me';

// Only development and test may run without a real secret.
function jwtSecret() {
  const secret = process.env.JWT_SECRET;
  const env = process.env.NODE_ENV;
  if (!secret) {
    if (env === 'development' || env === 'test') return DEV_SECRET;
    throw new Error('JWT_SECRET must be set (only NODE_ENV=development or test may run without one)');
  }
  if (env === 'production' && secret.length < MIN_SECRET_LENGTH) {
    throw new Error(`JWT_SECRET is too short for production (needs at least ${MIN_SECRET_LENGTH} characters)`);
  }
  return secret;
}

// Called by server.js at start-up so a bad secret stops the deploy
// instead of failing on the first login.
function assertAuthConfig() { jwtSecret(); }

// Make a token for a user (used by register + login).
// The token carries only the user id (no email or name).
function signToken(user) {
  return jwt.sign({ sub: String(user.id) }, jwtSecret(), {
    algorithm: ALGORITHM,
    expiresIn: process.env.JWT_EXPIRES_IN || '7d',
  });
}

function verifyToken(token) {
  return jwt.verify(token, jwtSecret(), { algorithms: [ALGORITHM] });
}

const INVALID = 'Your login has expired or is invalid. Please log in again.';

async function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const [kind, token] = header.split(' ');
  if (kind !== 'Bearer' || !token) {
    return next(new HttpError(401, 'Please log in (missing Bearer token)'));
  }
  let payload;
  try {
    payload = verifyToken(token);
  } catch {
    return next(new HttpError(401, INVALID));
  }
  const id = Number(payload.sub);
  if (!Number.isInteger(id) || id <= 0) return next(new HttpError(401, INVALID));
  try {
    const row = await db.get('SELECT tokens_valid_after FROM users WHERE id = $1', [id]);
    if (!row) return next(new HttpError(401, INVALID));
    if (row.tokens_valid_after && Number(payload.iat) < Math.floor(new Date(row.tokens_valid_after).getTime() / 1000)) {
      return next(new HttpError(401, INVALID));
    }
  } catch (err) {
    return next(err);
  }
  req.user = { id };
  touchLastActive(id);
  next();
}

// ------------------------------------------------------------
// users.last_active_at: when the user last used the app.
// Updated at most ONCE PER DAY per user (an in-memory note stops extra
// queries, and the SQL itself also skips rows touched in the last 24 hours).
// It runs in the background and never slows down or breaks the request.
// NOTE: this only RECORDS activity. The Privacy Policy says we *may* delete
// accounts after 3 years of inactivity (with 48 hours' notice); that job is
// not built yet, so nothing is ever deleted automatically.
// ------------------------------------------------------------
const lastTouched = new Map(); // userId -> 'YYYY-MM-DD' (UTC)
function touchLastActive(userId, { force = false } = {}) {
  const day = new Date().toISOString().slice(0, 10);
  if (!force && lastTouched.get(userId) === day) return Promise.resolve();
  if (lastTouched.size > 50000) lastTouched.clear(); // keep memory bounded
  lastTouched.set(userId, day);
  return db.run(`UPDATE users SET last_active_at = now()
    WHERE id = $1 AND (last_active_at IS NULL OR last_active_at < now() - interval '1 day')`, [userId])
    .catch((err) => {
      lastTouched.delete(userId);
      console.error('Could not update last_active_at:', err.code || err.message);
    });
}

module.exports = { requireAuth, signToken, verifyToken, touchLastActive, assertAuthConfig, jwtSecret, ALGORITHM };
