// routes/body.js — Adaptive Body Goals
//   GET /api/body/forecast   weekly weight forecast (range), coverage, track record
//   GET /api/body/progress   actual weigh-ins + smoothed trend + saved predictions
// Weigh-ins themselves are added/edited/deleted at /api/health/weight.
// All numbers come from services/bodyEngine.js (deterministic, no AI).
const express = require('express');
const { asyncHandler } = require('../utils/http');
const bodyGoals = require('../services/bodyGoals');

const router = express.Router();

router.get('/forecast', asyncHandler(async (req, res) => {
  res.json(await bodyGoals.forecast(req.user.id));
}));

router.get('/progress', asyncHandler(async (req, res) => {
  res.json(await bodyGoals.progress(req.user.id));
}));

module.exports = router;
