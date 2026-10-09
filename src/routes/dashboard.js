// routes/dashboard.js
// ------------------------------------------------------------
// GET /api/dashboard?date=2026-10-07   (also GET /api/dashboard/streaks)
// One call that gives the home screen everything:
//   HeartScore (0–100) = average of Health score and Wealth score
//   Health score = average of calories, protein, water, steps, sleep scores (today)
//   Wealth score = average of savings rate, bills paid, budget adherence (this month)
// ------------------------------------------------------------

const express = require('express');
const db = require('../db');
const calc = require('../utils/calc');
const { validate, asyncHandler } = require('../utils/http');
const { today } = require('../utils/dates');
const summary = require('../services/summary');
const { currentPlan } = require('../middleware/requirePlan');
const { streaks } = require('../services/streaks');

const router = express.Router();

// Give the score a friendly label
function label(score) {
  if (score >= 80) return 'Excellent';
  if (score >= 60) return 'Good';
  if (score >= 40) return 'Okay';
  return 'Needs attention';
}

router.get('/', asyncHandler(async (req, res) => {
  const { date } = validate(req.query, { date: { type: 'date' } });
  const d = date || today();
  const [day, month, user, latestMood, plan, streakData] = await Promise.all([
    summary.healthDay(req.user.id, d),
    summary.wealthMonth(req.user.id, d.slice(0, 7)),
    db.get('SELECT name FROM users WHERE id = $1', [req.user.id]),
    db.get('SELECT mood, date FROM mood_logs WHERE user_id = $1 ORDER BY date DESC, id DESC LIMIT 1', [req.user.id]),
    currentPlan(req.user.id),
    streaks(req.user.id),
  ]);

  const health = summary.healthScore(day);
  const wealth = summary.wealthScore(month);
  const raphScore = calc.round((health.score + wealth.score) / 2);


  res.json({
    name: user.name,
    date: day.date,
    plan,
    raph_score: { score: raphScore, label: label(raphScore) },
    streaks: streakData,
    health: {
      score: health.score,
      parts: health.parts,
      calories: { eaten: day.eaten.kcal, target: day.targets && day.targets.calories, left: day.calories_left, burned_in_workouts: day.workout_kcal },
      protein_g: { eaten: day.eaten.protein_g, target: day.targets && day.targets.protein_g },
      water_ml: { drunk: day.water_ml, target: day.targets && day.targets.water_ml },
      steps: { count: day.steps, goal: day.step_goal },
      sleep_hours: day.sleep_hours,
      latest_mood: latestMood || null,
      profile_complete: Boolean(day.targets),
    },
    wealth: {
      score: wealth.score,
      parts: wealth.parts,
      month: month.month,
      income: month.income,
      spent: month.spent,
      savings_rate_pct: wealth.savings_rate_pct,
      top_categories: month.by_category.slice(0, 3),
      bills_paid: `${month.bills_paid_of_due}/${month.bills_due_so_far} due so far`,
    },
  });
}));

// GET /api/dashboard/streaks -> just the streaks
router.get('/streaks', asyncHandler(async (req, res) => {
  res.json({ streaks: await streaks(req.user.id) });
}));

module.exports = router;
