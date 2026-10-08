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
const { page } = require('../utils/htmlPage');

const router = express.Router();
const LEGAL_DIR = path.join(__dirname, '..', '..', 'docs', 'legal');

function legalPage(file, title) {
  return asyncHandler(async (req, res) => {
    const md = await fs.readFile(path.join(LEGAL_DIR, file), 'utf8');
    res.type('html').set('Cache-Control', 'public, max-age=300').send(page(title, marked.parse(md)));
  });
}

router.get('/privacy', legalPage('privacy-policy.md', 'RaphAi Privacy Policy'));
router.get('/terms', legalPage('terms-and-conditions.md', 'RaphAi Terms & Conditions'));

module.exports = router;
