// routes/food.js
// ------------------------------------------------------------
// POST /api/food/parse   { "text": "I ate 2 eggs, 2 rotis and a glass of milk" }
// Reads a sentence and finds each food in our foods table (fuzzy match),
// with the amount turned into servings and nutrition scaled.
// The app then logs each matched item with POST /api/food-logs
// ({ food_id, servings, meal }).
// Free plan: 5 parses a day. Pro and Elite: unlimited.
// ------------------------------------------------------------

const express = require('express');
const db = require('../db');
const { validate, asyncHandler, HttpError } = require('../utils/http');
const { today } = require('../utils/dates');
const { hasPlan } = require('../middleware/requirePlan');
const { FREE_LIMITS } = require('../utils/plans');
const { parseText } = require('../services/foodParser');

const router = express.Router();
const FEATURE = 'food_parse';

router.post('/parse', asyncHandler(async (req, res) => {
  const { text } = validate(req.body, { text: { type: 'string', required: true, maxLength: 500 } });
  const userId = req.user.id;
  const pro = await hasPlan(userId, 'pro');
  const limit = pro ? null : FREE_LIMITS.food_parse_per_day;
  const day = today();

  let used;
  if (pro) {
    used = null;
  } else {
    // Count this use, but only if still under the limit (one atomic statement)
    const row = await db.get(`
      INSERT INTO feature_usage (user_id, date, feature, count) VALUES ($1, $2, $3, 1)
      ON CONFLICT (user_id, date, feature) DO UPDATE SET count = feature_usage.count + 1
        WHERE feature_usage.count < $4
      RETURNING count`, [userId, day, FEATURE, limit]);
    if (!row) {
      throw new HttpError(402, `You've used your ${limit} free food parses today. Upgrade to Pro for unlimited parsing, or search and log foods by hand.`);
    }
    used = row.count;
  }

  // Seeded (verified) foods plus the user's own foods
  const foods = await db.all('SELECT id, name, serving, kcal, protein_g, carbs_g, fat_g, verified FROM foods WHERE verified = 1 OR created_by = $1 ORDER BY id', [userId]);
  const result = parseText(text, foods);
  res.json({ ...result, usage: { used, limit, remaining: limit == null ? null : Math.max(0, limit - used) } });
}));

module.exports = router;
