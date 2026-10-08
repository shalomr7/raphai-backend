// utils/plans.js
// ------------------------------------------------------------
// The subscription plans, in ONE place. Prices are in rupees (₹).
// "rank" is used to compare plans: elite (2) includes pro (1) includes free (0).
//
// What stays FREE forever: all health logs, calories,
// macros, water, BMI, steps, expenses, bills, 50/30/20 suggestion, RaphScore.
// What needs PRO: body fat %, unlimited budgets and goals, SIP/EMI
// calculators, the AI coach, HIIT plans (HIIT plans are locked in the app).
// ------------------------------------------------------------

// Free plan limits (Pro and Elite have no limit)
const FREE_LIMITS = {
  budgets_per_month: 3,
  savings_goals: 2,
};

// Length of the free trial of Pro (days). One trial per account.
const TRIAL_DAYS = 14;

const PLANS = {
  free: {
    id: 'free',
    name: 'Free',
    rank: 0,
    prices: { monthly: 0, yearly: 0 },
    features: [
      'Calories, macros, water, steps, sleep, mood, weight',
      'BMI and daily targets',
      'Expenses, bills, bill reminders, 50/30/20 suggestion',
      `Up to ${FREE_LIMITS.budgets_per_month} budgets and ${FREE_LIMITS.savings_goals} savings goals`,
      'Daily RaphScore and streaks',
    ],
  },
  pro: {
    id: 'pro',
    name: 'Pro',
    rank: 1,
    prices: { monthly: 99, yearly: 799 },
    features: [
      'Everything in Free',
      'Body fat % (US Navy method)',
      'Unlimited budgets and savings goals',
      'SIP and EMI calculators',
      'Raph AI coach',
      'HIIT workout plans',
    ],
  },
  elite: {
    id: 'elite',
    name: 'Elite',
    rank: 2,
    prices: { monthly: 199, yearly: 1499 },
    features: ['Everything in Pro', 'Priority support', 'Early access to new features'],
  },
};

// Google Play Billing: subscription product id -> our plan id.
// Each product has two base plans: "monthly" and "yearly". The 14-day
// free trial is an OFFER on each base plan (set up in Play Console).
const GOOGLE_PRODUCTS = {
  raphai_pro: 'pro',
  raphai_elite: 'elite',
};
// Google Play base plan id -> our period
const GOOGLE_BASE_PLANS = {
  monthly: 'monthly',
  yearly: 'yearly',
};

module.exports = { PLANS, FREE_LIMITS, TRIAL_DAYS, GOOGLE_PRODUCTS, GOOGLE_BASE_PLANS };
