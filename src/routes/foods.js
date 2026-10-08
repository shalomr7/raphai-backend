// routes/foods.js
// ------------------------------------------------------------
// Food library:
//   GET  /api/foods?q=dal        search foods by name. Your favourites come
//                                first, then foods you ate recently, then A–Z.
//                                Each food has verified, is_favourite, last_used.
//   GET  /api/foods/recent       foods you logged most recently
//   GET  /api/foods/favourites   your starred foods
//   POST /api/foods/:id/favourite    star a food
//   DELETE /api/foods/:id/favourite  un-star a food
//   GET  /api/foods/:id          one food
//   POST /api/foods              add your own food
// Food log (what you ate):
//   POST   /api/food-logs        { food_id, meal, servings, date }
//   GET    /api/food-logs?date=  that day's log grouped by meal + totals
//   PUT    /api/food-logs/:id    change servings / meal / date
//   DELETE /api/food-logs/:id
//   POST   /api/food-logs/repeat { meal, from_date?, to_date? }
//          copy a meal from one day to another (default: yesterday -> today)
// ------------------------------------------------------------

const express = require('express');
const db = require('../db');
const { validate, idParam, HttpError, asyncHandler } = require('../utils/http');
const { today } = require('../utils/dates');

// The day before a 'YYYY-MM-DD' date
function dayBefore(date) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}
const calc = require('../utils/calc');
const summary = require('../services/summary');

const MEALS = ['breakfast', 'lunch', 'dinner', 'snack'];

// ---------------- FOOD LIBRARY ----------------
const foodsRouter = express.Router();

// Foods plus "is it my favourite?" and "when did I last eat it?" for one user.
// Sorting: favourites first, then most recently eaten, then by name.
const FOOD_SELECT = `
  SELECT f.*,
         (fav.food_id IS NOT NULL)::int AS is_favourite,
         rec.last_used
  FROM foods f
  LEFT JOIN food_favourites fav ON fav.food_id = f.id AND fav.user_id = @user_id
  LEFT JOIN (SELECT food_id, MAX(created_at) AS last_used FROM food_logs
             WHERE user_id = @user_id GROUP BY food_id) rec ON rec.food_id = f.id
`;
const FOOD_ORDER = ' ORDER BY is_favourite DESC, (rec.last_used IS NULL), rec.last_used DESC, f.name';

// Turn 0/1 into true/false for the app
const foodView = (f) => f && ({ ...f, verified: Boolean(f.verified), is_favourite: Boolean(f.is_favourite) });

foodsRouter.get('/', asyncHandler(async (req, res) => {
  const { q, limit } = validate(req.query, {
    q: { type: 'string', maxLength: 50 },
    limit: { type: 'integer', min: 1, max: 100 },
  });
  // ILIKE '%dal%' finds "Dal (toor/moong)" and ignores upper/lower case.
  const rows = await db.all(`${FOOD_SELECT} WHERE f.name ILIKE @q ${FOOD_ORDER} LIMIT @limit`,
    { user_id: req.user.id, q: `%${q || ''}%`, limit: limit || 50 });
  res.json({ foods: rows.map(foodView) });
}));

// Foods you ate most recently (newest first)
foodsRouter.get('/recent', asyncHandler(async (req, res) => {
  const { limit } = validate(req.query, { limit: { type: 'integer', min: 1, max: 50 } });
  const rows = await db.all(`${FOOD_SELECT} WHERE rec.last_used IS NOT NULL ORDER BY rec.last_used DESC LIMIT @limit`,
    { user_id: req.user.id, limit: limit || 10 });
  res.json({ foods: rows.map(foodView) });
}));

// Your starred foods
foodsRouter.get('/favourites', asyncHandler(async (req, res) => {
  const rows = await db.all(`${FOOD_SELECT} WHERE fav.food_id IS NOT NULL ORDER BY f.name`, { user_id: req.user.id });
  res.json({ foods: rows.map(foodView) });
}));

foodsRouter.post('/:id/favourite', asyncHandler(async (req, res) => {
  const id = idParam(req);
  if (!(await db.get('SELECT id FROM foods WHERE id = $1', [id]))) throw new HttpError(404, 'Food not found');
  await db.run('INSERT INTO food_favourites (user_id, food_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [req.user.id, id]);
  res.json({ food_id: id, is_favourite: true });
}));

foodsRouter.delete('/:id/favourite', asyncHandler(async (req, res) => {
  const id = idParam(req);
  await db.run('DELETE FROM food_favourites WHERE user_id = $1 AND food_id = $2', [req.user.id, id]);
  res.json({ food_id: id, is_favourite: false });
}));

foodsRouter.get('/:id', asyncHandler(async (req, res) => {
  const food = await db.get(`${FOOD_SELECT} WHERE f.id = @id`, { user_id: req.user.id, id: idParam(req) });
  if (!food) throw new HttpError(404, 'Food not found');
  res.json({ food: foodView(food) });
}));

foodsRouter.post('/', asyncHandler(async (req, res) => {
  const body = validate(req.body, {
    name: { type: 'string', required: true, maxLength: 80 },
    serving: { type: 'string', required: true, maxLength: 60 },
    kcal: { type: 'number', required: true, min: 0, max: 5000 },
    protein_g: { type: 'number', required: true, min: 0, max: 500 },
    carbs_g: { type: 'number', required: true, min: 0, max: 500 },
    fat_g: { type: 'number', required: true, min: 0, max: 500 },
  });
  const exists = await db.get('SELECT id FROM foods WHERE name = $1', [body.name]);
  if (exists) throw new HttpError(409, 'A food with this name already exists');
  // Foods added by users are NOT verified (verified = 0)
  let info;
  try {
    info = await db.get(`INSERT INTO foods (name, serving, kcal, protein_g, carbs_g, fat_g, verified, created_by)
      VALUES (@name, @serving, @kcal, @protein_g, @carbs_g, @fat_g, 0, @created_by) RETURNING id`, { ...body, created_by: req.user.id });
  } catch (err) {
    if (err.code === '23505') throw new HttpError(409, 'A food with this name already exists');
    throw err;
  }
  res.status(201).json({ food: foodView(await db.get(`${FOOD_SELECT} WHERE f.id = @id`, { user_id: req.user.id, id: info.id })) });
}));

// ---------------- FOOD LOG ----------------
const logsRouter = express.Router();

// One log row joined with its food, with nutrition multiplied by servings.
// (Postgres ROUND(x, 1) needs a "numeric", so we cast; db.js turns it back into a number.)
const LOG_SELECT = `
  SELECT l.id, l.date, l.meal, l.servings, l.food_id, f.name, f.serving,
         ROUND((f.kcal * l.servings)::numeric) AS kcal,
         ROUND((f.protein_g * l.servings)::numeric, 1) AS protein_g,
         ROUND((f.carbs_g * l.servings)::numeric, 1) AS carbs_g,
         ROUND((f.fat_g * l.servings)::numeric, 1) AS fat_g
  FROM food_logs l JOIN foods f ON f.id = l.food_id
`;

const LOG_RULES = {
  food_id: { type: 'integer', required: true, min: 1 },
  meal: { type: 'string', required: true, oneOf: MEALS },
  servings: { type: 'number', min: 0.25, max: 20 },
  date: { type: 'date' },
};

logsRouter.post('/', asyncHandler(async (req, res) => {
  const body = validate(req.body, LOG_RULES);
  const food = await db.get('SELECT id FROM foods WHERE id = $1', [body.food_id]);
  if (!food) throw new HttpError(404, 'Food not found');
  const info = await db.get('INSERT INTO food_logs (user_id, food_id, date, meal, servings) VALUES ($1, $2, $3, $4, $5) RETURNING id',
    [req.user.id, body.food_id, body.date || today(), body.meal, body.servings || 1]);
  res.status(201).json({ entry: await db.get(`${LOG_SELECT} WHERE l.id = $1`, [info.id]) });
}));

// Repeat a meal: copy every item of one meal from one day to another.
// Default: yesterday's meal -> today. Returns the new entries.
logsRouter.post('/repeat', asyncHandler(async (req, res) => {
  const b = validate(req.body, {
    meal: { type: 'string', required: true, oneOf: MEALS },
    from_date: { type: 'date' },
    to_date: { type: 'date' },
  });
  const to = b.to_date || today();
  const from = b.from_date || dayBefore(to);
  const items = await db.all('SELECT food_id, servings FROM food_logs WHERE user_id = $1 AND date = $2 AND meal = $3 ORDER BY id',
    [req.user.id, from, b.meal]);
  if (!items.length) throw new HttpError(404, `Nothing logged for ${b.meal} on ${from}`);

  const ids = await db.tx(async (t) => {
    const out = [];
    for (const i of items) {
      out.push((await t.get('INSERT INTO food_logs (user_id, food_id, date, meal, servings) VALUES ($1, $2, $3, $4, $5) RETURNING id',
        [req.user.id, i.food_id, to, b.meal, i.servings])).id);
    }
    return out;
  });
  const entries = [];
  for (const id of ids) entries.push(await db.get(`${LOG_SELECT} WHERE l.id = $1`, [id]));
  res.status(201).json({ from_date: from, to_date: to, meal: b.meal, entries });
}));

logsRouter.get('/', asyncHandler(async (req, res) => {
  const { date } = validate(req.query, { date: { type: 'date' } });
  const day = date || today();
  const rows = await db.all(`${LOG_SELECT} WHERE l.user_id = $1 AND l.date = $2 ORDER BY l.id`, [req.user.id, day]);

  // Group entries by meal and add up each meal
  const meals = {};
  for (const m of MEALS) meals[m] = { entries: [], kcal: 0, protein_g: 0 };
  for (const r of rows) {
    meals[r.meal].entries.push(r);
    meals[r.meal].kcal = calc.round(meals[r.meal].kcal + r.kcal);
    meals[r.meal].protein_g = calc.round(meals[r.meal].protein_g + r.protein_g, 1);
  }

  const [totals, healthDay] = await Promise.all([summary.foodTotals(req.user.id, day), summary.healthDay(req.user.id, day)]);
  res.json({ date: day, meals, totals, targets: healthDay.targets, calories_left: healthDay.calories_left });
}));

logsRouter.put('/:id', asyncHandler(async (req, res) => {
  const id = idParam(req);
  const changes = validate(req.body, LOG_RULES, { partial: true });
  if (changes.food_id && !(await db.get('SELECT id FROM foods WHERE id = $1', [changes.food_id]))) {
    throw new HttpError(404, 'Food not found');
  }
  const cols = Object.keys(changes);
  if (cols.length) {
    await db.run(`UPDATE food_logs SET ${cols.map((c) => `${c} = @${c}`).join(', ')} WHERE id = @id AND user_id = @user_id`,
      { ...changes, id, user_id: req.user.id });
  }
  const row = await db.get(`${LOG_SELECT} WHERE l.id = $1 AND l.user_id = $2`, [id, req.user.id]);
  if (!row) throw new HttpError(404, 'Log entry not found');
  res.json({ entry: row });
}));

logsRouter.delete('/:id', asyncHandler(async (req, res) => {
  const info = await db.run('DELETE FROM food_logs WHERE id = $1 AND user_id = $2', [idParam(req), req.user.id]);
  if (!info.changes) throw new HttpError(404, 'Log entry not found');
  res.json({ deleted: true });
}));

module.exports = { foodsRouter, logsRouter, MEALS };
