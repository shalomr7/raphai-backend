// utils/http.js
// ------------------------------------------------------------
// Small helpers used everywhere:
//  - HttpError: throw this to send a clean error (e.g. 400, 404)
//  - asyncHandler: lets "async" route functions send errors to the error handler
//  - validate: checks the data sent by the app (body or query)
// ------------------------------------------------------------

// An error that also carries an HTTP status code
class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
    this.expose = true; // our own message is safe to show, even for 5xx (e.g. 503 "billing not configured")
  }
}

// Express 4 does not catch errors from async functions by itself.
// Wrap async routes like: router.get('/x', asyncHandler(async (req, res) => {...}))
const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_RE = /^\d{4}-\d{2}$/;

// A real calendar date: 2026-02-31 is rejected (new Date() would roll it over)
function isRealDate(v) {
  const str = String(v);
  if (!DATE_RE.test(str)) return false;
  const d = new Date(`${str}T00:00:00Z`);
  return !isNaN(d) && d.toISOString().slice(0, 10) === str;
}

/**
 * validate(data, rules, { partial })
 * Checks "data" (usually req.body) against simple rules and returns a
 * clean object with only the allowed fields.
 *
 * A rule looks like:
 *   { type: 'number' | 'integer' | 'money' | 'string' | 'date' | 'month' | 'boolean',
 *     required: true, min: 0, max: 100, oneOf: ['a','b'], maxLength: 200 }
 *
 * partial: true -> nothing is required (used for "update" requests)
 * If anything is wrong we throw HttpError(400) with a list of problems.
 */
function validate(data, rules, { partial = false } = {}) {
  data = data || {};
  const clean = {};
  const errors = [];

  for (const [field, rule] of Object.entries(rules)) {
    let value = data[field];
    const missing = value === undefined || value === null || value === '';

    if (missing) {
      if (rule.required && !partial) errors.push(`${field} is required`);
      continue;
    }

    // Objects and arrays are never valid for these simple fields
    // (stops tricks like {"amount": [5]} or {"name": {"$gt": ""}})
    if (typeof value === 'object') { errors.push(`${field} must be a ${rule.type === 'money' ? 'number' : rule.type || 'string'}`); continue; }

    // Turn strings like "12" into numbers (query strings are always text)
    if (rule.type === 'number' || rule.type === 'integer' || rule.type === 'money') {
      if (typeof value !== 'number' && typeof value !== 'string') { errors.push(`${field} must be a number`); continue; }
      value = Number(value);
      if (!Number.isFinite(value)) { errors.push(`${field} must be a number`); continue; }
      if (rule.type === 'integer' && !Number.isInteger(value)) { errors.push(`${field} must be a whole number`); continue; }
      // Money: rupees with at most 2 decimals (whole paise). 12.345 -> 12.35
      if (rule.type === 'money') value = Math.round(value * 100) / 100;
      if (rule.min !== undefined && value < rule.min) errors.push(`${field} must be at least ${rule.min}`);
      if (rule.max !== undefined && value > rule.max) errors.push(`${field} must be at most ${rule.max}`);
    } else if (rule.type === 'boolean') {
      if (value === true || value === 'true' || value === 1 || value === '1') value = true;
      else if (value === false || value === 'false' || value === 0 || value === '0') value = false;
      else { errors.push(`${field} must be true or false`); continue; }
    } else if (rule.type === 'date') {
      if (!isRealDate(value)) { errors.push(`${field} must be a date like 2026-10-07`); continue; }
    } else if (rule.type === 'month') {
      if (!MONTH_RE.test(String(value)) || Number(String(value).slice(5, 7)) < 1 || Number(String(value).slice(5, 7)) > 12) { errors.push(`${field} must be a month like 2026-10`); continue; }
    } else {
      // default: string
      if (typeof value !== 'string' && typeof value !== 'number') { errors.push(`${field} must be text`); continue; }
      value = String(value).trim();
      if (rule.maxLength && value.length > rule.maxLength) errors.push(`${field} is too long (max ${rule.maxLength})`);
      if (rule.pattern && !rule.pattern.test(value)) errors.push(`${field} is not valid`);
    }

    if (rule.oneOf && !rule.oneOf.includes(value)) {
      errors.push(`${field} must be one of: ${rule.oneOf.join(', ')}`);
    }
    clean[field] = value;
  }

  if (errors.length) throw new HttpError(400, 'Invalid input', errors);
  return clean;
}

// Turn an id from the URL (/api/expenses/5) into a number, or fail with 400
function idParam(req) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, 'Invalid id');
  return id;
}

module.exports = { HttpError, asyncHandler, validate, idParam };
