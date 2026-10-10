// routes/export.js
// ------------------------------------------------------------
// GET /api/export  -> ALL of your data as one JSON file.
// Your data is yours: you can take it with you any time.
// (We never include the password hash.)
// ------------------------------------------------------------

const express = require('express');
const { buildExport } = require('../services/exportData');
const { asyncHandler } = require('../utils/http');
const { logSecurity } = require('../services/securityLog');

const router = express.Router();

router.get('/', asyncHandler(async (req, res) => {
  const userId = req.user.id;
  const data = await buildExport(userId);
  await logSecurity('export', { req, userId });
  res.setHeader('Content-Disposition', `attachment; filename="heartpurse-export-${userId}.json"`);
  res.json(data);
}));

module.exports = router;
