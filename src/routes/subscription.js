// routes/subscription.js
// ------------------------------------------------------------
// Plans and payments.
//   GET  /api/plans                      (public) list plans + prices
//   GET  /api/subscription               your current plan
//   POST /api/subscription/cancel        go back to Free at the end (simple version: now)
//   POST /api/subscription/trial         start the 14-day free Pro trial (once per account)
//   POST /api/subscription/dev-activate  DEVELOPMENT ONLY: turn on a plan without paying
//   POST /api/subscription/google/verify (see routes/googlePlay.js) Google Play purchase check
//   POST /api/subscription/google/rtdn   (see routes/googlePlay.js) Google Play notifications
//
// Payments go through GOOGLE PLAY BILLING only (routes/googlePlay.js).
// (The old payment-order stub was removed in Oct 2026. Its "payments" table is
// left in the database untouched, but nothing uses it.)
// ------------------------------------------------------------

const express = require('express');
const db = require('../db');
const {
  PLANS, PLAN_ORDER, TRIAL_DAYS, BASE_PLANS, GOOGLE_BASE_PLANS, OFFERS, FEATURE_TIERS, productIdFor, yearlySavingPercent,
} = require('../utils/plans');
const { currentPlan } = require('../middleware/requirePlan');
const { validate, asyncHandler, HttpError } = require('../utils/http');
const play = require('../services/googlePlay');
const { setStatusFn } = require('./googlePlay');

// ---------- helpers ----------

// Turn on a plan for a user. If they already have it, add time on top.
// "q" is db, or "t" inside a transaction.
async function activatePlan(userId, plan, period, q = db) {
  const sub = await q.get('SELECT * FROM subscriptions WHERE user_id = $1', [userId]);
  let start = new Date();
  if (sub && sub.plan === plan && sub.expires_at && new Date(sub.expires_at) > start) {
    start = new Date(sub.expires_at); // extend the existing plan
  }
  const end = new Date(start);
  const months = (Object.values(BASE_PLANS).find((b) => b.period === period) || { months: 1 }).months;
  end.setMonth(end.getMonth() + months);

  await q.run(`INSERT INTO subscriptions (user_id, plan, period, status, expires_at, source) VALUES ($1, $2, $3, 'active', $4, NULL)
    ON CONFLICT (user_id) DO UPDATE SET plan = excluded.plan, period = excluded.period, status = 'active', expires_at = excluded.expires_at, source = NULL`,
    [userId, plan, period, end.toISOString()]);
}

// Google Play subscriptions page for our app (the app opens this to
// let people cancel or change plan)
function playManageUrl(productId) {
  const pkg = play.packageName() || 'com.raphai.app';
  return productId
    ? `https://play.google.com/store/account/subscriptions?sku=${encodeURIComponent(productId)}&package=${encodeURIComponent(pkg)}`
    : 'https://play.google.com/store/account/subscriptions';
}

// If a Google Play plan looks expired, ask Google once more before
// switching the user to Free (in case we missed a "renewed" notification).
async function recheckExpiredGoogle(userId) {
  const sub = await db.get('SELECT source, expires_at, google_purchase_token FROM subscriptions WHERE user_id = $1', [userId]);
  if (!sub || sub.source !== 'google_play' || !sub.google_purchase_token) return;
  if (!sub.expires_at || new Date(sub.expires_at) > new Date()) return;
  if (!play.isConfigured()) return;
  try {
    await play.refreshToken(sub.google_purchase_token);
  } catch (e) {
    console.warn('Google Play re-check failed:', e.message);
  }
  // Still expired after asking Google? Write it down so we don't ask every time.
  await play.recomputeEntitlement(userId);
}

async function subscriptionStatus(userId) {
  const sub = await db.get(`SELECT plan, period, status, expires_at, trial_used, source, auto_renew, google_purchase_token
    FROM subscriptions WHERE user_id = $1`, [userId]);
  const active = await currentPlan(userId);
  let google = null;
  if (sub && sub.google_purchase_token) {
    google = await db.get(`SELECT product_id, base_plan_id, offer_id, subscription_state, expires_at, auto_renew, in_trial
      FROM google_play_purchases WHERE purchase_token = $1`, [sub.google_purchase_token]);
  }
  const { google_purchase_token: _hidden, ...pub } = sub || {};
  return {
    ...pub,
    source: (sub && sub.source) || null,
    auto_renew: Boolean(sub && sub.auto_renew),
    trial_used: Boolean(sub && sub.trial_used),
    on_trial: Boolean(sub && sub.period === 'trial' && active !== 'free'),
    trial_days: TRIAL_DAYS,
    active_plan: active,
    active_plan_name: PLANS[active].name,
    // The app passes this to Google when buying (obfuscatedAccountId)
    play_account_id: play.playAccountId(userId),
    google_play: google ? {
      product_id: google.product_id,
      base_plan_id: google.base_plan_id,
      state: google.subscription_state,
      expires_at: google.expires_at ? new Date(google.expires_at).toISOString() : null,
      auto_renew: Boolean(google.auto_renew),
      prepaid: Boolean(BASE_PLANS[google.base_plan_id] && !BASE_PLANS[google.base_plan_id].auto_renew),
      in_trial: Boolean(google.in_trial),
      manage_url: playManageUrl(google.product_id),
    } : null,
    manage_url: playManageUrl(google && google.product_id),
  };
}
setStatusFn(subscriptionStatus);

// ---------- public: plans ----------
const plansRouter = express.Router();
plansRouter.get('/', (req, res) => {
  res.json({
    currency: 'INR',
    prices_include_tax: true, // Play India prices include GST
    // Server-side Pro trial length; Play trials are offers (see base_plans[].trial_days)
    trial_days: TRIAL_DAYS,
    best_value_period: 'yearly',
    best_value: { plan: 'pro', base_plan_id: 'yearly' },
    google_play: {
      package_name: play.packageName() || 'com.raphai.app',
      billing_configured: play.isConfigured(),
      base_plan_ids: Object.keys(BASE_PLANS),
    },
    // Play offers (trials, launch price, win-back)
    offers: Object.entries(OFFERS).map(([id, o]) => ({ id, ...o })),
    feature_tiers: FEATURE_TIERS,
    plans: PLAN_ORDER.map((id) => PLANS[id]).map((p) => {
      const productId = productIdFor(p.id);
      return {
        id: p.id,
        name: p.name,
        rank: p.rank,
        tagline: p.tagline,
        // kept for older app versions
        price_monthly: p.prices.monthly,
        price_yearly: p.prices.yearly,
        yearly_saving: p.prices.monthly * 12 - p.prices.yearly,
        // all prices by Play base plan id
        prices: { ...p.prices },
        price_quarterly: p.prices.quarterly,
        price_monthly_prepaid: p.prices['monthly-prepaid'],
        yearly_saving_percent: yearlySavingPercent(p.id),
        google_product_id: productId,
        base_plans: productId ? Object.entries(BASE_PLANS).map(([bpId, bp]) => ({
          id: bpId,
          period: bp.period,
          months: bp.months,
          billing_period: bp.billing_period,
          auto_renew: bp.auto_renew,
          price: p.prices[bpId],
          trial_offer_id: bp.trial_offer,
          trial_days: bp.trial_days,
          offers: Object.entries(OFFERS).filter(([, o]) => o.products.includes(productId) && o.base_plans.includes(bpId)).map(([oid]) => oid),
        })) : [],
        limits: p.limits,
        features: p.features,
        coming_soon: p.id === 'elite' ? ['family_members'] : [],
      };
    }),
  });
});

// ---------- logged in: subscription ----------
const subRouter = express.Router();

subRouter.get('/', asyncHandler(async (req, res) => {
  await recheckExpiredGoogle(req.user.id);
  res.json({ subscription: await subscriptionStatus(req.user.id) });
}));

// Plan + period, used by /dev-activate
const PLAN_RULES = {
  plan: { type: 'string', required: true, oneOf: ['plus', 'pro', 'elite'] },
  // a period or a Play base plan id ("monthly-prepaid" -> "monthly_prepaid")
  period: { type: 'string', required: true, oneOf: [...new Set([...Object.keys(GOOGLE_BASE_PLANS), ...Object.values(GOOGLE_BASE_PLANS)])] },
};

subRouter.post('/cancel', asyncHandler(async (req, res) => {
  // A Google Play subscription can only be cancelled in the Play Store
  const cur = await db.get('SELECT source FROM subscriptions WHERE user_id = $1', [req.user.id]);
  if (cur && cur.source === 'google_play' && (await currentPlan(req.user.id)) !== 'free') {
    throw new HttpError(409, 'This plan is billed by Google Play. Cancel it in the Play Store: Profile -> Payments & subscriptions -> Subscriptions.');
  }
  // Simple version: switch back to Free right away.
  await db.run("UPDATE subscriptions SET plan = 'free', period = NULL, expires_at = NULL, status = 'active', source = NULL WHERE user_id = $1", [req.user.id]);
  res.json({ subscription: await subscriptionStatus(req.user.id) });
}));

// Free trial: Pro for TRIAL_DAYS days, no payment, once per account.
subRouter.post('/trial', asyncHandler(async (req, res) => {
  const sub = await db.get('SELECT * FROM subscriptions WHERE user_id = $1', [req.user.id]);
  if (sub && sub.trial_used) throw new HttpError(409, 'You have already used your free trial');
  if ((await currentPlan(req.user.id)) !== 'free') throw new HttpError(409, 'You already have a paid plan');
  const end = new Date(Date.now() + TRIAL_DAYS * 86400000);
  await db.run(`UPDATE subscriptions SET plan = 'pro', period = 'trial', status = 'active', expires_at = $1, trial_used = 1, source = NULL
    WHERE user_id = $2`, [end.toISOString(), req.user.id]);
  res.json({ subscription: await subscriptionStatus(req.user.id), note: `Pro trial started for ${TRIAL_DAYS} days` });
}));

// DEVELOPMENT ONLY — lets you test Plus/Pro/Elite features without paying.
subRouter.post('/dev-activate', asyncHandler(async (req, res) => {
  // Allow-list, not deny-list: if NODE_ENV is missing or misspelt, it stays OFF.
  if (!['development', 'test'].includes(process.env.NODE_ENV)) throw new HttpError(403, 'Not available in production');
  const b = validate(req.body, PLAN_RULES);
  await activatePlan(req.user.id, b.plan, GOOGLE_BASE_PLANS[b.period] || b.period);
  res.json({ subscription: await subscriptionStatus(req.user.id), note: 'Activated without payment (development mode)' });
}));

module.exports = { plansRouter, subRouter, subscriptionStatus };
