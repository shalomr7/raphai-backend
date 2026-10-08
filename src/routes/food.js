// routes/food.js
// ------------------------------------------------------------
// POST /api/food/parse   { "text": "I ate 2 eggs, 2 rotis and a glass of milk" }
// Reads a sentence and finds each food in our foods table (fuzzy match),
// with the amount turned into servings and nutrition scaled.
// The app then logs each matched item with POST /api/food-logs
// ({ food_id, servings, meal }).
// Daily limit per plan (utils/plans.js LIMITS.food_parse_per_day):
// Free 5, Plus 20, Pro 50, Elite 100. Over the limit -> 402 with upgrade_to.
// ------------------------------------------------------------

const express = require('express');
const db = require('../db');
const { validate, asyncHandler } = require('../utils/http');
const { today } = require('../utils/dates');
const { planAndLimits, upgradeError } = require('../middleware/requirePlan');
const { PLANS, nextPlanWithMore, LIMITS } = require('../utils/plans');
const { parseText } = require('../services/foodParser');

const router = express.Router();
const FEATURE = 'food_parse';

router.post('/parse', asyncHandler(async (req, res) => {
  const { text } = validate(req.body, { text: { type: 'string', required: true, maxLength: 500 } });
  const userId = req.user.id;
  const { plan, limits } = await planAndLimits(userId);
  const limit = limits.food_parse_per_day; // null = no limit
  const day = today();

  let used = null;
  if (limit != null) {
    // Count this use, but only if still under the limit (one atomic statement)
    const row = await db.get(`
      INSERT INTO feature_usage (user_id, date, feature, count) VALUES ($1, $2, $3, 1)
      ON CONFLICT (user_id, date, feature) DO UPDATE SET count = feature_usage.count + 1
        WHERE feature_usage.count < $4
      RETURNING count`, [userId, day, FEATURE, limit]);
    if (!row) {
      const up = nextPlanWithMore(plan, 'food_parse_per_day');
      const msg = up
        ? `You've used your ${limit} food parses for today on ${PLANS[plan].name}. ${PLANS[up].name} gives you ${LIMITS[up].food_parse_per_day} a day. You can still search and log foods by hand.`
        : `You've used your ${limit} food parses for today. They reset tomorrow; you can still search and log foods by hand.`;
      throw upgradeError(msg, { plan, upgradeTo: up, limit });
    }
    used = row.count;
  }

  // Seeded (verified) foods plus the user's own foods
  const foods = await db.all('SELECT id, name, serving, kcal, protein_g, carbs_g, fat_g, verified FROM foods WHERE verified = 1 OR created_by = $1 ORDER BY id', [userId]);
  const result = parseText(text, foods);
  res.json({ ...result, usage: { plan, used, limit, remaining: limit == null ? null : Math.max(0, limit - used) } });
}));

module.exports = router;
