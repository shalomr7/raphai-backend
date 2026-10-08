// routes/insights.js
// ------------------------------------------------------------
// RaphAi Intelligence (rule-based, uses the user's own data):
//   GET /api/insights/today            Free + Pro: RaphScore (6 areas + why it changed),
//                                      top 3 priorities, one insight, nutrition safety,
//                                      hydration advice (Indian time of day), budget left
//   GET /api/insights/trends?days=7    days = 7, 30, 90 or 365. Longest window per plan:
//                                      Free 7, Plus 30, Pro/Elite 365 (longer -> 402)
//   GET /api/insights/patterns         Plus and up ("Life patterns"). Free gets { locked: true }
//   GET /api/insights/brief            Plus and up daily briefing. Free gets { locked: true }
//   GET /api/insights/profile          Pro and up "Your patterns" (full Life Graph). Lower gets { locked: true }
// Missing data is never shown as 0: it is null with a "Start tracking" note.
// ------------------------------------------------------------

const express = require('express');
const { validate, asyncHandler } = require('../utils/http');
const { hasPlan, planAndLimits, upgradeError } = require('../middleware/requirePlan');
const { PLANS, PLAN_ORDER, LIMITS, FEATURE_TIERS } = require('../utils/plans');
const intelligence = require('../services/intelligence');

const router = express.Router();

const locked = (feature, planNeeded) => ({
  locked: true, feature, plan_needed: planNeeded, message: `${feature} is part of RaphAi ${PLANS[planNeeded].name}.`,
});

router.get('/today', asyncHandler(async (req, res) => {
  res.json(await intelligence.todayInsights(req.user.id));
}));

router.get('/trends', asyncHandler(async (req, res) => {
  const { days } = validate(req.query, { days: { type: 'integer', oneOf: [7, 30, 90, 365] } });
  const want = days || 7;
  const { plan, limits } = await planAndLimits(req.user.id);
  if (want > limits.trend_days) {
    const needed = PLAN_ORDER.find((p) => LIMITS[p].trend_days >= want);
    throw upgradeError(`${want}-day trends need the ${PLANS[needed].name} plan or higher. You are on ${PLANS[plan].name} (${limits.trend_days} days).`,
      { plan, upgradeTo: needed, limit: limits.trend_days });
  }
  const t = await intelligence.trends(req.user.id, want);
  delete t.insight_areas;
  res.json(t);
}));

router.get('/patterns', asyncHandler(async (req, res) => {
  if (!(await hasPlan(req.user.id, FEATURE_TIERS.life_patterns))) return res.json(locked('Life patterns', FEATURE_TIERS.life_patterns));
  res.json(await intelligence.patterns(req.user.id));
}));

router.get('/brief', asyncHandler(async (req, res) => {
  if (!(await hasPlan(req.user.id, FEATURE_TIERS.daily_brief))) return res.json(locked('Daily brief', FEATURE_TIERS.daily_brief));
  res.json(await intelligence.brief(req.user.id));
}));

router.get('/profile', asyncHandler(async (req, res) => {
  if (!(await hasPlan(req.user.id, FEATURE_TIERS.pattern_profile))) return res.json(locked('Your patterns', FEATURE_TIERS.pattern_profile));
  res.json(await intelligence.userProfile(req.user.id));
}));

module.exports = router;
