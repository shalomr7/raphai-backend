// db.js
// ------------------------------------------------------------
// This file connects to the PostgreSQL database (for example a free
// Supabase database) and creates all tables.
//
// Settings (in .env, or in the Render dashboard):
//   DATABASE_URL  the Postgres connection string (required)
//   DATABASE_SSL  "false" turns SSL off (only for a local Postgres).
//                 SSL is ON by default, and always on for remote hosts
//                 unless you turn it off. Local hosts (localhost) get no SSL.
//   DB_SCHEMA     optional: use this Postgres schema instead of "public"
//                 (the smoke test uses it to get a fresh, empty space)
//   PG_POOL_MAX   optional: how many connections to keep open (default 5)
//
// How other files use it (all functions are async, so use "await"):
//   await db.get(sql, params)   -> first row, or undefined
//   await db.all(sql, params)   -> array of rows
//   await db.run(sql, params)   -> { changes, rows }   (rows = RETURNING ...)
//   await db.tx(async (t) => { await t.run(...); ... })  -> one transaction
// "params" is either an array for $1, $2 ... placeholders, or an object
// for @name placeholders (handy when the SQL is built on the fly).
// ------------------------------------------------------------

const { Pool, types } = require('pg');
const foods = require('./seed/foods');

// Postgres sends COUNT(*) and SUM(integer) as "bigint", and ROUND(...) as
// "numeric". The pg package gives those to us as TEXT by default.
// Our numbers are small, so turn them into normal JavaScript numbers
// (this keeps the API answers the same as the old SQLite version).
types.setTypeParser(20, (v) => (v === null ? null : parseInt(v, 10)));   // int8 / bigint
types.setTypeParser(1700, (v) => (v === null ? null : parseFloat(v)));   // numeric

// ------------------------------------------------------------
// Connection settings
// ------------------------------------------------------------
function poolConfig() {
  const raw = process.env.DATABASE_URL;
  if (!raw) {
    throw new Error('DATABASE_URL is not set. Put your Postgres (Supabase) connection string in .env or in the Render dashboard.');
  }
  let connectionString = raw;
  let host = '';
  let sslmode = null;
  try {
    const url = new URL(raw);
    host = url.hostname;
    sslmode = url.searchParams.get('sslmode');
    // We set SSL ourselves below. If "sslmode=require" stays in the URL,
    // newer versions of pg treat it as "check the certificate fully",
    // which fails on Supabase. So we remove it from the URL.
    url.searchParams.delete('sslmode');
    connectionString = url.toString();
  } catch {
    // Not a URL we can read; give it to pg as it is
  }
  const isLocal = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(host);
  const sslOff = process.env.DATABASE_SSL === 'false'
    || sslmode === 'disable'
    || (isLocal && process.env.DATABASE_SSL !== 'true');

  return {
    connectionString,
    // Supabase needs SSL. rejectUnauthorized:false = encrypted, but we
    // don't check the certificate chain (Supabase uses its own CA).
    ssl: sslOff ? false : { rejectUnauthorized: false },
    max: Number(process.env.PG_POOL_MAX) || 5,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 15000,
  };
}

// Schema names are put into SQL directly, so only allow safe names
function schemaName() {
  const s = process.env.DB_SCHEMA;
  if (!s) return null;
  if (!/^[a-z_][a-z0-9_]*$/i.test(s)) throw new Error('DB_SCHEMA may only contain letters, numbers and _');
  return s;
}

// The pool is created the first time we need it (so just loading this
// file never crashes, even before .env is read).
let pool = null;
function getPool() {
  if (!pool) {
    const config = poolConfig();
    const schema = schemaName();
    // Every new connection looks in our schema first
    if (schema) config.options = `-c search_path=${schema}`;
    pool = new Pool(config);
    // A broken idle connection should not crash the server
    pool.on('error', (err) => console.error('Postgres pool error:', err.message));
  }
  return pool;
}

// ------------------------------------------------------------
// Placeholders: turn "@name" into "$1, $2 ..." when params is an object
// ------------------------------------------------------------
function toPositional(sql, params) {
  if (params === undefined || params === null) return { text: sql, values: [] };
  if (Array.isArray(params)) return { text: sql, values: params };
  const values = [];
  const index = {};
  const text = sql.replace(/@([a-zA-Z_][a-zA-Z0-9_]*)/g, (m, name) => {
    if (!(name in params)) throw new Error(`Missing SQL parameter @${name}`);
    if (!(name in index)) { values.push(params[name]); index[name] = values.length; }
    return `$${index[name]}`;
  });
  return { text, values };
}

// get / all / run on any "runner" (the pool, or one client in a transaction)
function helpers(runner) {
  const query = (sql, params) => {
    const { text, values } = toPositional(sql, params);
    return runner.query(text, values);
  };
  return {
    query,
    get: async (sql, params) => (await query(sql, params)).rows[0],
    all: async (sql, params) => (await query(sql, params)).rows,
    run: async (sql, params) => {
      const r = await query(sql, params);
      return { changes: r.rowCount, rows: r.rows };
    },
  };
}

const db = {
  query: (sql, params) => helpers(getPool()).query(sql, params),
  get: (sql, params) => helpers(getPool()).get(sql, params),
  all: (sql, params) => helpers(getPool()).all(sql, params),
  run: (sql, params) => helpers(getPool()).run(sql, params),

  // Run several statements as ONE transaction: all succeed, or none do.
  async tx(fn) {
    const client = await getPool().connect();
    try {
      await client.query('BEGIN');
      const result = await fn(helpers(client));
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  },

  init,

  // Close all connections (used by the smoke test)
  async close() {
    if (pool) { const p = pool; pool = null; await p.end(); }
  },
};

// ------------------------------------------------------------
// Tables. "IF NOT EXISTS" means it is safe to run on every start.
// Dates are stored as text 'YYYY-MM-DD'. Money is stored in rupees (₹).
// "created_at" is text 'YYYY-MM-DD HH:MM:SS' in UTC (same as before).
// Yes/no columns stay as INTEGER 0/1 so API answers do not change.
// ------------------------------------------------------------
const NOW_TEXT = `(to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'))`;

const SCHEMA_SQL = `
  -- People who use the app
  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    name          TEXT NOT NULL,
    email         TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at    TEXT NOT NULL DEFAULT ${NOW_TEXT}
  );

  -- Body + money details used for calculations (one row per user)
  CREATE TABLE IF NOT EXISTS profiles (
    user_id         INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    sex             TEXT,      -- 'male' or 'female'
    age             INTEGER,
    height_cm       DOUBLE PRECISION,
    weight_kg       DOUBLE PRECISION,
    activity_factor DOUBLE PRECISION DEFAULT 1.2, -- 1.2 sitting ... 1.9 very active
    goal            TEXT DEFAULT 'maintain', -- 'lose' | 'maintain' | 'gain'
    pace_kg_week    DOUBLE PRECISION DEFAULT 0.5,
    income          DOUBLE PRECISION DEFAULT 0,   -- monthly income in ₹
    neck_cm         DOUBLE PRECISION,  -- optional, for body fat %
    waist_cm        DOUBLE PRECISION,  -- optional, for body fat %
    hip_cm          DOUBLE PRECISION,  -- optional, women only, for body fat %
    step_goal       INTEGER DEFAULT 8000
  );

  -- Food library (seeded with Indian foods below)
  CREATE TABLE IF NOT EXISTS foods (
    id         INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    name       TEXT NOT NULL UNIQUE,
    serving    TEXT NOT NULL,   -- e.g. '1 katori (150 g)'
    kcal       DOUBLE PRECISION NOT NULL,
    protein_g  DOUBLE PRECISION NOT NULL,
    carbs_g    DOUBLE PRECISION NOT NULL,
    fat_g      DOUBLE PRECISION NOT NULL,
    verified   INTEGER NOT NULL DEFAULT 0, -- 1 = checked (seed list), 0 = added by a user
    created_by INTEGER                     -- who added a custom food (null for seeded foods)
  );

  -- What a user ate
  CREATE TABLE IF NOT EXISTS food_logs (
    id         INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    food_id    INTEGER NOT NULL REFERENCES foods(id),
    date       TEXT NOT NULL,
    meal       TEXT NOT NULL,      -- breakfast | lunch | dinner | snack
    servings   DOUBLE PRECISION NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT ${NOW_TEXT}
  );

  -- Step count per day (sent by the phone app). One row per user per day.
  CREATE TABLE IF NOT EXISTS step_logs (
    id      INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    date    TEXT NOT NULL,
    steps   INTEGER NOT NULL,
    UNIQUE(user_id, date)
  );

  CREATE TABLE IF NOT EXISTS workouts (
    id        INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    date      TEXT NOT NULL,
    activity  TEXT NOT NULL,
    minutes   DOUBLE PRECISION NOT NULL,
    met       DOUBLE PRECISION NOT NULL,
    weight_kg DOUBLE PRECISION NOT NULL,
    kcal      DOUBLE PRECISION NOT NULL
  );

  CREATE TABLE IF NOT EXISTS water_logs (
    id      INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    date    TEXT NOT NULL,
    ml      DOUBLE PRECISION NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sleep_logs (
    id      INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    date    TEXT NOT NULL,   -- the morning you woke up
    hours   DOUBLE PRECISION NOT NULL,
    quality INTEGER          -- 1 (bad) to 5 (great), optional
  );

  CREATE TABLE IF NOT EXISTS mood_logs (
    id      INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    date    TEXT NOT NULL,
    mood    INTEGER NOT NULL, -- 1 (sad) to 5 (happy)
    note    TEXT
  );

  CREATE TABLE IF NOT EXISTS weight_logs (
    id        INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    date      TEXT NOT NULL,
    weight_kg DOUBLE PRECISION NOT NULL
  );

  -- "Stand up and move" reminder settings (the phone app reads these)
  CREATE TABLE IF NOT EXISTS reminder_settings (
    user_id      INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    enabled      INTEGER NOT NULL DEFAULT 1, -- 1 = on, 0 = off
    interval_min INTEGER NOT NULL DEFAULT 60,
    start_hour   INTEGER NOT NULL DEFAULT 9,  -- only remind between these hours
    end_hour     INTEGER NOT NULL DEFAULT 21
  );

  -- ---------------- WEALTH ----------------
  CREATE TABLE IF NOT EXISTS expenses (
    id       INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    amount   DOUBLE PRECISION NOT NULL,
    category TEXT NOT NULL,
    mode     TEXT NOT NULL,   -- UPI | Card | Cash
    note     TEXT,
    date     TEXT NOT NULL
  );

  -- Monthly budget per category, e.g. month '2026-10', 'Food', 6000
  CREATE TABLE IF NOT EXISTS budgets (
    id       INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    month    TEXT NOT NULL,
    category TEXT NOT NULL,
    amount   DOUBLE PRECISION NOT NULL,
    UNIQUE(user_id, month, category)
  );

  CREATE TABLE IF NOT EXISTS savings_goals (
    id       INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name     TEXT NOT NULL,
    target   DOUBLE PRECISION NOT NULL,
    saved    DOUBLE PRECISION NOT NULL DEFAULT 0,
    deadline TEXT            -- optional 'YYYY-MM-DD'
  );

  CREATE TABLE IF NOT EXISTS bills (
    id        INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name      TEXT NOT NULL,
    amount    DOUBLE PRECISION NOT NULL,
    due_day   INTEGER NOT NULL, -- day of month 1-31
    recurring INTEGER NOT NULL DEFAULT 1
  );

  -- Which months a bill was paid in ('2026-10')
  CREATE TABLE IF NOT EXISTS bill_payments (
    bill_id INTEGER NOT NULL REFERENCES bills(id) ON DELETE CASCADE,
    month   TEXT NOT NULL,
    paid_at TEXT NOT NULL DEFAULT ${NOW_TEXT},
    PRIMARY KEY (bill_id, month)
  );

  -- ---------------- SUBSCRIPTIONS ----------------
  CREATE TABLE IF NOT EXISTS subscriptions (
    user_id    INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    plan       TEXT NOT NULL DEFAULT 'free',
    period     TEXT,           -- 'monthly' | 'yearly' | 'trial'
    status     TEXT NOT NULL DEFAULT 'active',
    expires_at TEXT,           -- ISO date-time, null for free
    trial_used INTEGER NOT NULL DEFAULT 0 -- 1 once the free trial is used
  );

  -- LEGACY (unused since Oct 2026): old payment-order table. Nothing reads or
  -- writes it any more; payments go through Google Play. Kept so existing
  -- databases are not changed (we never drop tables in init()).
  CREATE TABLE IF NOT EXISTS payments (
    id           INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    order_id     TEXT NOT NULL UNIQUE,
    payment_id   TEXT,
    plan         TEXT NOT NULL,
    period       TEXT NOT NULL,
    amount_paise INTEGER NOT NULL,
    status       TEXT NOT NULL DEFAULT 'created', -- created | paid | failed
    created_at   TEXT NOT NULL DEFAULT ${NOW_TEXT}
  );

  -- Foods a user starred, so they show first and can be logged fast
  CREATE TABLE IF NOT EXISTS food_favourites (
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    food_id    INTEGER NOT NULL REFERENCES foods(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT ${NOW_TEXT},
    PRIMARY KEY (user_id, food_id)
  );

  -- Columns added after v1 (safe if they already exist)
  ALTER TABLE foods ADD COLUMN IF NOT EXISTS verified INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE foods ADD COLUMN IF NOT EXISTS created_by INTEGER;
  ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS trial_used INTEGER NOT NULL DEFAULT 0;

  -- Google Play Billing (added Oct 2026). Where the current plan came from:
  -- NULL = trial / dev, 'google_play' = a Play subscription
  ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS source TEXT;
  ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS auto_renew INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS google_purchase_token TEXT;

  -- One row per Google Play purchase token (the latest state Google told us).
  -- purchase_token is the PRIMARY KEY, so one token can only belong to ONE user.
  -- user_id is NULL when Google told us about a token (RTDN) before the app did.
  CREATE TABLE IF NOT EXISTS google_play_purchases (
    purchase_token        TEXT PRIMARY KEY,
    user_id               INTEGER REFERENCES users(id) ON DELETE SET NULL,
    product_id            TEXT NOT NULL,          -- raphai_pro | raphai_elite
    base_plan_id          TEXT,                   -- monthly | yearly
    offer_id              TEXT,                   -- e.g. the free-trial offer id
    plan                  TEXT NOT NULL,          -- pro | elite
    period                TEXT,                   -- monthly | yearly
    subscription_state    TEXT NOT NULL,          -- SUBSCRIPTION_STATE_ACTIVE, ..._EXPIRED, ...
    expires_at            TIMESTAMPTZ,
    auto_renew            INTEGER NOT NULL DEFAULT 0,
    in_trial              INTEGER NOT NULL DEFAULT 0,
    acknowledged          INTEGER NOT NULL DEFAULT 0,
    linked_purchase_token TEXT,                   -- the older token this one replaced
    superseded_by         TEXT,                   -- set when a newer token replaced this one
    revoked_at            TIMESTAMPTZ,            -- set on a refund/revoke: this token never gives access again
    latest_order_id       TEXT,
    test_purchase         INTEGER NOT NULL DEFAULT 0,
    raw                   JSONB,                  -- Google's full answer (for debugging)
    created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  ALTER TABLE google_play_purchases ADD COLUMN IF NOT EXISTS revoked_at TIMESTAMPTZ;
  CREATE INDEX IF NOT EXISTS google_play_purchases_user ON google_play_purchases (user_id);

  -- ---------------- RAPHAI INTELLIGENCE (v2, Oct 2026) ----------------
  -- Sleep can be imported from Health Connect. source NULL = typed in by the user.
  ALTER TABLE sleep_logs ADD COLUMN IF NOT EXISTS source TEXT;

  -- Daily activity from the phone (Health Connect or the pedometer). One row per user per day.
  CREATE TABLE IF NOT EXISTS activity_daily (
    user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    date           TEXT NOT NULL,
    steps          INTEGER,
    distance_m     DOUBLE PRECISION,
    active_kcal    DOUBLE PRECISION,
    active_minutes INTEGER,
    resting_hr     INTEGER,
    source         TEXT,           -- health_connect | pedometer
    updated_at     TEXT NOT NULL DEFAULT ${NOW_TEXT},
    PRIMARY KEY (user_id, date)
  );

  -- RaphScore saved per day, so we can explain how it changed vs yesterday.
  -- overall is NULL when there was not enough data that day.
  CREATE TABLE IF NOT EXISTS raphscore_daily (
    user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    date        TEXT NOT NULL,
    overall     INTEGER,
    areas       JSONB NOT NULL DEFAULT '{}'::jsonb,  -- { "health": 72, "fitness": null, ... }
    computed_at TEXT NOT NULL DEFAULT ${NOW_TEXT},
    PRIMARY KEY (user_id, date)
  );

  -- How often a user used a limited feature on a day (e.g. AI food parse: 5 a day on Free)
  CREATE TABLE IF NOT EXISTS feature_usage (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    date    TEXT NOT NULL,
    feature TEXT NOT NULL,
    count   INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, date, feature)
  );

  -- ---------------- PRIVACY (Oct 2026) ----------------
  -- Consent records: what the user agreed to, which version, yes/no, when.
  -- One row per change (latest row per type = current choice).
  -- No foreign key on purpose: the Privacy Policy keeps consent records for
  -- 1 year AFTER the account is deleted. account_deleted_at is set when the
  -- account goes, and the daily purge removes them a year later.
  CREATE TABLE IF NOT EXISTS consents (
    id                 INTEGER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    user_id            INTEGER NOT NULL,
    type               TEXT NOT NULL,   -- terms_privacy | health_connect | background_health | ads_personalised | gemini
    version            TEXT NOT NULL,
    granted            BOOLEAN NOT NULL,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    account_deleted_at TIMESTAMPTZ
  );
  CREATE INDEX IF NOT EXISTS consents_user ON consents (user_id, type, created_at);

  -- Security logs (kept 1 year, in this database = Mumbai, India).
  -- user_id has no foreign key so the log survives account deletion.
  CREATE TABLE IF NOT EXISTS security_logs (
    id         BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    user_id    INTEGER,
    event      TEXT NOT NULL,   -- login_success | login_failed | password_change | account_deleted | export
    ip         TEXT,
    user_agent TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS security_logs_created ON security_logs (created_at);

  -- Last time the user used the app (updated at most once a day by requireAuth).
  -- Recorded only: inactive accounts are NOT deleted automatically yet.
  ALTER TABLE users ADD COLUMN IF NOT EXISTS last_active_at TIMESTAMPTZ;

  -- Indexes that make the common "my rows for this date" lookups fast
  CREATE INDEX IF NOT EXISTS food_logs_user_date ON food_logs (user_id, date);
  CREATE INDEX IF NOT EXISTS workouts_user_date ON workouts (user_id, date);
  CREATE INDEX IF NOT EXISTS water_logs_user_date ON water_logs (user_id, date);
  CREATE INDEX IF NOT EXISTS sleep_logs_user_date ON sleep_logs (user_id, date);
  CREATE INDEX IF NOT EXISTS mood_logs_user_date ON mood_logs (user_id, date);
  CREATE INDEX IF NOT EXISTS weight_logs_user_date ON weight_logs (user_id, date);
  CREATE INDEX IF NOT EXISTS expenses_user_date ON expenses (user_id, date);
  CREATE INDEX IF NOT EXISTS step_logs_user_date ON step_logs (user_id, date);
`;

// ------------------------------------------------------------
// init(): create tables + put the Indian foods in. Safe to run on every
// start. server.js calls it BEFORE the server starts listening.
// ------------------------------------------------------------
async function init() {
  const schema = schemaName();
  if (schema) await db.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);

  await db.tx(async (t) => {
    // If two copies of the server start at once, only one sets up at a time
    await t.query('SELECT pg_advisory_xact_lock(4242001)');
    await t.query(SCHEMA_SQL);

    // Add the seed foods that are not there yet (by name).
    // "WHERE NOT EXISTS" skips foods we already have, so restarting the
    // server does not use up id numbers; ON CONFLICT is a final safety net.
    const values = [];
    const rows = foods.map((f, i) => {
      values.push(f.name, f.serving, f.kcal, f.protein_g, f.carbs_g, f.fat_g);
      const b = i * 6;
      return `($${b + 1}::text, $${b + 2}::text, $${b + 3}::float8, $${b + 4}::float8, $${b + 5}::float8, $${b + 6}::float8, ${i})`;
    });
    await t.query(
      `INSERT INTO foods (name, serving, kcal, protein_g, carbs_g, fat_g)
       SELECT v.name, v.serving, v.kcal, v.protein_g, v.carbs_g, v.fat_g
       FROM (VALUES ${rows.join(', ')}) AS v(name, serving, kcal, protein_g, carbs_g, fat_g, pos)
       WHERE NOT EXISTS (SELECT 1 FROM foods f WHERE f.name = v.name)
       ORDER BY v.pos
       ON CONFLICT (name) DO NOTHING`,
      values,
    );
    // Every seeded food is "Verified" (values checked against standard tables)
    await t.query('UPDATE foods SET verified = 1 WHERE name = ANY($1) AND verified <> 1', [foods.map((f) => f.name)]);
  });
}

module.exports = db;
