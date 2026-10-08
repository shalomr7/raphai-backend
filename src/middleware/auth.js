// middleware/auth.js
// ------------------------------------------------------------
// "requireAuth" protects routes. The phone app must send:
//     Authorization: Bearer <token>
// The token is what /api/auth/login (or register) returned.
// If the token is good we put the user's id on req.user and continue.
// ------------------------------------------------------------

const jwt = require('jsonwebtoken');
const { HttpError } = require('../utils/http');
const db = require('../db');

function jwtSecret() {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    // In development we allow a default so the app "just runs".
    if (process.env.NODE_ENV === 'production') throw new Error('JWT_SECRET must be set in production');
    return 'dev-only-secret-change-me';
  }
  return secret;
}

// Make a token for a user (used by register + login)
function signToken(user) {
  return jwt.sign({ sub: user.id, email: user.email }, jwtSecret(), {
    expiresIn: process.env.JWT_EXPIRES_IN || '7d',
  });
}

function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const [kind, token] = header.split(' ');
  if (kind !== 'Bearer' || !token) {
    return next(new HttpError(401, 'Please log in (missing Bearer token)'));
  }
  try {
    const payload = jwt.verify(token, jwtSecret());
    req.user = { id: payload.sub, email: payload.email };
    touchLastActive(req.user.id);
    next();
  } catch (err) {
    next(new HttpError(401, 'Your login has expired or is invalid. Please log in again.'));
  }
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
      console.error('Could not update last_active_at:', err.message);
    });
}

module.exports = { requireAuth, signToken, touchLastActive };
