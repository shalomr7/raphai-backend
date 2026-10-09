// middleware/rateLimit.js
// ------------------------------------------------------------
// Small in-memory fixed-window rate limiter.
//
//   rateLimit({ name, windowMs, max, key: (req) => string })  -> middleware
//   hit(name, key, { windowMs, max })  -> { limited, remaining, resetMs }
//
// In memory = per server process. Render free runs ONE instance, so this
// is correct today. If the API ever runs on several instances, move the
// counters to Postgres or Redis (see docs/SECURITY.md).
// Over the limit -> 429 { error, retry_after_s } + Retry-After header.
// ------------------------------------------------------------

const { HttpError } = require('../utils/http');

const buckets = new Map(); // `${name}|${key}` -> { count, resetAt }
const MAX_KEYS = 100000;

function sweep(now) {
  for (const [k, b] of buckets) if (b.resetAt <= now) buckets.delete(k);
}

// Count one hit. Returns whether the caller is now over the limit.
function hit(name, key, { windowMs, max }) {
  const now = Date.now();
  if (buckets.size > MAX_KEYS) sweep(now);
  const id = `${name}|${key}`;
  let b = buckets.get(id);
  if (!b || b.resetAt <= now) { b = { count: 0, resetAt: now + windowMs }; buckets.set(id, b); }
  b.count += 1;
  return { limited: b.count > max, remaining: Math.max(0, max - b.count), resetMs: b.resetAt - now };
}

// Is the key already over the limit? (does not count a hit)
function peek(name, key, { max }) {
  const b = buckets.get(`${name}|${key}`);
  if (!b || b.resetAt <= Date.now()) return { limited: false, resetMs: 0 };
  return { limited: b.count >= max, resetMs: b.resetAt - Date.now() };
}

function clear(name, key) { buckets.delete(`${name}|${key}`); }

function tooMany(resetMs, message) {
  const retry = Math.max(1, Math.ceil(resetMs / 1000));
  const e = new HttpError(429, message || 'Too many requests. Please wait a little and try again.');
  e.extra = { retry_after_s: retry };
  e.retryAfter = retry;
  return e;
}

function rateLimit({ name, windowMs, max, key, message }) {
  return (req, res, next) => {
    const k = key(req);
    if (k == null) return next();
    const r = hit(name, k, { windowMs, max });
    res.set('RateLimit-Limit', String(max));
    res.set('RateLimit-Remaining', String(r.remaining));
    if (r.limited) {
      res.set('Retry-After', String(Math.max(1, Math.ceil(r.resetMs / 1000))));
      return next(tooMany(r.resetMs, message));
    }
    next();
  };
}

const byIp = (req) => req.ip || 'unknown';
const byUser = (req) => (req.user ? `u${req.user.id}` : null);

function resetAll() { buckets.clear(); } // for tests

module.exports = { rateLimit, hit, peek, clear, tooMany, byIp, byUser, resetAll };
