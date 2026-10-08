// middleware/requirePlan.js
// ------------------------------------------------------------
// requirePlan('pro') blocks users whose plan is lower than Pro.
// Elite users pass too, because Elite includes everything in Pro.
// Use it AFTER requireAuth:
//   router.get('/x', requireAuth, requirePlan('pro'), handler)
// ------------------------------------------------------------

const db = require('../db');
const { PLANS, LIMITS } = require('../utils/plans');
const { HttpError } = require('../utils/http');

// Find the user's CURRENT plan. An expired paid plan counts as 'free'.
async function currentPlan(userId) {
  const sub = await db.get('SELECT * FROM subscriptions WHERE user_id = $1', [userId]);
  if (!sub || sub.plan === 'free') return 'free';
  if (sub.status !== 'active') return 'free';
  if (sub.expires_at && new Date(sub.expires_at) < new Date()) return 'free';
  return sub.plan;
}

// true if the user's plan is at least minPlan (e.g. await hasPlan(id, 'pro'))
async function hasPlan(userId, minPlan) {
  return PLANS[await currentPlan(userId)].rank >= PLANS[minPlan].rank;
}

function requirePlan(minPlan) {
  const needed = PLANS[minPlan];
  if (!needed) throw new Error(`Unknown plan: ${minPlan}`);

  return (req, res, next) => {
    currentPlan(req.user.id).then((plan) => {
      if (PLANS[plan].rank >= needed.rank) return next();
      // 402 = "Payment Required"
      next(upgradeError(`This feature needs the ${needed.name} plan or higher. You are on ${PLANS[plan].name}.`, { plan, upgradeTo: minPlan }));
    }, next);
  };
}

// The user's plan id and its daily limits (utils/plans.js LIMITS)
async function planAndLimits(userId) {
  const plan = await currentPlan(userId);
  return { plan, limits: LIMITS[plan] };
}

// A 402 "Payment Required" error that also tells the app which plan to offer:
//   { error, current_plan, upgrade_to, upgrade_to_name, limit? }
function upgradeError(message, { plan = null, upgradeTo = null, limit } = {}) {
  const e = new HttpError(402, message);
  e.extra = {
    current_plan: plan,
    upgrade_to: upgradeTo,
    upgrade_to_name: upgradeTo ? PLANS[upgradeTo].name : null,
    ...(limit !== undefined ? { limit } : {}),
  };
  return e;
}

module.exports = { requirePlan, currentPlan, hasPlan, planAndLimits, upgradeError };
