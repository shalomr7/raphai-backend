// routes/activity.js
// ------------------------------------------------------------
// Daily activity sent by the phone (Health Connect or the pedometer):
//   POST /api/activity/daily  { date, steps, distance_m, active_kcal, active_minutes, resting_hr?, source }
//        Saves one row per user per day (sending again replaces it) and also
//        updates the step count used everywhere else (step_logs).
//   GET  /api/activity/daily?days=7   the last N days (newest first), as an array
// ------------------------------------------------------------

const express = require('express');
const db = require('../db');
const { validate, asyncHandler } = require('../utils/http');
const { today, addDays } = require('../utils/dates');

const router = express.Router();

const COLS = 'date, steps, distance_m, active_kcal, active_minutes, resting_hr, source';

router.post('/daily', asyncHandler(async (req, res) => {
  const b = validate(req.body, {
    date: { type: 'date' },
    steps: { type: 'integer', min: 0, max: 200000 },
    distance_m: { type: 'number', min: 0, max: 500000 },
    active_kcal: { type: 'number', min: 0, max: 20000 },
    active_minutes: { type: 'integer', min: 0, max: 1440 },
    resting_hr: { type: 'integer', min: 25, max: 220 },
    source: { type: 'string', oneOf: ['health_connect', 'pedometer', 'healthkit', 'manual'] },
  });
  const date = b.date || today();
  const row = await db.tx(async (t) => {
    const saved = await t.get(`
      INSERT INTO activity_daily (user_id, date, steps, distance_m, active_kcal, active_minutes, resting_hr, source)
      VALUES (@user_id, @date, @steps, @distance_m, @active_kcal, @active_minutes, @resting_hr, @source)
      ON CONFLICT (user_id, date) DO UPDATE SET
        steps = COALESCE(excluded.steps, activity_daily.steps),
        distance_m = COALESCE(excluded.distance_m, activity_daily.distance_m),
        active_kcal = COALESCE(excluded.active_kcal, activity_daily.active_kcal),
        active_minutes = COALESCE(excluded.active_minutes, activity_daily.active_minutes),
        resting_hr = COALESCE(excluded.resting_hr, activity_daily.resting_hr),
        source = COALESCE(excluded.source, activity_daily.source),
        updated_at = to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
      RETURNING ${COLS}`, {
      user_id: req.user.id, date, steps: b.steps ?? null, distance_m: b.distance_m ?? null, active_kcal: b.active_kcal ?? null,
      active_minutes: b.active_minutes ?? null, resting_hr: b.resting_hr ?? null, source: b.source ?? null,
    });
    if (b.steps != null) {
      await t.run(`INSERT INTO step_logs (user_id, date, steps) VALUES ($1, $2, $3)
                   ON CONFLICT (user_id, date) DO UPDATE SET steps = excluded.steps`, [req.user.id, date, b.steps]);
    }
    return saved;
  });
  res.json(row);
}));

router.get('/daily', asyncHandler(async (req, res) => {
  const { days } = validate(req.query, { days: { type: 'integer', min: 1, max: 90 } });
  const end = today();
  const rows = await db.all(`SELECT ${COLS} FROM activity_daily WHERE user_id = $1 AND date > $2 AND date <= $3 ORDER BY date DESC`,
    [req.user.id, addDays(end, -(days || 7)), end]);
  res.json(rows);
}));

module.exports = router;
