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
    // DATABASE_SSL_CA (PEM text, or base64 of it) turns on full certificate
    // checking against Supabase's CA (download it from Project Settings ->
    // Database -> SSL). Without it the link is encrypted but the server
    // certificate is not verified (the old behaviour).
    ssl: sslOff ? false : sslConfig(),
    max: Number(process.env.PG_POOL_MAX) || 5,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 15000,
  };
}

function sslConfig() {
  const raw = (process.env.DATABASE_SSL_CA || '').trim();
  if (!raw) return { rejectUnauthorized: false };
  const ca = raw.includes('BEGIN CERTIFICATE') ? raw : Buffer.from(raw, 'base64').toString('utf8');
  return { rejectUnauthorized: true, ca };
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

const MIGRATIONS = require('./migrations');
let lastApplied = [];
// Which migrations the last init() applied (server.js logs it)
db.appliedMigrations = () => lastApplied.slice();

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
    // Versioned migrations (src/migrations/index.js): apply the ones not yet recorded
    await t.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      id         TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
    const done = new Set((await t.all('SELECT id FROM schema_migrations')).map((r) => r.id));
    const applied = [];
    for (const m of MIGRATIONS) {
      if (done.has(m.id)) continue;
      await t.query(m.sql);
      await t.run('INSERT INTO schema_migrations (id) VALUES ($1)', [m.id]);
      applied.push(m.id);
    }
    lastApplied = applied;

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
