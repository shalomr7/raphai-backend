// services/bodyGoals.js — loads a user's ACTUAL records and runs the
// deterministic engine (services/bodyEngine.js). Saves one forecast per day
// (recomputed in place, idempotent) and fills in prediction errors once later
// weigh-ins exist.
const db = require('../db');
const engine = require('./bodyEngine');
const { today: todayIST, addDays } = require('../utils/dates');

async function loadInputs(userId, today) {
  const from = addDays(today, -35);
  const [profile, weights, food, steps, workouts] = await Promise.all([
    db.get('SELECT sex, age, height_cm, weight_kg, goal, pace_kg_week, target_weight_kg, body_fat_pct FROM profiles WHERE user_id = $1', [userId]),
    db.all('SELECT date, weight_kg FROM weight_logs WHERE user_id = $1 AND date >= $2 ORDER BY date, id', [userId, addDays(today, -120)]),
    db.all(`SELECT l.date, COUNT(DISTINCT l.meal)::int AS meal_types,
                   COALESCE(SUM(COALESCE(f.kcal, l.custom_kcal, 0) * l.servings), 0)::float AS intake_kcal,
                   COUNT(*) FILTER (WHERE l.is_estimate)::int AS estimated_items, COUNT(*)::int AS items
              FROM food_logs l LEFT JOIN foods f ON f.id = l.food_id
             WHERE l.user_id = $1 AND l.date >= $2 AND l.date <= $3 GROUP BY l.date`, [userId, from, today]),
    // One authoritative step total per day: activity_daily (already reconciled,
    // max of sources), falling back to the older step_logs table. Never summed.
    db.all(`SELECT COALESCE(a.date, s.date) AS date, COALESCE(a.steps, s.steps) AS steps
              FROM (SELECT date, steps FROM activity_daily WHERE user_id = $1 AND date >= $2) a
              FULL OUTER JOIN (SELECT date, steps FROM step_logs WHERE user_id = $1 AND date >= $2) s ON s.date = a.date`, [userId, from]),
    db.all('SELECT date, activity, minutes, met, weight_kg FROM workouts WHERE user_id = $1 AND date >= $2 ORDER BY date, id', [userId, from]),
  ]);
  const days = new Map();
  const get = (d) => { if (!days.has(d)) days.set(d, { date: d, intake_kcal: 0, meal_types: 0, steps: null, workouts: [] }); return days.get(d); };
  for (const f of food) Object.assign(get(f.date), { intake_kcal: Number(f.intake_kcal), meal_types: f.meal_types, estimated_items: f.estimated_items, items: f.items });
  for (const s of steps) if (s.steps != null) get(s.date).steps = Number(s.steps);
  for (const w of workouts) get(w.date).workouts.push(w);
  return { profile, weights, days: [...days.values()].sort((a, b) => (a.date < b.date ? -1 : 1)) };
}

async function saveForecast(userId, f) {
  if (f.status !== 'ok') return;
  await db.run(`
    INSERT INTO weight_forecasts (user_id, made_on, horizon_end, model_version, method, start_weight_kg, low_kg, mid_kg, high_kg, inputs, coverage)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
    ON CONFLICT (user_id, made_on, model_version) DO UPDATE SET
      horizon_end = excluded.horizon_end, method = excluded.method, start_weight_kg = excluded.start_weight_kg,
      low_kg = excluded.low_kg, mid_kg = excluded.mid_kg, high_kg = excluded.high_kg,
      inputs = excluded.inputs, coverage = excluded.coverage, updated_at = now()`,
  [userId, f.made_on, f.horizon_end, f.model_version, f.method, f.start_weight_kg, f.change_kg.low, f.change_kg.mid, f.change_kg.high,
    JSON.stringify(f.inputs), JSON.stringify(f.coverage)]);
}

/** Past forecasts vs what the trend actually did; saves the errors. */
async function evaluate(userId, weights, today) {
  const rows = await db.all(`SELECT made_on, horizon_end, start_weight_kg, low_kg AS low, mid_kg AS mid, high_kg AS high
                               FROM weight_forecasts WHERE user_id = $1 AND horizon_end <= $2 ORDER BY made_on DESC LIMIT 60`, [userId, today]);
  // Only one forecast per week counts (the first of each 7-day block), so
  // daily recomputes don't inflate the sample.
  const picked = []; let lastMade = null;
  for (const r of [...rows].reverse()) {
    if (!lastMade || r.made_on >= addDays(lastMade, 7)) { picked.push(r); lastMade = r.made_on; }
  }
  const ev = engine.evaluateForecasts(picked, weights, today);
  for (const e of ev.evaluated) {
    await db.run(`UPDATE weight_forecasts SET actual_change_kg = $1, error_kg = $2, evaluated_at = now()
                   WHERE user_id = $3 AND made_on = $4 AND model_version = $5 AND (error_kg IS DISTINCT FROM $2)`,
    [e.actual_change_kg, e.error_kg, userId, e.made_on, engine.MODEL_VERSION]);
  }
  return ev;
}

async function forecast(userId, { save = true } = {}) {
  const today = todayIST();
  const input = await loadInputs(userId, today);
  const f = engine.weeklyForecast({ today, ...input });
  if (save) await saveForecast(userId, f);
  const ev = await evaluate(userId, input.weights, today);
  const todayRow = input.days.find((d) => d.date === today);
  return {
    ...f,
    goal: input.profile ? { goal: input.profile.goal, target_weight_kg: input.profile.target_weight_kg } : null,
    today_logged: todayRow ? { meal_types: todayRow.meal_types, intake_kcal: Math.round(todayRow.intake_kcal) } : { meal_types: 0, intake_kcal: 0 },
    track_record: ev.summary,
    past: ev.evaluated.slice(-6),
  };
}

async function progress(userId) {
  const today = todayIST();
  const [profile, weights, forecasts] = await Promise.all([
    db.get('SELECT goal, target_weight_kg FROM profiles WHERE user_id = $1', [userId]),
    db.all('SELECT id, date, weight_kg, measured_at, waist_cm FROM weight_logs WHERE user_id = $1 ORDER BY date, id', [userId]),
    db.all(`SELECT made_on, horizon_end, start_weight_kg, low_kg, mid_kg, high_kg, actual_change_kg FROM weight_forecasts
             WHERE user_id = $1 AND made_on >= $2 ORDER BY made_on`, [userId, addDays(today, -90)]),
  ]);
  const p = engine.progress(profile, weights, today);
  return { ...p, goal: profile ? profile.goal : null, measurements: weights.slice(-60).reverse(), predictions: forecasts };
}

module.exports = { forecast, progress, loadInputs };
