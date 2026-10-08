// services/summary.js
// ------------------------------------------------------------
// Functions that collect a user's numbers from many tables.
// Used by the dashboard, the coach, and some routes, so the same
// logic is not copied in many places.
// ------------------------------------------------------------

const db = require('../db');
const calc = require('../utils/calc');
const { today, thisMonth, dayOfMonth } = require('../utils/dates');

// Which expense categories count as "needs" vs "wants" for 50/30/20
const EXPENSE_CATEGORIES = [
  'Food', 'Groceries', 'Rent', 'Transport', 'Bills', 'Health', 'Education',
  'Shopping', 'Entertainment', 'Travel', 'Personal Care', 'Investment', 'Other',
];
const NEEDS = ['Groceries', 'Rent', 'Transport', 'Bills', 'Health', 'Education'];
const SAVINGS = ['Investment']; // money put into SIP/FD etc. counts as saving, not spending

// Can we calculate targets? We need these 4 fields.
function profileIsComplete(p) {
  return Boolean(p && p.sex && p.age && p.height_cm && p.weight_kg);
}

// Calories, protein, carbs, fat eaten on a date
async function foodTotals(userId, date) {
  const row = await db.get(`
    SELECT
      COALESCE(SUM(f.kcal * l.servings), 0)      AS kcal,
      COALESCE(SUM(f.protein_g * l.servings), 0) AS protein_g,
      COALESCE(SUM(f.carbs_g * l.servings), 0)   AS carbs_g,
      COALESCE(SUM(f.fat_g * l.servings), 0)     AS fat_g
    FROM food_logs l JOIN foods f ON f.id = l.food_id
    WHERE l.user_id = $1 AND l.date = $2
  `, [userId, date]);
  return {
    kcal: calc.round(row.kcal),
    protein_g: calc.round(row.protein_g, 1),
    carbs_g: calc.round(row.carbs_g, 1),
    fat_g: calc.round(row.fat_g, 1),
  };
}

// Everything about one day of health
async function healthDay(userId, date = today()) {
  // These lookups don't depend on each other, so ask Postgres all at once
  const [profile, eaten, waterRow, stepsRow, burnedRow, sleepRow] = await Promise.all([
    db.get('SELECT * FROM profiles WHERE user_id = $1', [userId]),
    foodTotals(userId, date),
    db.get('SELECT COALESCE(SUM(ml),0) AS ml FROM water_logs WHERE user_id = $1 AND date = $2', [userId, date]),
    db.get('SELECT steps FROM step_logs WHERE user_id = $1 AND date = $2', [userId, date]),
    db.get('SELECT COALESCE(SUM(kcal),0) AS k FROM workouts WHERE user_id = $1 AND date = $2', [userId, date]),
    db.get('SELECT COALESCE(SUM(hours),0) AS h, COUNT(*)::int AS n FROM sleep_logs WHERE user_id = $1 AND date = $2', [userId, date]),
  ]);
  const targets = profileIsComplete(profile) ? calc.dailyTargets(profile) : null;
  const water = waterRow.ml;
  const steps = stepsRow ? stepsRow.steps : 0;
  const burned = burnedRow.k;

  const stepGoal = (profile && profile.step_goal) || 8000;

  return {
    date,
    targets,
    eaten,
    // Calories left = target + workout calories − eaten
    calories_left: targets ? calc.round(targets.calories + burned - eaten.kcal) : null,
    workout_kcal: calc.round(burned),
    water_ml: water,
    steps,
    step_goal: stepGoal,
    sleep_hours: sleepRow.n ? sleepRow.h : null,
  };
}

/**
 * Health score 0–100 for a day = average of 5 parts:
 *  calories: 100 if within ±10% of target, then drops
 *  protein:  % of protein target reached (max 100)
 *  water:    % of water target reached
 *  steps:    % of step goal reached
 *  sleep:    100 for 7–9 hours, loses 25 points per hour outside that
 */
function healthScore(day) {
  const parts = {};
  if (day.targets) {
    const t = day.targets;
    const diff = Math.abs(day.eaten.kcal - t.calories) / t.calories; // 0.1 = 10% off
    parts.calories = day.eaten.kcal === 0 ? 0 : diff <= 0.1 ? 100 : Math.max(0, 100 - (diff - 0.1) * 200);
    parts.protein = calc.scoreUpTo(day.eaten.protein_g, t.protein_g);
    parts.water = calc.scoreUpTo(day.water_ml, t.water_ml);
  } else {
    parts.calories = 0;
    parts.protein = 0;
    parts.water = calc.scoreUpTo(day.water_ml, 2500);
  }
  parts.steps = calc.scoreUpTo(day.steps, day.step_goal);
  const h = day.sleep_hours;
  parts.sleep = h == null ? 0 : h >= 7 && h <= 9 ? 100 : Math.max(0, 100 - (h < 7 ? 7 - h : h - 9) * 25);

  for (const k of Object.keys(parts)) parts[k] = calc.round(parts[k]);
  const score = calc.round(Object.values(parts).reduce((a, b) => a + b, 0) / 5);
  return { score, parts };
}

// Everything about one month of money
async function wealthMonth(userId, month = thisMonth()) {
  const [profile, byCategory, budgets, bills] = await Promise.all([
    db.get('SELECT income FROM profiles WHERE user_id = $1', [userId]),
    db.all(`
      SELECT category, SUM(amount) AS total, COUNT(*)::int AS count
      FROM expenses WHERE user_id = $1 AND substr(date, 1, 7) = $2
      GROUP BY category ORDER BY total DESC
    `, [userId, month]),
    db.all('SELECT category, amount FROM budgets WHERE user_id = $1 AND month = $2', [userId, month]),
    // Bills: which are due by today (for this month) and are they paid?
    db.all(`
      SELECT b.*, (p.bill_id IS NOT NULL)::int AS paid
      FROM bills b LEFT JOIN bill_payments p ON p.bill_id = b.id AND p.month = $1
      WHERE b.user_id = $2
    `, [month, userId]),
  ]);
  const income = (profile && profile.income) || 0;

  let spent = 0; let invested = 0; let needs = 0; let wants = 0;
  for (const c of byCategory) {
    if (SAVINGS.includes(c.category)) invested += c.total;
    else {
      spent += c.total;
      if (NEEDS.includes(c.category)) needs += c.total; else wants += c.total;
    }
  }

  const isCurrent = month === thisMonth();
  const dueSoFar = bills.filter((b) => !isCurrent || b.due_day <= dayOfMonth());

  return {
    month,
    income,
    spent: calc.round(spent),
    invested: calc.round(invested),
    needs: calc.round(needs),
    wants: calc.round(wants),
    by_category: byCategory.map((c) => ({ ...c, total: calc.round(c.total) })),
    budgets,
    bills,
    bills_due_so_far: dueSoFar.length,
    bills_paid_of_due: dueSoFar.filter((b) => b.paid).length,
  };
}

/**
 * Wealth score 0–100 = average of 3 parts:
 *  savings rate:      (income − spending) / income. 20% or more = 100.
 *  bills paid:        % of bills due so far this month that are paid (none due = 100)
 *  budget adherence:  % of budget categories not overspent.
 *                     No budgets set? We use 50/30/20: spending ≤ 80% of income = 100.
 */
function wealthScore(m) {
  const parts = {};
  const savingsRate = m.income > 0 ? (m.income - m.spent) / m.income : 0;
  parts.savings_rate = calc.round(calc.scoreUpTo(savingsRate, 0.2));
  parts.bills_paid = m.bills_due_so_far === 0 ? 100 : calc.round((m.bills_paid_of_due / m.bills_due_so_far) * 100);

  if (m.budgets.length) {
    const spentIn = Object.fromEntries(m.by_category.map((c) => [c.category, c.total]));
    const ok = m.budgets.filter((b) => (spentIn[b.category] || 0) <= b.amount).length;
    parts.budget_adherence = calc.round((ok / m.budgets.length) * 100);
  } else if (m.income > 0) {
    const limit = m.income * 0.8;
    parts.budget_adherence = m.spent <= limit ? 100 : calc.round(Math.max(0, 100 - ((m.spent - limit) / limit) * 100));
  } else {
    parts.budget_adherence = 0;
  }

  const score = calc.round((parts.savings_rate + parts.bills_paid + parts.budget_adherence) / 3);
  return { score, parts, savings_rate_pct: calc.round(savingsRate * 100, 1) };
}

module.exports = {
  EXPENSE_CATEGORIES,
  NEEDS,
  SAVINGS,
  profileIsComplete,
  foodTotals,
  healthDay,
  healthScore,
  wealthMonth,
  wealthScore,
};
