// middleware/errors.js
// ------------------------------------------------------------
// notFound: any URL we don't know -> 404
// errorHandler: every error ends up here and becomes clean JSON like
//   { "error": "Invalid input", "details": ["amount is required"] }
// ------------------------------------------------------------

function notFound(req, res) {
  res.status(404).json({ error: `Not found: ${req.method} ${req.originalUrl}` });
}

// Express knows this is an error handler because it has 4 arguments
// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  // Bad JSON sent by the app
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Body is not valid JSON' });
  }

  const status = err.status || 500;

  // Log real crashes so you can fix them; don't show internals to users
  if (status >= 500 && !err.expose) console.error(err);

  res.status(status).json({
    error: status >= 500 && !err.expose ? 'Something went wrong on the server' : err.message,
    ...(err.details ? { details: err.details } : {}),
    // extra fields for the app, e.g. { upgrade_to: 'plus', limit: 5 } on a 402
    ...(err.extra && typeof err.extra === 'object' ? err.extra : {}),
  });
}

module.exports = { notFound, errorHandler };
