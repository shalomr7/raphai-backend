// test/body_pglite.js — runs ALL migrations + the body-goals / step-reconciliation SQL on an
// in-memory Postgres (PGlite, WASM) because no test database is available.
// Run: npm i --no-save @electric-sql/pglite && node test/body_pglite.js
const { PGlite } = require(process.env.PGLITE_PATH || '@electric-sql/pglite');
const migs = require('../src/migrations');
(async () => {
  const db = new PGlite();
  await db.exec(`CREATE TABLE schema_migrations (id TEXT PRIMARY KEY, applied_at TIMESTAMPTZ DEFAULT now());`);
  for (const m of migs) {
    const sql = typeof m.sql === 'function' ? m.sql() : m.sql;
    try { await db.exec(sql); await db.query('INSERT INTO schema_migrations(id) VALUES ($1)', [m.id]); }
    catch (e) { console.log('MIGRATION FAIL', m.id, e.message); process.exit(1); }
  }
  // re-apply 016 (idempotent) and down + up again
  const m16 = migs.find((m) => m.id === '016_body_goals');
  await db.exec(m16.sql); await db.exec(m16.down); await db.exec(m16.sql);
  console.log('migrations ok, 016 idempotent + down/up ok');
  global.__pg = db;
  // emulate the db helper used by routes
  const toPos = (sql, params) => { if (!params || Array.isArray(params)) return { text: sql, values: params || [] };
    const values = [], index = {}; const text = sql.replace(/@([a-zA-Z_][a-zA-Z0-9_]*)/g, (m, n) => { if (!(n in index)) { values.push(params[n]); index[n] = values.length; } return `$${index[n]}`; }); return { text, values }; };
  const q = async (s, p) => { const { text, values } = toPos(s, p); return db.query(text, values); };
  const h = { get: async (s, p) => (await q(s, p)).rows[0], all: async (s, p) => (await q(s, p)).rows, run: async (s, p) => ({ changes: (await q(s, p)).affectedRows }) };
  h.tx = async (fn) => fn(h);
  require.cache[require.resolve('../src/db.js')] = { exports: h, loaded: true, id: 'db' };
  await h.run(`INSERT INTO users (name, email, password_hash) VALUES ('T','t@x.in','x')`);
  await h.run(`INSERT INTO profiles (user_id, sex, age, height_cm, weight_kg, goal, target_weight_kg) VALUES (1,'male',30,175,80,'lose',74)`);
  // activity reconciliation SQL from the route (copied text)
  const src = require('fs').readFileSync(require('path').join(__dirname, '../src/routes/activity.js'), 'utf8');
  const sql = src.match(/const saved = await t\.get\(`([\s\S]*?)`, \{/)[1].replace('${COLS}', 'date, steps, distance_m, active_kcal, active_minutes, resting_hr, source');
  const post = (steps, source) => h.get(sql, { user_id: 1, date: '2026-10-31', steps, distance_m: null, active_kcal: null, active_minutes: null, resting_hr: null, source });
  let r = await post(9000, 'pedometer'); console.log('1', r.steps, r.steps_source);
  r = await post(9000, 'pedometer'); console.log('retry', r.steps, r.steps_source);
  r = await post(7000, 'health_connect'); console.log('lower HC', r.steps, r.steps_source);
  r = await post(9500, 'health_connect'); console.log('higher HC', r.steps, r.steps_source);
  r = await post(null, 'health_connect'); console.log('null steps', r.steps, r.steps_source);
  r = await post(8000, 'manual'); console.log('manual', r.steps, r.steps_source);
  // workouts idempotency SQL
  const ins = `INSERT INTO workouts (user_id, date, activity, minutes, met, weight_kg, kcal, intensity, distance_km, source, client_id)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT (user_id, client_id) WHERE client_id IS NOT NULL DO NOTHING RETURNING *`;
  const a = await h.get(ins, [1, '2026-10-30', 'cycling', 30, 7.5, 80, 300, 'moderate', null, 'manual', 'abc']);
  const b = await h.get(ins, [1, '2026-10-30', 'cycling', 30, 7.5, 80, 300, 'moderate', null, 'manual', 'abc']);
  await h.get(ins, [1, '2026-10-30', 'yoga', 30, 2.5, 80, 100, null, null, 'manual', null]);
  await h.get(ins, [1, '2026-10-30', 'yoga', 30, 2.5, 80, 100, null, null, 'manual', null]);
  console.log('workout dup', !!a, b === undefined, (await h.get('SELECT count(*)::int c FROM workouts')).c);
  // data for forecast
  const dates = require('../src/utils/dates');
  const today = dates.today();
  await h.run(`INSERT INTO foods (name, serving, kcal, protein_g, carbs_g, fat_g, verified) VALUES ('Idli','1',58,2,12,0.2,1)`);
  for (let i = 1; i <= 7; i++) { const d = dates.addDays(today, -i);
    for (const meal of ['breakfast', 'lunch', 'dinner']) await h.run('INSERT INTO food_logs (user_id, food_id, date, meal, servings) VALUES (1,1,$1,$2,11)', [d, meal]);
    await h.run('INSERT INTO step_logs (user_id, date, steps) VALUES (1,$1,7000) ON CONFLICT DO NOTHING', [d]); }
  await h.run('INSERT INTO weight_logs (user_id, date, weight_kg) VALUES (1,$1,80.2),(1,$2,80)', [dates.addDays(today, -6), today]);
  const bg = require('../src/services/bodyGoals');
  const f = await bg.forecast(1); console.log('forecast', f.status, JSON.stringify(f.change_kg), f.coverage.complete_days, f.message);
  const f2 = await bg.forecast(1); console.log('saved rows', (await h.get('SELECT count(*)::int c FROM weight_forecasts')).c);
  const p = await bg.progress(1); console.log('progress', p.status, p.start_kg, p.current_trend_kg, p.target_kg, p.progress_pct, p.measurements.length, p.predictions.length);
  const tools = require('../src/ai/tools');
  const t = await tools.runTool(1, 'getWeightForecast', {}); console.log('tool', t.status, JSON.stringify(t.change_kg));
})().catch((e) => { console.error('ERR', e); process.exit(1); });
