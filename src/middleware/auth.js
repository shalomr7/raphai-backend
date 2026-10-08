// middleware/auth.js
// ------------------------------------------------------------
// "requireAuth" protects routes. The phone app must send:
//     Authorization: Bearer <token>
// The token is what /api/auth/login (or register) returned.
// If the token is good we put the user's id on req.user and continue.
// ------------------------------------------------------------

const jwt = require('jsonwebtoken');
const { HttpError } = require('../utils/http');

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
    next();
  } catch (err) {
    next(new HttpError(401, 'Your login has expired or is invalid. Please log in again.'));
  }
}

module.exports = { requireAuth, signToken };
