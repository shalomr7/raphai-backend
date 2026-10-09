// middleware/errors.js
// ------------------------------------------------------------
// notFound: any URL we don't know -> 404
// errorHandler: every error ends up here and becomes clean JSON like
//   { "error": "Invalid input", "details": ["amount is required"] }
// ------------------------------------------------------------

function notFound(req, res) {
  // req.path (not originalUrl) so a ?secret=... is never echoed back
  res.status(404).json({ error: `Not found: ${req.method} ${req.path}` });
}

const EMAIL_RE = /[^\s@'"]+@[^\s@'"]+\.[^\s@'"]+/g;
function safeErrorLine(err, req) {
  const msg = String((err && err.message) || err).replace(EMAIL_RE, '<email>').slice(0, 300);
  const stack = String((err && err.stack) || '').split('\n').slice(1, 6).map((l) => l.trim()).join(' | ');
  return JSON.stringify({
    level: 'error',
    route: `${req.method} ${req.baseUrl || ''}${(req.route && req.route.path) || req.path}`,
    name: err && err.name,
    code: err && err.code,
    message: msg,
    stack,
  });
}

// Express knows this is an error handler because it has 4 arguments
// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  // Bad JSON sent by the app
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Body is not valid JSON' });
  }

  const status = err.status || err.statusCode || 500;

  // Log real crashes so you can fix them; don't show internals to users.
  // Never log the request body, headers or Postgres "detail" (which can
  // contain emails or other values): only what is needed to find the bug.
  if (status >= 500 && !err.expose) console.error(safeErrorLine(err, req));
  if (err.retryAfter) res.set('Retry-After', String(err.retryAfter));

  res.status(status).json({
    error: status >= 500 && !err.expose ? 'Something went wrong on the server' : err.message,
    ...(err.details ? { details: err.details } : {}),
    // extra fields for the app, e.g. { upgrade_to: 'plus', limit: 5 } on a 402
    ...(err.extra && typeof err.extra === 'object' ? err.extra : {}),
  });
}

module.exports = { notFound, errorHandler, safeErrorLine };
