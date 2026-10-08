// routes/consents.js
// ------------------------------------------------------------
// Consent records (Privacy Policy section 5: "We keep a record of each
// consent (what, which version, yes/no, when)").
//   POST /api/consents  { type, version, granted }  -> saves one record
//   GET  /api/consents                              -> current choice per type + full history
// Every change is a NEW row, so the history proves what was agreed and when.
// Registration stores the first one (terms_privacy, TERMS_VERSION).
// ------------------------------------------------------------

const express = require('express');
const db = require('../db');
const { validate, asyncHandler, HttpError } = require('../utils/http');

// Version of the Terms + Privacy Policy accepted at sign-up
const TERMS_VERSION = '2026-10-08';
const CONSENT_TYPES = ['terms_privacy', 'health_connect', 'background_health', 'ads_personalised', 'gemini'];

const toApi = (r) => ({
  type: r.type,
  version: r.version,
  granted: r.granted,
  created_at: new Date(r.created_at).toISOString(),
});

const router = express.Router();

router.post('/', asyncHandler(async (req, res) => {
  const b = validate(req.body, {
    type: { type: 'string', required: true, oneOf: CONSENT_TYPES },
    version: { type: 'string', required: true, maxLength: 40 },
  });
  // granted must be a real true/false (not "yes", not missing)
  if (typeof (req.body || {}).granted !== 'boolean') throw new HttpError(400, 'Invalid input', ['granted must be true or false']);
  const row = await db.get('INSERT INTO consents (user_id, type, version, granted) VALUES ($1, $2, $3, $4) RETURNING *',
    [req.user.id, b.type, b.version, req.body.granted]);
  res.status(201).json({ consent: toApi(row) });
}));

router.get('/', asyncHandler(async (req, res) => {
  const rows = await db.all('SELECT * FROM consents WHERE user_id = $1 AND account_deleted_at IS NULL ORDER BY created_at, id', [req.user.id]);
  const current = {};
  for (const r of rows) current[r.type] = toApi(r); // later rows win
  res.json({ consents: current, history: rows.map(toApi), types: CONSENT_TYPES, terms_version: TERMS_VERSION });
}));

module.exports = { router, TERMS_VERSION, CONSENT_TYPES };
