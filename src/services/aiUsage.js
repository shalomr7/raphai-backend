// services/aiUsage.js
// ------------------------------------------------------------
// AI metering and the global spend cap (migration 015).
//
//   record({ userId, feature, model, usage, images, status, latencyMs })
//     Writes one ai_usage row. `usage` is Gemini's usageMetadata
//     (promptTokenCount, candidatesTokenCount, thoughtsTokenCount). The cost
//     is ESTIMATED at the paid-tier list price in model_prices (even while the
//     key is on the free tier) and converted with app_config.usd_inr_rate.
//     Never throws: metering must not break a user request.
//
//   budgetStatus() -> { ok, spent_inr, budget_inr }
//     This calendar month's (Asia/Kolkata) estimated spend against
//     app_config.ai_monthly_budget_inr. Called before every AI call.
// ------------------------------------------------------------

const db = require('../db');
const appConfig = require('./appConfig');

const FEATURES = new Set(['coach', 'food_photo', 'food_parse_ai']);
const STATUSES = new Set(['ok', 'fallback', 'error', 'timeout', 'blocked_quota', 'blocked_budget']);

// Output tokens billed = candidates + thinking ("output price including thinking tokens")
function tokensFrom(usage) {
  const u = usage || {};
  const n = (x) => (Number.isFinite(Number(x)) ? Math.max(0, Math.round(Number(x))) : 0);
  return {
    input: n(u.promptTokenCount),
    output: n(u.candidatesTokenCount) + n(u.thoughtsTokenCount),
  };
}

// Add two usageMetadata objects (a coach question can take several rounds)
function addUsage(a, b) {
  if (!b) return a || null;
  const out = { ...(a || {}) };
  for (const k of ['promptTokenCount', 'candidatesTokenCount', 'thoughtsTokenCount', 'totalTokenCount']) {
    out[k] = (Number(out[k]) || 0) + (Number(b[k]) || 0);
  }
  return out;
}

async function priceFor(model, day) {
  try {
    return await db.get(`SELECT input_per_1m, output_per_1m, per_image, currency, verified FROM model_prices
      WHERE model = $1 AND (effective_from IS NULL OR effective_from <= $2::date) AND (effective_to IS NULL OR effective_to >= $2::date)
      ORDER BY effective_from DESC NULLS LAST LIMIT 1`, [model, day]);
  } catch (e) {
    if (e.code === '42P01') return null;
    throw e;
  }
}

// Estimated cost in rupees. Unknown/unverified price -> 0 (and the row still records tokens).
async function estimateInr(model, input, output, images = 0, now = new Date()) {
  if (!model) return 0;
  const p = await priceFor(model, now.toISOString().slice(0, 10));
  if (!p || !p.verified) return 0;
  const rate = Number(await appConfig.get('usd_inr_rate', 0)) || 0;
  let usd = (input / 1e6) * Number(p.input_per_1m || 0) + (output / 1e6) * Number(p.output_per_1m || 0);
  if (p.per_image != null) usd += images * Number(p.per_image);
  const inr = p.currency === 'INR' ? usd : usd * rate;
  return Math.round(inr * 10000) / 10000;
}

async function record({ userId = null, feature, model = null, usage = null, images = 0, status, latencyMs = null }) {
  try {
    if (!FEATURES.has(feature) || !STATUSES.has(status)) throw new Error(`bad ai_usage row ${feature}/${status}`);
    const t = tokensFrom(usage);
    const cost = await estimateInr(model, t.input, t.output, images);
    await db.run(`INSERT INTO ai_usage (user_id, feature, model, input_tokens, output_tokens, images, est_cost_inr, status, latency_ms)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [userId, feature, model, t.input, t.output, images, cost, status, latencyMs == null ? null : Math.round(latencyMs)]);
  } catch (e) {
    console.warn('ai_usage not recorded:', String(e.code || e.message).slice(0, 120));
  }
}

// Start of this month in Asia/Kolkata, as a timestamptz
async function budgetStatus() {
  const budget = Number(await appConfig.get('ai_monthly_budget_inr', Number(process.env.AI_MONTHLY_BUDGET_INR) || 1000));
  let spent = 0;
  try {
    const row = await db.get(`SELECT COALESCE(SUM(est_cost_inr), 0) AS s FROM ai_usage
      WHERE created_at >= (date_trunc('month', now() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata')`);
    spent = Number(row.s) || 0;
  } catch (e) {
    if (e.code !== '42P01') throw e;
  }
  // A budget of 0 = no AI spend allowed (kill switch)
  const ok = budget > 0 && spent < budget;
  return { ok, spent_inr: Math.round(spent * 100) / 100, budget_inr: budget };
}

module.exports = { record, budgetStatus, estimateInr, tokensFrom, addUsage };
