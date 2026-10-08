// routes/insights.js
// ------------------------------------------------------------
// RaphAi Intelligence (rule-based, uses the user's own data):
//   GET /api/insights/today            Free + Pro: RaphScore (6 areas + why it changed),
//                                      top 3 priorities, one insight, nutrition safety,
//                                      hydration advice (Indian time of day), budget left
//   GET /api/insights/trends?days=7    Free: 7 days. Pro: 7 or 30 (30 on Free -> 402)
//   GET /api/insights/patterns         Pro ("Life Graph"). Free gets { locked: true }
//   GET /api/insights/brief            Pro daily briefing. Free gets { locked: true }
//   GET /api/insights/profile          Pro "Your patterns". Free gets { locked: true }
// Missing data is never shown as 0: it is null with a "Start tracking" note.
// ------------------------------------------------------------

const express = require('express');
const { validate, asyncHandler, HttpError } = require('../utils/http');
const { hasPlan } = require('../middleware/requirePlan');
const intelligence = require('../services/intelligence');

const router = express.Router();

const locked = (feature) => ({ locked: true, feature, plan_needed: 'pro', message: `${feature} is part of RaphAi Pro.` });

router.get('/today', asyncHandler(async (req, res) => {
  res.json(await intelligence.todayInsights(req.user.id));
}));

router.get('/trends', asyncHandler(async (req, res) => {
  const { days } = validate(req.query, { days: { type: 'integer', oneOf: [7, 30] } });
  const want = days || 7;
  if (want === 30 && !(await hasPlan(req.user.id, 'pro'))) {
    throw new HttpError(402, '30-day trends need the Pro plan or higher. You are on Free (7 days).');
  }
  const t = await intelligence.trends(req.user.id, want);
  delete t.insight_areas;
  res.json(t);
}));

router.get('/patterns', asyncHandler(async (req, res) => {
  if (!(await hasPlan(req.user.id, 'pro'))) return res.json(locked('Life patterns'));
  res.json(await intelligence.patterns(req.user.id));
}));

router.get('/brief', asyncHandler(async (req, res) => {
  if (!(await hasPlan(req.user.id, 'pro'))) return res.json(locked('Daily brief'));
  res.json(await intelligence.brief(req.user.id));
}));

router.get('/profile', asyncHandler(async (req, res) => {
  if (!(await hasPlan(req.user.id, 'pro'))) return res.json(locked('Your patterns'));
  res.json(await intelligence.userProfile(req.user.id));
}));

module.exports = router;
