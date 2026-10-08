// routes/legal.js
// ------------------------------------------------------------
// Public legal pages (no login needed). Google Play needs a public
// Privacy Policy URL, and the app links to the Terms.
//   GET /privacy -> docs/legal/privacy-policy.md as a web page
//   GET /terms   -> docs/legal/terms-and-conditions.md as a web page
// The markdown files are read on every request, so new text can be
// dropped into docs/legal/ without changing any code.
// ------------------------------------------------------------

const fs = require('fs/promises');
const path = require('path');
const express = require('express');
const { marked } = require('marked');
const { asyncHandler } = require('../utils/http');

const router = express.Router();
const LEGAL_DIR = path.join(__dirname, '..', '..', 'docs', 'legal');

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Wrap the rendered markdown in a simple, readable, mobile-friendly dark page
function page(title, bodyHtml) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; background: #0f1115; color: #e6e8eb; font: 16px/1.65 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
  main { max-width: 760px; margin: 0 auto; padding: 32px 20px 64px; }
  h1, h2, h3 { color: #ffffff; line-height: 1.3; }
  h1 { font-size: 1.75rem; margin-top: 0; }
  a { color: #7cc4ff; }
  code { background: #1c2028; padding: 2px 5px; border-radius: 4px; }
  table { border-collapse: collapse; width: 100%; display: block; overflow-x: auto; }
  th, td { border: 1px solid #2a2f3a; padding: 6px 10px; text-align: left; }
  hr { border: 0; border-top: 1px solid #2a2f3a; margin: 2rem 0; }
  footer { margin-top: 48px; color: #8a919c; font-size: 0.85rem; }
</style>
</head>
<body>
<main>
${bodyHtml}
<footer>RaphAi &middot; <a href="/privacy">Privacy Policy</a> &middot; <a href="/terms">Terms &amp; Conditions</a></footer>
</main>
</body>
</html>`;
}

function legalPage(file, title) {
  return asyncHandler(async (req, res) => {
    const md = await fs.readFile(path.join(LEGAL_DIR, file), 'utf8');
    res.type('html').set('Cache-Control', 'public, max-age=300').send(page(title, marked.parse(md)));
  });
}

router.get('/privacy', legalPage('privacy-policy.md', 'RaphAi Privacy Policy'));
router.get('/terms', legalPage('terms-and-conditions.md', 'RaphAi Terms & Conditions'));

module.exports = router;
