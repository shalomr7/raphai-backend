// routes/adminPage.js
// ------------------------------------------------------------
// GET /admin          the owner dashboard (login screen first; no data in the HTML)
// GET /admin/app.css  its styles
// GET /admin/app.js   its script (all data comes from /api/admin/*)
// Only these routes get a CSP that allows a same-origin script and
// stylesheet; every other page keeps the strict default (no scripts).
// noindex everywhere, never cached.
// ------------------------------------------------------------

const express = require('express');
const { HTML, CSS, JS } = require('../admin/page');

const router = express.Router();

const ADMIN_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
].join('; ');

router.use((req, res, next) => {
  res.set('Content-Security-Policy', ADMIN_CSP);
  res.set('X-Robots-Tag', 'noindex, nofollow, noarchive');
  res.set('Cache-Control', 'no-store');
  next();
});

router.get('/', (req, res) => res.type('html').send(HTML));
router.get('/app.css', (req, res) => res.type('text/css').send(CSS));
router.get('/app.js', (req, res) => res.type('application/javascript').send(JS));

module.exports = router;
module.exports.ADMIN_CSP = ADMIN_CSP;
