// services/appConfig.js
// ------------------------------------------------------------
// Read settings from the app_config table (migration 015), with a short
// in-memory cache. A missing table or key falls back to the default given,
// so a rolled-back schema never crashes a request.
//   await appConfig.get('ai_monthly_budget_inr', 1000)
// ------------------------------------------------------------

const db = require('../db');

const TTL_MS = Number(process.env.APP_CONFIG_TTL_MS ?? 30000);
let cache = null; // { at, values: Map }

async function load() {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.values;
  const values = new Map();
  try {
    for (const r of await db.all('SELECT key, value FROM app_config')) values.set(r.key, r.value);
  } catch (e) {
    if (e.code !== '42P01') throw e; // undefined_table -> defaults only
  }
  cache = { at: Date.now(), values };
  return values;
}

async function get(key, fallback = null) {
  const v = (await load()).get(key);
  return v === undefined || v === null ? fallback : v;
}

// Write a value (admin tooling / tests). Clears the cache.
async function set(key, value, note) {
  await db.run(`INSERT INTO app_config (key, value, note) VALUES ($1, $2::jsonb, $3)
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, note = COALESCE(EXCLUDED.note, app_config.note), updated_at = now()`,
  [key, JSON.stringify(value), note || null]);
  clearCache();
}

function clearCache() { cache = null; }

module.exports = { get, set, clearCache };
