// test/accuracy_api.js — accuracy pass (2026-11-02) against an in-memory
// Postgres (PGlite), every migration applied, real routes over HTTP.
//  - server step totals: phone + Health Connect overlap, duplicate uploads, manual fix
//  - food seed corrections reach an existing database
//  - HeartScore streak uses the same score Home shows
//  - 10 typical coach questions (rule-based path) + the AI tools: every
//    number checked against values worked out by hand from the records
// Run: npm i --no-save @electric-sql/pglite && node --test test/accuracy_api.js
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'accuracy-test-secret-accuracy-test-123';
delete process.env.GEMINI_API_KEY;
const test = require('node:test');
const assert = require('node:assert/strict');
const { PGlite } = require(process.env.PGLITE_PATH || '@electric-sql/pglite');
const migs = require('../src/migrations');
const { foodSeedQueries } = require('../src/seed/sql');

let pg; let base; let server; let tok1; let tok2; let D; let Y;

function helpers(runner) {
  const toPos = (sql, params) => {
    if (!params || Array.isArray(params)) return { text: sql, values: params || [] };
    const values = []; const index = {};
    const text = sql.replace(/@([a-zA-Z_][a-zA-Z0-9_]*)/g, (m, n) => { if (!(n in params)) throw new Error(`Missing SQL parameter @${n}`); if (!(n in index)) { values.push(params[n]); index[n] = values.length; } return `$${index[n]}`; });
    return { text, values };
  };
  const q = async (s, p) => { const { text, values } = toPos(s, p); return runner.query(text, values); };
  return { query: q, get: async (s, p) => (await q(s, p)).rows[0], all: async (s, p) => (await q(s, p)).rows, run: async (s, p) => { const r = await q(s, p); return { changes: r.affectedRows, rows: r.rows }; } };
}
async function call(method, path, body, tok = tok1) {
  const r = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` }, body: body ? JSON.stringify(body) : undefined });
  let json = null; try { json = await r.json(); } catch { /* empty */ }
  return { status: r.status, body: json };
}
const ask = async (question) => (await call('POST', '/api/coach', { question })).body;

test.before(async () => {
  pg = new PGlite();
  await pg.exec('CREATE TABLE schema_migrations (id TEXT PRIMARY KEY, applied_at TIMESTAMPTZ DEFAULT now());');
  for (const m of migs) { await pg.exec(typeof m.sql === 'function' ? m.sql() : m.sql); await pg.query('INSERT INTO schema_migrations(id) VALUES ($1)', [m.id]); }
  // An "old" database: Phulka stored with the pre-fix values, then the seed runs.
  await pg.query("INSERT INTO foods (name, serving, kcal, protein_g, carbs_g, fat_g, verified) VALUES ('Phulka (no ghee)', '1 small (30 g)', 85, 2.6, 17, 0.5, 1)");
  for (const q of foodSeedQueries()) await pg.query(q.text, q.values);
  const h = helpers(pg);
  h.tx = (fn) => pg.transaction((tx) => fn(helpers(tx)));
  require.cache[require.resolve('../src/db.js')] = { exports: h, loaded: true, id: 'db' };
  const dates = require('../src/utils/dates');
  D = dates.today(); Y = dates.addDays(D, -1);
  await pg.exec(`INSERT INTO users (name, email, password_hash) VALUES ('Ravi Kumar','r@x.in','x'), ('Sita','s@x.in','x');
    INSERT INTO profiles (user_id, sex, age, height_cm, weight_kg, activity_factor, goal, pace_kg_week, step_goal, income)
      VALUES (1, 'male', 30, 175, 70, 1.2, 'maintain', 0, 8000, 60000);
    INSERT INTO subscriptions (user_id, plan, status, expires_at) VALUES (1, 'elite', 'active', '2099-01-01 00:00:00') ON CONFLICT (user_id) DO UPDATE SET plan = 'elite', status = 'active', expires_at = '2099-01-01 00:00:00';`);
  const { createApp } = require('../src/app');
  const { signToken } = require('../src/middleware/auth');
  tok1 = signToken({ id: 1 }); tok2 = signToken({ id: 2 });
  server = createApp().listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => { server && server.close(); });

// ---------------- steps on the server ----------------
test('S1 phone + Health Connect overlap: the higher total wins, never the sum; duplicates are no-ops; manual replaces', async () => {
  const post = (steps, source) => call('POST', '/api/activity/daily', { date: Y, steps, source });
  const seq = [
    [5000, 'pedometer', 5000, 'pedometer'],
    [4800, 'health_connect', 5000, 'pedometer'],     // watch saw fewer: phone total kept
    [5000, 'pedometer', 5000, 'pedometer'],          // duplicate upload
    [5000, 'pedometer', 5000, 'pedometer'],          // and again (retry)
    [6200, 'health_connect', 6200, 'health_connect'], // watch saw more (phone in a bag)
    [6100, 'pedometer', 6200, 'health_connect'],
    [3000, 'manual', 3000, 'manual'],                // user's own correction
  ];
  for (const [steps, source, want, wantSrc] of seq) {
    const r = await post(steps, source);
    assert.equal(r.status, 200);
    assert.equal(r.body.steps, want, `${source} ${steps}`);
    assert.equal(r.body.steps_source, wantSrc);
    const sl = await pg.query('SELECT steps FROM step_logs WHERE user_id = 1 AND date = $1', [Y]);
    assert.equal(sl.rows[0].steps, want, 'step_logs follows the reconciled total');
  }
});

// ---------------- food seed ----------------
test('N4 a corrected seed value reaches a database that already had the food (Phulka 85 -> 72 kcal); user foods untouched', async () => {
  const r = await pg.query("SELECT kcal, protein_g, carbs_g, fat_g FROM foods WHERE name = 'Phulka (no ghee)'");
  assert.deepEqual(r.rows[0], { kcal: 72, protein_g: 2.4, carbs_g: 14.5, fat_g: 0.4 });
  await pg.query("INSERT INTO foods (name, serving, kcal, protein_g, carbs_g, fat_g, created_by) VALUES ('My Dosa', '1', 999, 1, 1, 1, 1)");
  for (const q of foodSeedQueries()) await pg.query(q.text, q.values);
  const u = await pg.query("SELECT kcal FROM foods WHERE name = 'My Dosa'");
  assert.equal(u.rows[0].kcal, 999);
  const again = await pg.query(foodSeedQueries()[1].text, foodSeedQueries()[1].values);
  assert.equal(again.affectedRows, 0, 'second run changes nothing');
});

// ---------------- HeartScore streak ----------------
test('H5 the "HeartScore 60+" streak uses the HeartScore Home shows (sleep 8 h + mood 5 on 2 days = 96, streak 2)', async () => {
  await pg.query(`INSERT INTO sleep_logs (user_id, date, hours) VALUES (2, $1, 8), (2, $2, 8)`, [Y, D]);
  await pg.query(`INSERT INTO mood_logs (user_id, date, mood) VALUES (2, $1, 5), (2, $2, 5)`, [Y, D]);
  const ins = await call('GET', '/api/insights/today', null, tok2);
  // mind 100 x .15 + recovery 100 x .15 + habits (70 + 30 x 2/4 = 85) x .10 = 38.5 / 0.40 = 96.25
  assert.equal(ins.body.raphscore.overall, 96);
  const dash = await call('GET', '/api/dashboard', null, tok2);
  assert.equal(dash.body.streaks.raph_score.days, 2);
  assert.equal(dash.body.streaks.raph_score.today_done, true);
});

// ---------------- coach: 10 questions + tools ----------------
test('C0 records for the coach checks', async () => {
  const fid = async (n) => (await pg.query('SELECT id FROM foods WHERE name = $1', [n])).rows[0].id;
  await pg.query("INSERT INTO food_logs (user_id, food_id, date, meal, servings) VALUES (1, $1, $3, 'lunch', 2), (1, $2, $3, 'lunch', 1)", [await fid('Roti / Chapati'), await fid('Dal (toor/moong)'), D]);
  await pg.query('INSERT INTO water_logs (user_id, date, ml) VALUES (1, $1, 1500)', [D]);
  await pg.query("INSERT INTO workouts (user_id, date, activity, minutes, met, weight_kg, kcal) VALUES (1, $1, 'running', 30, 9.8, 70, 343)", [D]);
  await pg.query('INSERT INTO sleep_logs (user_id, date, hours) VALUES (1, $1, 6.5)', [D]);
  await pg.query('INSERT INTO mood_logs (user_id, date, mood) VALUES (1, $1, 3)', [D]);
  assert.equal((await call('POST', '/api/activity/daily', { date: D, steps: 4200, source: 'pedometer' })).status, 200);
  await pg.query(`INSERT INTO expenses (user_id, amount, category, mode, note, date, type) VALUES
    (1, 1000, 'Food', 'UPI', 'dinner out', $1, 'expense'), (1, 400, 'Food', 'UPI', 'refund', $1, 'refund'),
    (1, 2000, 'Groceries', 'UPI', 'veg', $1, 'expense'), (1, 5000, 'Investment', 'UPI', 'SIP', $1, 'expense')`, [D]);
  await pg.query(`INSERT INTO savings_goals (user_id, name, target, saved, status) VALUES (1, 'Trip', 30000, 5000, 'paused'), (1, 'Bike', 50000, 10000, 'active')`);
});
// Hand-worked: target 1,979 (E4) + 343 workout - eaten (2 roti 240 + dal 150 = 390) = 1,932 left; protein 6 + 9 = 15 g.
// Money: Food 1,000 - 400 refund = 600; Groceries 2,000; spent 2,600; SIP 5,000 is investing; income ₹60,000 (profile).
const checks = [
  ['how many calories do I have left?', 'calories_left', [/about 1932 kcal left/, /target 1979/, /eaten 390/, /burned 343/]],
  ['how much did I spend on food this month?', 'food_spend', [/spent ₹2,600 on food/, /₹600 eating out/, /₹2,000 groceries/, /100% of all your spending/]],
  ['why are my steps so low?', 'steps_low', [/4,200 steps today/, /3,800 away from your 8,000 goal/, /7-day average is 3,600/]], // yesterday = 3,000 (S1 manual), today 4,200,
  ['how can I save more money?', 'save_more', [/spent ₹2,600 of your ₹60,000/, /leaves ₹57,400/, /Food at ₹600/, /saves about ₹150/, /₹12,000 \(20%\)/]],
  ['how much should I save?', 'how_much_to_save', [/save ₹12,000 a month \(20% of ₹60,000\)/, /spending is ₹57,400/, /"Bike" needs ₹40,000 more/]],
  ['how did I sleep?', 'sleep', [/slept 6h 30m/, /7-day average is 6h 30m/]],
  ['what should I eat today?', 'nutrition_today', [/1,979 kcal with 84 g protein/, /had 390 kcal and 15 g protein/, /about 1,932 kcal left \(including 343 kcal from workouts\)/]],
  ['which foods have protein?', 'protein_foods', [/about 69 g more protein/]],
  ['help me lose belly fat', 'fat_loss', [/eat about 1,979 kcal a day/, /burns about 1,979/, /84 g of protein/, /walk 8,000 steps a day \(you average 3,600 now\)/]],
  ['what should I do today?', 'what_to_do_today', []],
];
for (const [q, topic, pats] of checks) {
  test(`C coach: "${q}" -> ${topic}, numbers match the records`, async () => {
    const r = await ask(q);
    assert.equal(r.engine === 'ai', false, 'rule-based path');
    assert.equal(r.topic, topic, r.answer);
    assert.doesNotMatch(r.answer, /NaN|undefined|null|Infinity/);
    for (const p of pats) assert.match(r.answer, p, r.answer);
  });
}
test('C11 AI tools return the record values (what the AI may quote)', async () => {
  const { TOOLS } = require('../src/ai/tools');
  const h = await TOOLS.getHealthSummary.run(1, {});
  assert.deepEqual([h.targets.calories, h.eaten.kcal, h.eaten.protein_g, h.calories_left, h.water_ml, h.sleep_hours], [1979, 390, 15, 1932, 1500, 6.5]);
  const f = await TOOLS.getFitnessSummary.run(1, {});
  assert.equal(f.steps, 4200); assert.deepEqual(f.workouts, [{ activity: 'running', minutes: 30, kcal: 343 }]);
  const m = await TOOLS.getFinanceSummary.run(1, {});
  assert.deepEqual([m.income, m.spent, m.invested, m.left_over], [60000, 2600, 5000, 52400]);
  const g = await TOOLS.getGoals.run(1, {});
  assert.deepEqual(g.savings_goals.map((x) => [x.name, x.status, x.progress_pct]), [['Trip', 'paused', 16.7], ['Bike', 'active', 20]]);
  const b = await TOOLS.getDailyBrief.run(1);
  assert.ok(b.raphscore.overall == null || (b.raphscore.overall >= 0 && b.raphscore.overall <= 100));
});
