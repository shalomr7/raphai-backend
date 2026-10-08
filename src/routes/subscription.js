// routes/subscription.js
// ------------------------------------------------------------
// Plans and payments.
//   GET  /api/plans                      (public) list plans + prices
//   GET  /api/subscription               your current plan
//   POST /api/subscription/order         start a payment (Razorpay order)
//   POST /api/subscription/verify        app sends Razorpay's reply after paying
//   POST /api/subscription/cancel        go back to Free at the end (simple version: now)
//   POST /api/subscription/trial         start the 14-day free Pro trial (once per account)
//   POST /api/subscription/dev-activate  DEVELOPMENT ONLY: turn on a plan without paying
//   POST /api/webhooks/razorpay          (public) Razorpay calls this when money arrives
//
// ************************************************************
// *  RAZORPAY STUB — READ THIS                                 *
// *  - If RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET are empty,   *
// *    we make a FAKE order (id starts with "order_stub_").    *
// *    Nothing is charged. Good for building the app.          *
// *  - If the keys are set, we create a REAL order by calling  *
// *    Razorpay's Orders API.                                  *
// *  - Signatures are checked with HMAC-SHA256, exactly as     *
// *    Razorpay documents. Test with Razorpay TEST keys first. *
// *  - Before going live: use HTTPS, set NODE_ENV=production,  *
// *    add the webhook in the Razorpay dashboard.              *
// ************************************************************
// ------------------------------------------------------------

const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const { PLANS, TRIAL_DAYS } = require('../utils/plans');
const { currentPlan } = require('../middleware/requirePlan');
const { validate, asyncHandler, HttpError } = require('../utils/http');

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
  if (period === 'yearly') end.setFullYear(end.getFullYear() + 1);
  else end.setMonth(end.getMonth() + 1);

  await q.run(`INSERT INTO subscriptions (user_id, plan, period, status, expires_at) VALUES ($1, $2, $3, 'active', $4)
    ON CONFLICT (user_id) DO UPDATE SET plan = excluded.plan, period = excluded.period, status = 'active', expires_at = excluded.expires_at`,
    [userId, plan, period, end.toISOString()]);
}

// Mark a payment as paid and turn the plan on, as ONE transaction.
// "status <> 'paid'" + FOR UPDATE makes sure the plan is only added once,
// even if /verify and the webhook arrive at the same moment.
async function markPaidAndActivate(paymentId, razorpayPaymentId) {
  await db.tx(async (t) => {
    const p = await t.get('SELECT * FROM payments WHERE id = $1 FOR UPDATE', [paymentId]);
    if (!p || p.status === 'paid') return;
    await t.run("UPDATE payments SET status = 'paid', payment_id = $1 WHERE id = $2", [razorpayPaymentId, p.id]);
    await activatePlan(p.user_id, p.plan, p.period, t);
  });
}

async function subscriptionStatus(userId) {
  const sub = await db.get('SELECT plan, period, status, expires_at, trial_used FROM subscriptions WHERE user_id = $1', [userId]);
  const active = await currentPlan(userId);
  return {
    ...sub,
    trial_used: Boolean(sub && sub.trial_used),
    on_trial: Boolean(sub && sub.period === 'trial' && active !== 'free'),
    trial_days: TRIAL_DAYS,
    active_plan: active,
    active_plan_name: PLANS[active].name,
  };
}

// HMAC-SHA256 signature, compared in a way that doesn't leak timing info
function hmac(secret, text) {
  return crypto.createHmac('sha256', secret).update(text).digest('hex');
}
function safeEqual(a, b) {
  const x = Buffer.from(String(a)); const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

const keysConfigured = () => Boolean(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET);

// ---------- public: plans ----------
const plansRouter = express.Router();
plansRouter.get('/', (req, res) => {
  res.json({
    currency: 'INR',
    trial_days: TRIAL_DAYS, // free trial of Pro for new users
    best_value_period: 'yearly',
    plans: Object.values(PLANS).map((p) => ({
      id: p.id,
      name: p.name,
      price_monthly: p.prices.monthly,
      price_yearly: p.prices.yearly,
      // how much cheaper yearly is compared to 12 monthly payments
      yearly_saving: p.prices.monthly * 12 - p.prices.yearly,
      features: p.features,
    })),
  });
});

// ---------- logged in: subscription ----------
const subRouter = express.Router();

subRouter.get('/', asyncHandler(async (req, res) => {
  res.json({ subscription: await subscriptionStatus(req.user.id) });
}));

const ORDER_RULES = {
  plan: { type: 'string', required: true, oneOf: ['pro', 'elite'] },
  period: { type: 'string', required: true, oneOf: ['monthly', 'yearly'] },
};

// Step 1: the app asks us to create an order. We return the order id,
// and the app opens Razorpay Checkout with it.
subRouter.post('/order', asyncHandler(async (req, res) => {
  const b = validate(req.body, ORDER_RULES);
  const amountPaise = PLANS[b.plan].prices[b.period] * 100; // Razorpay uses paise (₹1 = 100 paise)
  const receipt = `rcpt_${req.user.id}_${Date.now()}`;
  let order;

  if (keysConfigured()) {
    // REAL order via Razorpay Orders API (no SDK needed, just fetch)
    const auth = Buffer.from(`${process.env.RAZORPAY_KEY_ID}:${process.env.RAZORPAY_KEY_SECRET}`).toString('base64');
    const r = await fetch('https://api.razorpay.com/v1/orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Basic ${auth}` },
      body: JSON.stringify({
        amount: amountPaise,
        currency: 'INR',
        receipt,
        notes: { user_id: String(req.user.id), plan: b.plan, period: b.period },
      }),
    });
    if (!r.ok) throw new HttpError(502, `Razorpay error: ${await r.text()}`);
    order = await r.json();
  } else {
    // STUB order (no keys) — nothing is charged
    order = { id: `order_stub_${crypto.randomBytes(6).toString('hex')}`, amount: amountPaise, currency: 'INR', receipt, stub: true };
  }

  await db.run('INSERT INTO payments (user_id, order_id, plan, period, amount_paise) VALUES ($1, $2, $3, $4, $5)',
    [req.user.id, order.id, b.plan, b.period, amountPaise]);

  res.status(201).json({
    order_id: order.id,
    amount_paise: amountPaise,
    currency: 'INR',
    key_id: process.env.RAZORPAY_KEY_ID || null, // the app needs this public key for Checkout
    stub: !keysConfigured(),
    plan: b.plan,
    period: b.period,
  });
}));

// Step 2: after paying, Razorpay Checkout gives the app 3 values.
// The app sends them here. We check the signature:
//   signature == HMAC_SHA256(order_id + "|" + payment_id, KEY_SECRET)
subRouter.post('/verify', asyncHandler(async (req, res) => {
  const b = validate(req.body, {
    razorpay_order_id: { type: 'string', required: true },
    razorpay_payment_id: { type: 'string', required: true },
    razorpay_signature: { type: 'string', required: true },
  });
  if (!keysConfigured()) throw new HttpError(400, 'Razorpay keys are not set (stub mode). Use /dev-activate in development.');

  const payment = await db.get('SELECT * FROM payments WHERE order_id = $1 AND user_id = $2', [b.razorpay_order_id, req.user.id]);
  if (!payment) throw new HttpError(404, 'Order not found');

  const expected = hmac(process.env.RAZORPAY_KEY_SECRET, `${b.razorpay_order_id}|${b.razorpay_payment_id}`);
  if (!safeEqual(expected, b.razorpay_signature)) throw new HttpError(400, 'Payment signature is not valid');

  if (payment.status !== 'paid') {
    await markPaidAndActivate(payment.id, b.razorpay_payment_id);
  }
  res.json({ subscription: await subscriptionStatus(req.user.id) });
}));

subRouter.post('/cancel', asyncHandler(async (req, res) => {
  // Simple version: switch back to Free right away.
  await db.run("UPDATE subscriptions SET plan = 'free', period = NULL, expires_at = NULL, status = 'active' WHERE user_id = $1", [req.user.id]);
  res.json({ subscription: await subscriptionStatus(req.user.id) });
}));

// Free trial: Pro for TRIAL_DAYS days, no payment, once per account.
subRouter.post('/trial', asyncHandler(async (req, res) => {
  const sub = await db.get('SELECT * FROM subscriptions WHERE user_id = $1', [req.user.id]);
  if (sub && sub.trial_used) throw new HttpError(409, 'You have already used your free trial');
  if ((await currentPlan(req.user.id)) !== 'free') throw new HttpError(409, 'You already have a paid plan');
  const end = new Date(Date.now() + TRIAL_DAYS * 86400000);
  await db.run(`UPDATE subscriptions SET plan = 'pro', period = 'trial', status = 'active', expires_at = $1, trial_used = 1
    WHERE user_id = $2`, [end.toISOString(), req.user.id]);
  res.json({ subscription: await subscriptionStatus(req.user.id), note: `Pro trial started for ${TRIAL_DAYS} days` });
}));

// DEVELOPMENT ONLY — lets you test Pro/Elite features without paying.
subRouter.post('/dev-activate', asyncHandler(async (req, res) => {
  if (process.env.NODE_ENV === 'production') throw new HttpError(403, 'Not available in production');
  const b = validate(req.body, ORDER_RULES);
  await activatePlan(req.user.id, b.plan, b.period);
  res.json({ subscription: await subscriptionStatus(req.user.id), note: 'Activated without payment (development mode)' });
}));

// ---------- public: Razorpay webhook ----------
// Razorpay sends a POST with header "X-Razorpay-Signature".
//   signature == HMAC_SHA256(raw request body, WEBHOOK_SECRET)
// IMPORTANT: we need the RAW body (exact bytes), so app.js uses
// express.raw() for this one route instead of express.json().
const webhookRouter = express.Router();
webhookRouter.post('/razorpay', asyncHandler(async (req, res) => {
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
  if (!secret) throw new HttpError(503, 'RAZORPAY_WEBHOOK_SECRET is not set');

  const raw = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';
  const signature = req.headers['x-razorpay-signature'];
  if (!signature || !safeEqual(hmac(secret, raw), signature)) {
    throw new HttpError(400, 'Invalid webhook signature');
  }

  let event;
  try { event = JSON.parse(raw); } catch { throw new HttpError(400, 'Webhook body is not JSON'); }

  // We care about "payment.captured" (money received) and "order.paid"
  if (event.event === 'payment.captured' || event.event === 'order.paid') {
    const entity = (event.payload && event.payload.payment && event.payload.payment.entity) || {};
    const orderId = entity.order_id || (event.payload && event.payload.order && event.payload.order.entity.id);
    const payment = orderId && (await db.get('SELECT * FROM payments WHERE order_id = $1', [orderId]));
    if (payment && payment.status !== 'paid') {
      await markPaidAndActivate(payment.id, entity.id || null);
    }
  }
  if (event.event === 'payment.failed') {
    const orderId = event.payload && event.payload.payment && event.payload.payment.entity.order_id;
    if (orderId) await db.run("UPDATE payments SET status = 'failed' WHERE order_id = $1 AND status = 'created'", [orderId]);
  }

  // Always answer 200 quickly so Razorpay doesn't retry
  res.json({ ok: true });
}));

module.exports = { plansRouter, subRouter, webhookRouter };
