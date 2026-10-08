// routes/health.js
// ------------------------------------------------------------
// Everything under /api/health :
//   GET  /targets                  calories, macros, water, BMI, body fat
//   GET  /today?date=              one-day summary + health score
//   PUT  /steps                    save today's step count (from the phone)
//   GET  /steps?from=&to=          step history
//   GET  /workouts/met-table       list of activities and their MET
//   POST/GET/DELETE /workouts      workouts (calories = MET × kg × hours)
//   POST/GET/PUT/DELETE /water, /sleep, /mood, /weight   simple logs
//   GET/PUT /reminders             sitting-reminder settings
// ------------------------------------------------------------

const express = require('express');
const db = require('../db');
const calc = require('../utils/calc');
const { validate, idParam, HttpError, asyncHandler } = require('../utils/http');
const { today } = require('../utils/dates');
const summary = require('../services/summary');
const { hasPlan } = require('../middleware/requirePlan');

const router = express.Router();

// Reusable rules for ?from=YYYY-MM-DD&to=YYYY-MM-DD
const RANGE_RULES = { from: { type: 'date' }, to: { type: 'date' }, date: { type: 'date' } };

// Build a "WHERE date ..." filter from the query string
function dateFilter(query) {
  const q = validate(query, RANGE_RULES);
  if (q.date) return { sql: ' AND date = @date', params: { date: q.date } };
  return {
    sql: ' AND date >= @from AND date <= @to',
    params: { from: q.from || '0000-01-01', to: q.to || '9999-12-31' },
  };
}

// ---------------- TARGETS ----------------
router.get('/targets', asyncHandler(async (req, res) => {
  const p = await db.get('SELECT * FROM profiles WHERE user_id = $1', [req.user.id]);
  if (!summary.profileIsComplete(p)) {
    throw new HttpError(400, 'Please fill your profile first (sex, age, height_cm, weight_kg) using PUT /api/profile');
  }
  const targets = calc.dailyTargets(p);
  // Body fat % is a Pro feature. Free users get null + body_fat_locked: true.
  const bodyFatLocked = !(await hasPlan(req.user.id, 'pro'));
  const bodyFat = bodyFatLocked ? null : calc.navyBodyFat(p);
  res.json({
    profile_used: {
      sex: p.sex, age: p.age, height_cm: p.height_cm, weight_kg: p.weight_kg,
      activity_factor: p.activity_factor, goal: p.goal, pace_kg_week: p.pace_kg_week,
    },
    ...targets,
    bmi: calc.bmi(p.weight_kg, p.height_cm),
    body_fat_pct: bodyFat,
    body_fat_locked: bodyFatLocked,
    body_fat_note: bodyFatLocked
      ? 'Body fat % is part of Pro.'
      : bodyFat == null
      ? 'Add neck_cm and waist_cm (and hip_cm for women) to your profile to get body fat % (US Navy method).'
      : 'US Navy tape-measure estimate. Usually within 3–4% of a lab test.',
  });
}));

// ---------------- TODAY ----------------
router.get('/today', asyncHandler(async (req, res) => {
  const { date } = validate(req.query, { date: { type: 'date' } });
  const day = await summary.healthDay(req.user.id, date || today());
  res.json({ ...day, health_score: summary.healthScore(day) });
}));

// ---------------- STEPS ----------------
// The phone counts steps and sends the TOTAL for the day. Sending again
// for the same date replaces the old number (an "upsert").
router.put('/steps', asyncHandler(async (req, res) => {
  const body = validate(req.body, {
    steps: { type: 'integer', required: true, min: 0, max: 200000 },
    date: { type: 'date' },
  });
  const date = body.date || today();
  await db.run(`
    INSERT INTO step_logs (user_id, date, steps) VALUES ($1, $2, $3)
    ON CONFLICT (user_id, date) DO UPDATE SET steps = excluded.steps
  `, [req.user.id, date, body.steps]);
  res.json({ date, steps: body.steps });
}));

router.get('/steps', asyncHandler(async (req, res) => {
  const f = dateFilter(req.query);
  const rows = await db.all(`SELECT date, steps FROM step_logs WHERE user_id = @user_id${f.sql} ORDER BY date DESC`,
    { user_id: req.user.id, ...f.params });
  res.json({ steps: rows });
}));

// ---------------- WORKOUTS ----------------
router.get('/workouts/met-table', (req, res) => {
  res.json({ met_table: calc.MET_TABLE, formula: 'kcal = MET × weight_kg × hours' });
});

router.post('/workouts', asyncHandler(async (req, res) => {
  const body = validate(req.body, {
    activity: { type: 'string', required: true, maxLength: 60 },
    minutes: { type: 'number', required: true, min: 1, max: 600 },
    met: { type: 'number', min: 1, max: 25 }, // optional: give your own MET
    date: { type: 'date' },
  });
  // Use the MET from the table, or the one the app sent
  const met = body.met || calc.MET_TABLE[body.activity];
  if (!met) {
    throw new HttpError(400, `Unknown activity "${body.activity}". Use one from GET /api/health/workouts/met-table or send "met".`);
  }
  const p = await db.get('SELECT weight_kg FROM profiles WHERE user_id = $1', [req.user.id]);
  if (!p || !p.weight_kg) throw new HttpError(400, 'Please set weight_kg in your profile first');

  const kcal = calc.workoutCalories(met, p.weight_kg, body.minutes);
  const workout = await db.get(`
    INSERT INTO workouts (user_id, date, activity, minutes, met, weight_kg, kcal) VALUES ($1, $2, $3, $4, $5, $6, $7)
    RETURNING *
  `, [req.user.id, body.date || today(), body.activity, body.minutes, met, p.weight_kg, kcal]);
  res.status(201).json({ workout });
}));

router.get('/workouts', asyncHandler(async (req, res) => {
  const f = dateFilter(req.query);
  const rows = await db.all(`SELECT * FROM workouts WHERE user_id = @user_id${f.sql} ORDER BY date DESC, id DESC`,
    { user_id: req.user.id, ...f.params });
  res.json({ workouts: rows, total_kcal: calc.round(rows.reduce((s, w) => s + w.kcal, 0)) });
}));

router.delete('/workouts/:id', asyncHandler(async (req, res) => {
  const info = await db.run('DELETE FROM workouts WHERE id = $1 AND user_id = $2', [idParam(req), req.user.id]);
  if (!info.changes) throw new HttpError(404, 'Workout not found');
  res.json({ deleted: true });
}));

// ---------------- SIMPLE LOGS (water, sleep, mood, weight) ----------------
// These 4 logs all work the same way, so one function makes the routes.
//   path:   '/water'
//   table:  'water_logs'
//   rules:  what fields the app may send
//   afterCreate: optional extra work after saving (used by weight)
function simpleLog(path, table, rules, afterCreate) {
  const allRules = { ...rules, date: { type: 'date' } };
  const columns = Object.keys(allRules);

  // Create
  router.post(path, asyncHandler(async (req, res) => {
    const body = validate(req.body, allRules);
    body.date = body.date || today();
    const cols = Object.keys(body);
    const entry = await db.get(`INSERT INTO ${table} (user_id, ${cols.join(', ')}) VALUES (@user_id, ${cols.map((c) => '@' + c).join(', ')}) RETURNING *`,
      { ...body, user_id: req.user.id });
    if (afterCreate) await afterCreate(req.user.id, body);
    res.status(201).json({ entry });
  }));

  // List (optionally ?date= or ?from=&to=)
  router.get(path, asyncHandler(async (req, res) => {
    const f = dateFilter(req.query);
    const rows = await db.all(`SELECT * FROM ${table} WHERE user_id = @user_id${f.sql} ORDER BY date DESC, id DESC`,
      { user_id: req.user.id, ...f.params });
    res.json({ entries: rows });
  }));

  // Update
  router.put(`${path}/:id`, asyncHandler(async (req, res) => {
    const id = idParam(req);
    const changes = validate(req.body, allRules, { partial: true });
    const cols = Object.keys(changes).filter((c) => columns.includes(c));
    if (cols.length) {
      const info = await db.run(`UPDATE ${table} SET ${cols.map((c) => `${c} = @${c}`).join(', ')} WHERE id = @id AND user_id = @user_id`,
        { ...changes, id, user_id: req.user.id });
      if (!info.changes) throw new HttpError(404, 'Entry not found');
    }
    const row = await db.get(`SELECT * FROM ${table} WHERE id = $1 AND user_id = $2`, [id, req.user.id]);
    if (!row) throw new HttpError(404, 'Entry not found');
    res.json({ entry: row });
  }));

  // Delete
  router.delete(`${path}/:id`, asyncHandler(async (req, res) => {
    const info = await db.run(`DELETE FROM ${table} WHERE id = $1 AND user_id = $2`, [idParam(req), req.user.id]);
    if (!info.changes) throw new HttpError(404, 'Entry not found');
    res.json({ deleted: true });
  }));
}

simpleLog('/water', 'water_logs', { ml: { type: 'number', required: true, min: 10, max: 5000 } });
simpleLog('/sleep', 'sleep_logs', {
  hours: { type: 'number', required: true, min: 0, max: 24 },
  quality: { type: 'integer', min: 1, max: 5 },
});
simpleLog('/mood', 'mood_logs', {
  mood: { type: 'integer', required: true, min: 1, max: 5 },
  note: { type: 'string', maxLength: 300 },
});
// When a new weight is logged, also update the profile so targets stay correct
simpleLog('/weight', 'weight_logs', { weight_kg: { type: 'number', required: true, min: 25, max: 300 } }, async (userId, body) => {
  await db.run('UPDATE profiles SET weight_kg = $1 WHERE user_id = $2', [body.weight_kg, userId]);
});

// ---------------- SITTING REMINDERS ----------------
// The server only STORES the settings. The phone app reads them and
// schedules the actual notifications (see README "How the phone app connects").
router.get('/reminders', asyncHandler(async (req, res) => {
  const row = await db.get('SELECT * FROM reminder_settings WHERE user_id = $1', [req.user.id]);
  res.json({ reminders: { ...row, enabled: Boolean(row.enabled) } });
}));

router.put('/reminders', asyncHandler(async (req, res) => {
  const changes = validate(req.body, {
    enabled: { type: 'boolean' },
    interval_min: { type: 'integer', min: 15, max: 240 },
    start_hour: { type: 'integer', min: 0, max: 23 },
    end_hour: { type: 'integer', min: 1, max: 24 },
  }, { partial: true });
  if (changes.enabled !== undefined) changes.enabled = changes.enabled ? 1 : 0;
  const cols = Object.keys(changes);
  if (cols.length) {
    await db.run(`UPDATE reminder_settings SET ${cols.map((c) => `${c} = @${c}`).join(', ')} WHERE user_id = @user_id`,
      { ...changes, user_id: req.user.id });
  }
  const row = await db.get('SELECT * FROM reminder_settings WHERE user_id = $1', [req.user.id]);
  res.json({ reminders: { ...row, enabled: Boolean(row.enabled) } });
}));

module.exports = router;
