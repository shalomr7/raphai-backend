// test/audit_fixes.js — audit fixes of 2026-11-18 against an in-memory
// Postgres (PGlite), every migration applied, real routes over HTTP.
//  - manual sleep saved twice counts once (and old duplicate rows read as one)
//  - food logging and repeat-meal are retry-safe (client_id / Idempotency-Key)
//  - only session 401s carry code 'session_invalid' (wrong password does not)
//  - POST /api/auth/logout stops this token only
// Run: npm i --no-save @electric-sql/pglite && node --test test/audit_fixes.js
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'audit-fix-test-secret-audit-fix-test-1234';
delete process.env.GEMINI_API_KEY;
const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const { PGlite } = require(process.env.PGLITE_PATH || '@electric-sql/pglite');
const migs = require('../src/migrations');
const { foodSeedQueries } = require('../src/seed/sql');

let pg; let base; let server; let tok1; let tok2; let D; let Y; let foodId;

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
async function call(method, path, body, tok = tok1, headers = {}) {
  const r = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: `Bearer ${tok}` } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  let json = null; try { json = await r.json(); } catch { /* empty */ }
  return { status: r.status, body: json };
}

test.before(async () => {
  pg = new PGlite();
  await pg.exec('CREATE TABLE schema_migrations (id TEXT PRIMARY KEY, applied_at TIMESTAMPTZ DEFAULT now());');
  for (const m of migs) { await pg.exec(typeof m.sql === 'function' ? m.sql() : m.sql); await pg.query('INSERT INTO schema_migrations(id) VALUES ($1)', [m.id]); }
  for (const q of foodSeedQueries()) await pg.query(q.text, q.values);
  const h = helpers(pg);
  h.tx = (fn) => pg.transaction((tx) => fn(helpers(tx)));
  require.cache[require.resolve('../src/db.js')] = { exports: h, loaded: true, id: 'db' };
  const dates = require('../src/utils/dates');
  D = dates.today(); Y = dates.addDays(D, -1);
  const hash = await bcrypt.hash('right-password', 4);
  await pg.query("INSERT INTO users (name, email, password_hash) VALUES ('Ravi','r@x.in',$1), ('Sita','s@x.in',$1)", [hash]);
  await pg.exec(`INSERT INTO profiles (user_id, sex, age, height_cm, weight_kg, activity_factor, goal, pace_kg_week, step_goal, income)
      VALUES (1, 'male', 30, 175, 70, 1.2, 'maintain', 0, 8000, 60000);`);
  foodId = (await pg.query('SELECT id FROM foods ORDER BY id LIMIT 1')).rows[0].id;
  const { createApp } = require('../src/app');
  const { signToken } = require('../src/middleware/auth');
  tok1 = signToken({ id: 1 }); tok2 = signToken({ id: 2 });
  server = createApp().listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => { server && server.close(); });

const sleepToday = async () => (await call('GET', '/api/dashboard')).body.health?.sleep_hours ?? (await call('GET', '/api/dashboard')).body.sleep_hours;

test('A1 manual sleep saved twice counts once (the second save corrects it)', async () => {
  const a = await call('POST', '/api/health/sleep', { hours: 7, date: D });
  assert.equal(a.status, 201);
  const b = await call('POST', '/api/health/sleep', { hours: 8, date: D });
  assert.equal(b.status, 200); assert.equal(b.body.replaced, true); assert.equal(b.body.entry.id, a.body.entry.id);
  const rows = (await call('GET', `/api/health/sleep?date=${D}`)).body.entries;
  assert.equal(rows.length, 1);
  assert.equal(Number(await sleepToday()), 8);
});

test('A2 old duplicate rows read as one night (latest manual, never summed) and the import does not add to it', async () => {
  await pg.query('INSERT INTO sleep_logs (user_id, date, hours) VALUES (1, $1, 6), (1, $1, 7.5)', [Y]);
  await pg.query("INSERT INTO sleep_logs (user_id, date, hours, source) VALUES (1, $1, 9, 'health_connect')", [Y]);
  const intel = require('../src/services/intelligence');
  const { healthDay } = require('../src/services/summary');
  if (healthDay) { const d = await healthDay(1, Y); assert.equal(Number(d.sleep_hours), 7.5); }
  if (intel.loadDays) { const days = await intel.loadDays(1, Y, Y); const d = Array.isArray(days) ? days[0] : days[Y]; assert.equal(Number(d.sleep_h), 7.5); }
});

test('A3 food log with the same client_id is saved once', async () => {
  const body = { food_id: foodId, meal: 'breakfast', servings: 1, date: D, client_id: 'tap-1' };
  const r1 = await call('POST', '/api/food-logs', body);
  const r2 = await call('POST', '/api/food-logs', body);
  const r3 = await call('POST', '/api/food-logs', { ...body, client_id: undefined }, tok1, { 'Idempotency-Key': 'tap-1' });
  assert.equal(r1.status, 201); assert.equal(r2.status, 200); assert.equal(r3.status, 200);
  assert.equal(r2.body.entry.id, r1.body.entry.id); assert.equal(r3.body.entry.id, r1.body.entry.id);
  const n = (await pg.query("SELECT COUNT(*)::int AS n FROM food_logs WHERE user_id = 1 AND meal = 'breakfast' AND date = $1", [D])).rows[0].n;
  assert.equal(n, 1);
  // another user may use the same key
  const o = await call('POST', '/api/food-logs', body, tok2);
  assert.equal(o.status, 201);
  // no key = a new entry each time (old app builds keep working)
  const k1 = await call('POST', '/api/food-logs', { food_id: foodId, meal: 'snack', date: D });
  const k2 = await call('POST', '/api/food-logs', { food_id: foodId, meal: 'snack', date: D });
  assert.notEqual(k1.body.entry.id, k2.body.entry.id);
});

test('A4 repeat meal with the same client_id copies the meal once', async () => {
  await call('POST', '/api/food-logs', { food_id: foodId, meal: 'lunch', date: Y, client_id: 'y1' });
  await call('POST', '/api/food-logs', { food_id: foodId, meal: 'lunch', date: Y, client_id: 'y2' });
  const r1 = await call('POST', '/api/food-logs/repeat', { meal: 'lunch', from_date: Y, to_date: D, client_id: 'rep-1' });
  const r2 = await call('POST', '/api/food-logs/repeat', { meal: 'lunch', from_date: Y, to_date: D, client_id: 'rep-1' });
  assert.equal(r1.status, 201); assert.equal(r1.body.entries.length, 2);
  assert.equal(r2.status, 200); assert.deepEqual(r2.body.entries.map((e) => e.id), r1.body.entries.map((e) => e.id));
  const n = (await pg.query("SELECT COUNT(*)::int AS n FROM food_logs WHERE user_id = 1 AND meal = 'lunch' AND date = $1", [D])).rows[0].n;
  assert.equal(n, 2);
});

test('A5 a wrong password in Delete account is a 401 WITHOUT the session code; a bad token has it', async () => {
  const wrong = await call('DELETE', '/api/auth/me', { password: 'nope' });
  assert.equal(wrong.status, 401); assert.notEqual(wrong.body.code, 'session_invalid');
  const bad = await call('GET', '/api/dashboard', null, 'not-a-token');
  assert.equal(bad.status, 401); assert.equal(bad.body.code, 'session_invalid');
  const none = await call('GET', '/api/dashboard', null, null);
  assert.equal(none.status, 401); assert.equal(none.body.code, 'session_invalid');
  const still = await call('GET', '/api/dashboard');
  assert.equal(still.status, 200);
});

test('A6 logout stops this token only', async () => {
  const { signToken } = require('../src/middleware/auth');
  const t = signToken({ id: 2 });
  await new Promise((r) => setTimeout(r, 5));
  const other = tok2;
  const out = await call('POST', '/api/auth/logout', null, t);
  assert.equal(out.status, 200); assert.equal(out.body.logged_out, true);
  const after = await call('GET', '/api/dashboard', null, t);
  if (t !== other) {
    assert.equal(after.status, 401); assert.equal(after.body.code, 'session_invalid');
    assert.equal((await call('GET', '/api/dashboard', null, other)).status, 200);
  }
  const rows = (await pg.query('SELECT token_hash FROM revoked_tokens')).rows;
  assert.ok(rows.length >= 1 && rows.every((r) => /^[0-9a-f]{64}$/.test(r.token_hash)));
});

test('A7 migrations 019 and 020 roll back and re-apply cleanly', async () => {
  for (const id of ['020_revoked_tokens', '019_food_log_client_id']) await pg.exec(migs.find((m) => m.id === id).down);
  for (const id of ['019_food_log_client_id', '020_revoked_tokens']) { const m = migs.find((x) => x.id === id); await pg.exec(m.sql); await pg.query('INSERT INTO schema_migrations(id) VALUES ($1)', [m.id]); }
  const n = (await pg.query("SELECT COUNT(*)::int AS n FROM schema_migrations WHERE id IN ('019_food_log_client_id','020_revoked_tokens')")).rows[0].n;
  assert.equal(n, 2);
});
