// utils/plans.js
// ------------------------------------------------------------
// The subscription plans, in ONE place. Prices are in rupees (₹), as
// shown in Google Play India (GST included). Play is the source of truth
// for what a user actually pays; these numbers are the list prices the
// app shows when it cannot read prices from Play, and what /api/plans returns.
//
// Tiers (Oct 2026 pricing, see docs/pricing.md):
//   free  (rank 0)  ₹0
//   plus  (rank 1)  raphai_plus   ₹79 / ₹199 quarter / ₹599 year / ₹89 prepaid month
//   pro   (rank 2)  raphai_pro    ₹199 / ₹499 / ₹1,499 / ₹219
//   elite (rank 3)  raphai_elite  ₹349 / ₹899 / ₹2,499 / ₹379  (family of 3: coming soon)
// A higher rank includes everything in a lower rank.
//
// Old purchases stay valid: the server never checks the price paid, only
// the product id (raphai_pro -> pro, raphai_elite -> elite), so people who
// bought Pro at ₹99/₹799 keep Pro ("founding member" legacy price in Play).
//
// Feature -> lowest tier that has it (requirePlan / hasPlan use these):
// ------------------------------------------------------------

const FEATURE_TIERS = {
  body_fat: 'plus',            // body fat % (US Navy method)
  unlimited_budgets: 'plus',   // Free: 3 budgets a month
  unlimited_goals: 'plus',     // Free: 2 savings goals
  calculators: 'plus',         // SIP and EMI calculators
  hiit_plans: 'plus',          // HIIT workout plans (locked in the app)
  daily_brief: 'plus',         // daily brief (rule-based today; AI-written on Pro later)
  life_patterns: 'plus',       // /api/insights/patterns (basic patterns)
  pattern_profile: 'pro',      // /api/insights/profile "Your patterns" (full Life Graph)
  ai_coach: 'plus',            // Gemini coach answers (Plus: lite model, few a day)
  photo_scan: 'pro',           // AI photo food scan (not built yet)
  pdf_reports: 'pro',          // monthly PDF report (not built yet)
  family: 'elite',             // up to 3 family members (coming soon, not built)
};

// Daily limits per tier. null = no limit.
//  coach_per_day        rule-based coach questions (Free is blocked after this)
//  ai_coach_per_day     Gemini coach answers. After this the coach does NOT
//                       stop: it falls back to the rule-based coach.
//  ai_coach_model       the model those answers would use
//  food_parse_per_day   typed food parses ("2 rotis and dal")
//  photo_scan_per_day   AI photo food scans (feature not built yet; config only)
//  trend_days           longest /api/insights/trends window
//  family_members       people on one plan (Elite feature, coming soon)
const LIMITS = {
  free: {
    budgets_per_month: 3, savings_goals: 2, coach_per_day: 5, ai_coach_per_day: 0, ai_coach_model: null,
    food_parse_per_day: 5, photo_scan_per_day: 0, trend_days: 7, family_members: 1,
  },
  plus: {
    budgets_per_month: null, savings_goals: null, coach_per_day: null, ai_coach_per_day: 5, ai_coach_model: 'gemini-2.5-flash-lite',
    food_parse_per_day: 20, photo_scan_per_day: 0, trend_days: 30, family_members: 1,
  },
  pro: {
    budgets_per_month: null, savings_goals: null, coach_per_day: null, ai_coach_per_day: 15, ai_coach_model: 'gemini-2.5-flash',
    food_parse_per_day: 50, photo_scan_per_day: 5, trend_days: 365, family_members: 1,
  },
  elite: {
    budgets_per_month: null, savings_goals: null, coach_per_day: null, ai_coach_per_day: 25, ai_coach_model: 'gemini-2.5-flash',
    food_parse_per_day: 100, photo_scan_per_day: 6, trend_days: 365, family_members: 3,
  },
};

// Kept for older code and the app: the Free plan limits.
const FREE_LIMITS = LIMITS.free;

// Length of the server-side free trial of Pro (days). One trial per account.
// (Google Play trials are offers in Play Console: 7 days on monthly and
// quarterly, 14 days on yearly.)
const TRIAL_DAYS = 14;

// Google Play base plans (same ids on every product).
//   id -> { period we store, months, auto-renewing?, free trial offer days }
const BASE_PLANS = {
  monthly: { period: 'monthly', months: 1, auto_renew: true, trial_offer: 'trial-7d', trial_days: 7, billing_period: 'P1M' },
  quarterly: { period: 'quarterly', months: 3, auto_renew: true, trial_offer: 'trial-7d', trial_days: 7, billing_period: 'P3M' },
  yearly: { period: 'yearly', months: 12, auto_renew: true, trial_offer: 'trial-14d', trial_days: 14, billing_period: 'P1Y' },
  // Prepaid: pay once for a month, no auto-renew (for people who do not want
  // autopay). Play cannot attach offers/trials to prepaid plans.
  'monthly-prepaid': { period: 'monthly_prepaid', months: 1, auto_renew: false, trial_offer: null, trial_days: 0, billing_period: 'P1M' },
};

// Google Play base plan id -> our period
const GOOGLE_BASE_PLANS = Object.fromEntries(Object.entries(BASE_PLANS).map(([id, b]) => [id, b.period]));

// Play offers (set up in Play Console). Prices of discounted offers are
// set in Play; listed here for the app and the docs.
const OFFERS = {
  'trial-7d': { base_plans: ['monthly', 'quarterly'], products: ['raphai_plus', 'raphai_pro', 'raphai_elite'], eligibility: 'new_customer', description: '7 days free' },
  'trial-14d': { base_plans: ['yearly'], products: ['raphai_plus', 'raphai_pro', 'raphai_elite'], eligibility: 'new_customer', description: '14 days free' },
  'launch-y1': { base_plans: ['yearly'], products: ['raphai_pro'], eligibility: 'new_customer', description: 'First year ₹999, then ₹1,499 a year', first_year_price: 999 },
  'winback-3m': { base_plans: ['monthly'], products: ['raphai_plus', 'raphai_pro', 'raphai_elite'], eligibility: 'developer_determined', description: '50% off for 3 months (returning subscribers)', discount_percent: 50, months: 3 },
};

const PLANS = {
  free: {
    id: 'free',
    name: 'Free',
    rank: 0,
    prices: { monthly: 0, quarterly: 0, yearly: 0, 'monthly-prepaid': 0 },
    tagline: 'Track the basics',
    features: [
      'Calories, macros, water, steps, sleep, mood, weight',
      'BMI and daily targets',
      'Expenses, bills, bill reminders, 50/30/20 suggestion',
      `Up to ${LIMITS.free.budgets_per_month} budgets and ${LIMITS.free.savings_goals} savings goals`,
      'Daily RaphScore and streaks',
      "Today's insights, priorities and 7-day trends",
      `Raph coach (${LIMITS.free.coach_per_day} questions a day)`,
      `AI food parse (${LIMITS.free.food_parse_per_day} a day)`,
    ],
  },
  plus: {
    id: 'plus',
    name: 'Plus',
    rank: 1,
    prices: { monthly: 79, quarterly: 199, yearly: 599, 'monthly-prepaid': 89 },
    tagline: 'Full tracking, no ads',
    features: [
      'Everything in Free',
      'No ads',
      'Body fat % (US Navy method)',
      'Unlimited budgets and savings goals',
      'SIP and EMI calculators',
      'HIIT workout plans',
      'Unlimited Raph coach (rule-based)',
      `Quick AI answers (${LIMITS.plus.ai_coach_per_day} a day)`,
      `AI food parse (${LIMITS.plus.food_parse_per_day} a day)`,
      'Trends for 30 days',
      'Life patterns',
      'Daily brief',
    ],
  },
  pro: {
    id: 'pro',
    name: 'Pro',
    rank: 2,
    prices: { monthly: 199, quarterly: 499, yearly: 1499, 'monthly-prepaid': 219 },
    tagline: 'AI coach + photo food scan',
    features: [
      'Everything in Plus',
      'RaphAi Intelligence',
      `Raph AI coach (${LIMITS.pro.ai_coach_per_day} AI answers a day, then rule-based)`,
      `AI photo food scan (${LIMITS.pro.photo_scan_per_day} a day, coming soon)`,
      `AI food parse (${LIMITS.pro.food_parse_per_day} a day)`,
      'Trends for 365 days',
      'Your patterns (full Life Graph)',
      'Monthly PDF report (coming soon)',
    ],
  },
  elite: {
    id: 'elite',
    name: 'Elite',
    rank: 3,
    prices: { monthly: 349, quarterly: 899, yearly: 2499, 'monthly-prepaid': 379 },
    tagline: 'Power users and families',
    features: [
      'Everything in Pro',
      `Raph AI coach (${LIMITS.elite.ai_coach_per_day} AI answers a day, then rule-based)`,
      `AI photo food scan (${LIMITS.elite.photo_scan_per_day} a day, coming soon)`,
      `AI food parse (${LIMITS.elite.food_parse_per_day} a day)`,
      'Up to 3 family members (coming soon)',
      'Priority support',
      'Early access to new features',
    ],
  },
};
for (const id of Object.keys(PLANS)) PLANS[id].limits = LIMITS[id];

// Google Play Billing: subscription product id -> our plan id.
// Each product has the base plans in BASE_PLANS.
const GOOGLE_PRODUCTS = {
  raphai_plus: 'plus',
  raphai_pro: 'pro',
  raphai_elite: 'elite',
};
const productIdFor = (planId) => Object.keys(GOOGLE_PRODUCTS).find((k) => GOOGLE_PRODUCTS[k] === planId) || null;

const PLAN_ORDER = ['free', 'plus', 'pro', 'elite'];
// The next tier up (for "upgrade" messages). null on Elite.
function nextPlan(planId) {
  const i = PLAN_ORDER.indexOf(planId);
  return i >= 0 && i < PLAN_ORDER.length - 1 ? PLAN_ORDER[i + 1] : null;
}
// The lowest tier whose limit for "key" is higher than this tier's (null = unlimited counts as higher)
function nextPlanWithMore(planId, key) {
  const cur = LIMITS[planId][key];
  if (cur == null) return null;
  for (let i = PLAN_ORDER.indexOf(planId) + 1; i < PLAN_ORDER.length; i++) {
    const v = LIMITS[PLAN_ORDER[i]][key];
    if (v == null || v > cur) return PLAN_ORDER[i];
  }
  return null;
}

// Yearly saving vs 12 monthly payments, in % (rounded)
function yearlySavingPercent(planId) {
  const p = PLANS[planId].prices;
  if (!p.monthly) return 0;
  return Math.round((1 - p.yearly / (p.monthly * 12)) * 100);
}

module.exports = {
  PLANS, PLAN_ORDER, LIMITS, FREE_LIMITS, FEATURE_TIERS, TRIAL_DAYS,
  GOOGLE_PRODUCTS, GOOGLE_BASE_PLANS, BASE_PLANS, OFFERS,
  productIdFor, nextPlan, nextPlanWithMore, yearlySavingPercent,
};
