// services/intelligence.js
// ------------------------------------------------------------
// The HeartPurse "intelligence layer". Rule-based (no AI model), but it uses
// the user's own numbers: profile, food, water, sleep, mood, weight,
// steps, workouts, expenses, budgets and bills.
//
// The golden rule: MISSING DATA IS NOT A BAD SCORE. When something is not
// tracked we return null + status "no_data" (or "limited") with a kind
// "Start tracking ..." note. We never invent a 0.
//
// Main functions (all async, used by routes/insights.js and the coach):
//   todayInsights(userId)          GET /api/insights/today
//   trends(userId, days)           GET /api/insights/trends
//   patterns(userId)               GET /api/insights/patterns
//   brief(userId)                  GET /api/insights/brief
//   userProfile(userId)            GET /api/insights/profile
// Pure helpers (exported for tests): nutritionSafety, hydrationAdvice,
//   combineAreas, explainChange
// ------------------------------------------------------------

const money = require('../utils/money');
const db = require('../db');
const calc = require('../utils/calc');
const { today, addDays, hourNow, weekday, daysInMonth } = require('../utils/dates');
const summary = require('./summary');

const AREAS = [
  { key: 'health', label: 'Health', weight: 0.2, words: 'food & water' },
  { key: 'fitness', label: 'Fitness', weight: 0.2, words: 'activity' },
  { key: 'mind', label: 'Mind', weight: 0.15, words: 'mood' },
  { key: 'wealth', label: 'Wealth', weight: 0.2, words: 'money habits' },
  { key: 'habits', label: 'Habits', weight: 0.1, words: 'logging consistency' },
  { key: 'recovery', label: 'Recovery', weight: 0.15, words: 'sleep' },
];
const AREA_BY_KEY = Object.fromEntries(AREAS.map((a) => [a.key, a]));

const ROUTES = {
  move: '/(tabs)/fitness',
  hydrate: '/(tabs)/health',
  protein: '/(tabs)/health',
  log_food: '/(tabs)/health',
  sleep: '/(tabs)/health',
  spend: '/(tabs)/wealth',
};

const SHORT_SLEEP_H = 6;   // "poor sleep" for patterns
const GOOD_SLEEP_H = 7;    // "good sleep" for patterns
const MIN_GROUP_DAYS = 5;  // each pattern group needs at least this many days
const MIN_PATTERN_DAYS = 14;

// ---------------- small helpers ----------------
const inr = (n) => '₹' + Math.round(n).toLocaleString('en-IN');
const num = (n) => Math.round(n).toLocaleString('en-IN');
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const avg = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null);
const pctChange = (now, prev) => (now != null && prev != null && prev > 0 ? calc.round(((now - prev) / prev) * 100) : null);
const firstName = (name) => String(name || '').trim().split(/\s+/)[0] || 'there';
function hm(minutes) {
  const h = Math.floor(minutes / 60); const m = Math.round(minutes % 60);
  return m ? `${h}h ${m}m` : `${h}h`;
}
function greeting(hour) {
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  return 'Good evening';
}
// Share of the day that has passed, for "on pace" checks (7 AM -> 0.15, 9 PM -> 1)
function dayFraction(hour) {
  return clamp((hour - 7) / 14, 0.15, 1);
}
function dates(from, to) {
  const out = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

// ------------------------------------------------------------
// Data loading: one row per day with everything we know about it.
// Missing things stay null.
// ------------------------------------------------------------
async function loadDays(userId, from, to) {
  const p = [userId, from, to];
  const W = 'user_id = $1 AND date >= $2 AND date <= $3';
  const [steps, sleep, mood, water, food, workouts, expenses, weight, activity] = await Promise.all([
    db.all(`SELECT date, steps FROM step_logs WHERE ${W}`, p),
    db.all(`SELECT date, SUM(hours) AS h, AVG(quality) AS q FROM sleep_logs WHERE ${W} GROUP BY date`, p),
    db.all(`SELECT date, AVG(mood) AS m FROM mood_logs WHERE ${W} GROUP BY date`, p),
    db.all(`SELECT date, SUM(ml) AS ml FROM water_logs WHERE ${W} GROUP BY date`, p),
    db.all(`SELECT l.date, SUM(f.kcal * l.servings) AS kcal, SUM(f.protein_g * l.servings) AS protein, COUNT(*)::int AS n
            FROM food_logs l JOIN foods f ON f.id = l.food_id WHERE l.user_id = $1 AND l.date >= $2 AND l.date <= $3 GROUP BY l.date`, p),
    db.all(`SELECT date, SUM(minutes) AS min, COUNT(*)::int AS n FROM workouts WHERE ${W} GROUP BY date`, p),
    db.all(`SELECT date,
              SUM(amount_paise) FILTER (WHERE category <> 'Investment') AS spend_paise,
              SUM(amount_paise) FILTER (WHERE category = 'Food' OR note ~* '(swiggy|zomato|delivery|takeaway|order)') AS food_out_paise,
              COUNT(*)::int AS n
            FROM expenses WHERE ${W} GROUP BY date`, p),
    db.all(`SELECT DISTINCT ON (date) date, weight_kg FROM weight_logs WHERE ${W} ORDER BY date, id DESC`, p),
    db.all(`SELECT date, active_minutes, resting_hr, active_kcal, distance_m FROM activity_daily WHERE ${W}`, p),
  ]);
  const days = {};
  for (const d of dates(from, to)) {
    days[d] = { date: d, steps: null, sleep_h: null, sleep_q: null, mood: null, water: null, kcal: null, protein: null, food_n: 0,
      workout_min: null, spend: null, food_out: null, expense_n: 0, weight: null, active_min: null, resting_hr: null };
  }
  const put = (rows, fn) => { for (const r of rows) if (days[r.date]) fn(days[r.date], r); };
  put(steps, (d, r) => { d.steps = r.steps; });
  put(sleep, (d, r) => { d.sleep_h = r.h; d.sleep_q = r.q == null ? null : Number(r.q); });
  put(mood, (d, r) => { d.mood = Number(r.m); });
  put(water, (d, r) => { d.water = r.ml; });
  put(food, (d, r) => { d.kcal = r.kcal; d.protein = r.protein; d.food_n = r.n; });
  put(workouts, (d, r) => { d.workout_min = r.min; });
  put(expenses, (d, r) => { d.spend_paise = Number(r.spend_paise || 0); d.spend = money.rupees(d.spend_paise); d.food_out = money.rupees(r.food_out_paise); d.expense_n = r.n; });
  put(weight, (d, r) => { d.weight = r.weight_kg; });
  // Active minutes from the phone are kept apart from logged workouts
  put(activity, (d, r) => { d.active_min = r.active_minutes; d.resting_hr = r.resting_hr; });
  for (const d of Object.values(days)) {
    d.logged = d.steps != null || d.sleep_h != null || d.mood != null || d.water != null || d.food_n > 0
      || d.workout_min != null || d.expense_n > 0 || d.weight != null;
  }
  return days;
}

async function loadContext(userId, D) {
  // Start of yesterday's month (so yesterday's score works on the 1st too)
  const monthStart = `${addDays(D, -1).slice(0, 7)}-01`;
  const from = [monthStart, addDays(D, -14)].sort()[0];
  const [days, profile, user, bills, budgets, firstLog] = await Promise.all([
    loadDays(userId, from, D),
    db.get('SELECT * FROM profiles WHERE user_id = $1', [userId]),
    db.get('SELECT name FROM users WHERE id = $1', [userId]),
    db.all(`SELECT b.id, b.name, b.amount, b.amount_paise, b.due_day, p.month AS paid_month
            FROM bills b LEFT JOIN bill_payments p ON p.bill_id = b.id AND p.month = $2 WHERE b.user_id = $1`, [userId, D.slice(0, 7)]),
    db.all('SELECT month, category, amount, amount_paise FROM budgets WHERE user_id = $1 AND month >= $2', [userId, monthStart.slice(0, 7)]),
    db.get(`SELECT MIN(d) AS d FROM (
              SELECT MIN(date) d FROM food_logs WHERE user_id = $1 UNION ALL SELECT MIN(date) FROM water_logs WHERE user_id = $1
              UNION ALL SELECT MIN(date) FROM step_logs WHERE user_id = $1 UNION ALL SELECT MIN(date) FROM sleep_logs WHERE user_id = $1
              UNION ALL SELECT MIN(date) FROM mood_logs WHERE user_id = $1 UNION ALL SELECT MIN(date) FROM expenses WHERE user_id = $1
              UNION ALL SELECT MIN(date) FROM workouts WHERE user_id = $1 UNION ALL SELECT MIN(date) FROM weight_logs WHERE user_id = $1) x`, [userId]),
  ]);
  // Expenses by category for the month(s) we look at (for budget adherence)
  const catRows = await db.all(`SELECT date, category, amount, amount_paise FROM expenses WHERE user_id = $1 AND date >= $2 AND date <= $3`, [userId, monthStart, D]);
  const targets = summary.profileIsComplete(profile) ? calc.dailyTargets(profile) : null;
  return { userId, D, days, profile: profile || {}, user, bills, budgets, catRows, targets, firstLog: firstLog && firstLog.d };
}

// ------------------------------------------------------------
// Wealth for the month of date D, up to D
// ------------------------------------------------------------
function monthMoney(ctx, D) {
  const month = D.slice(0, 7);
  const incomeP = money.paiseOf(ctx.profile, 'income');
  const income = incomeP > 0 ? money.rupees(incomeP) : null;
  let spentP = 0; let n = 0;
  for (const d of Object.values(ctx.days)) {
    if (d.date.slice(0, 7) === month && d.date <= D && d.expense_n) { spentP += d.spend_paise || 0; n += d.expense_n; }
  }
  const isCurrentMonth = month === ctx.D.slice(0, 7);
  // Paid status is only known for the current month's payments
  const bills = ctx.bills.map((b) => ({ ...b, paid: isCurrentMonth ? Boolean(b.paid_month) : false }));
  const dayNum = Number(D.slice(8, 10));
  const unpaidP = money.sumPaise(bills.filter((b) => !b.paid));
  const unpaidThisMonth = money.rupees(unpaidP);
  const dueSoFar = bills.filter((b) => b.due_day <= dayNum);
  const byCat = {};
  for (const r of ctx.catRows) if (r.date.slice(0, 7) === month && r.date <= D) byCat[r.category] = money.rupees(money.toPaise(byCat[r.category]) + money.paiseOf(r));
  const budgets = ctx.budgets.filter((b) => b.month === month);
  return { month, income, incomeP, spent: money.rupees(spentP), spentP, expense_n: n, bills, unpaidThisMonth, unpaidP, dueSoFar, byCat, budgets, dayNum };
}

// ------------------------------------------------------------
// HeartScore areas for one date. isToday = the day is not over yet.
// Every area returns { score (0..100 or null), status, note }.
// ------------------------------------------------------------
function areaHealth(ctx, D, frac) {
  const day = ctx.days[D];
  const hasFood = day.food_n > 0; const hasWater = day.water != null && day.water > 0;
  if (!hasFood && !hasWater) return { score: null, status: 'no_data', note: 'Start tracking food and water to get a score.' };
  const t = ctx.targets;
  const parts = [];
  if (hasFood && t) {
    const ratio = day.kcal / (t.calories * frac);
    let cal = 100;
    if (ratio < 0.85) cal = Math.max(30, 100 - (0.85 - ratio) * 150);
    if (ratio > 1.1) cal = Math.max(20, 100 - (ratio - 1.1) * 200);
    if (frac < 1 && day.kcal <= t.calories) cal = Math.max(cal, 60); // the day is not over yet
    parts.push(cal);
    parts.push(calc.scoreUpTo(day.protein, t.protein_g * frac));
  }
  const waterGoal = (t && t.water_ml) || (ctx.profile.weight_kg ? 35 * ctx.profile.weight_kg : 2500);
  if (hasWater) parts.push(calc.scoreUpTo(day.water, waterGoal * frac));
  if (!parts.length) return { score: null, status: 'no_data', note: 'Complete your profile (sex, age, height, weight) so I can score your meals.' };
  let note = null;
  if (!hasFood) note = 'Log your meals to complete this score.';
  else if (!t) note = 'Complete your profile to score your calories and protein.';
  else if (!hasWater) note = 'Log your water to complete this score.';
  return { score: calc.round(avg(parts)), status: note ? 'limited' : 'ok', note };
}

function areaFitness(ctx, D, frac) {
  const day = ctx.days[D];
  const goal = ctx.profile.step_goal || 8000;
  const wmin = (day.workout_min || 0) + 0;
  if (day.steps == null && !day.workout_min && !day.active_min) {
    return { score: null, status: 'no_data', note: 'Start tracking steps or log a workout to get a score.' };
  }
  if (day.steps != null) {
    const s = calc.scoreUpTo(day.steps, goal * frac) + Math.min(25, wmin);
    return { score: calc.round(Math.min(100, s)), status: 'ok', note: null };
  }
  const minutes = wmin || day.active_min || 0;
  return { score: calc.round(Math.min(100, (minutes / 30) * 100)), status: 'limited', note: 'Sync your steps for a fuller score.' };
}

const MOOD_SCORE = { 1: 40, 2: 55, 3: 70, 4: 85, 5: 100 };
function moodScore(m) {
  const lo = Math.floor(m); const hi = Math.ceil(m);
  return calc.round(MOOD_SCORE[lo] + (MOOD_SCORE[hi] - MOOD_SCORE[lo]) * (m - lo));
}
function areaMind(ctx, D) {
  const day = ctx.days[D];
  if (day.mood != null) return { score: moodScore(day.mood), status: 'ok', note: null };
  for (const back of [1, 2]) {
    const prev = ctx.days[addDays(D, -back)];
    if (prev && prev.mood != null) return { score: moodScore(prev.mood), status: 'limited', note: "Log today's mood for an up-to-date score." };
  }
  return { score: null, status: 'no_data', note: 'Start tracking your mood to get a score.' };
}

function areaWealth(ctx, D) {
  const m = monthMoney(ctx, D);
  const parts = [];
  if (m.income && m.expense_n > 0) parts.push(calc.scoreUpTo((m.income - m.spent - m.unpaidThisMonth) / m.income, 0.2));
  if (m.dueSoFar.length) parts.push((m.dueSoFar.filter((b) => b.paid).length / m.dueSoFar.length) * 100);
  if (m.budgets.length && m.expense_n > 0) parts.push((m.budgets.filter((b) => (m.byCat[b.category] || 0) <= b.amount).length / m.budgets.length) * 100);
  if (!parts.length) {
    return { score: null, status: 'no_data', note: m.income ? 'Start tracking your expenses to get a score.' : 'Add your income and start tracking expenses to get a score.' };
  }
  let note = null;
  if (!m.income) note = 'Add your monthly income to your profile for a fuller score.';
  else if (!m.expense_n) note = 'Log your expenses for an accurate score.';
  return { score: calc.round(avg(parts)), status: note ? 'limited' : 'ok', note };
}

function areaHabits(ctx, D, isToday) {
  let end = D;
  if (isToday && !ctx.days[D].logged) end = addDays(D, -1); // the day is not over: don't count it against you yet
  const start = addDays(end, -6);
  const window = dates(start, end).map((d) => ctx.days[d]).filter(Boolean);
  const logged = window.filter((d) => d.logged);
  if (!logged.length) return { score: null, status: 'no_data', note: 'Log something each day to build your habits score.' };
  const types = new Set();
  for (const d of window) {
    if (d.food_n) types.add('food'); if (d.water != null) types.add('water'); if (d.sleep_h != null) types.add('sleep');
    if (d.mood != null) types.add('mood'); if (d.steps != null) types.add('steps'); if (d.workout_min != null) types.add('workout');
    if (d.expense_n) types.add('expense'); if (d.weight != null) types.add('weight');
  }
  // New users are not punished for days before they started
  const firstLog = ctx.firstLog && ctx.firstLog > start ? ctx.firstLog : start;
  const denom = Math.max(1, dates(firstLog, end).length);
  const score = 70 * Math.min(1, logged.length / denom) + 30 * Math.min(1, types.size / 4);
  const young = denom < 7;
  return { score: calc.round(score), status: young ? 'limited' : 'ok', note: young ? 'Keep logging: this score settles after your first week.' : null };
}

function areaRecovery(ctx, D) {
  const day = ctx.days[D];
  if (day.sleep_h == null) return { score: null, status: 'no_data', note: 'Start tracking sleep to get a score.' };
  const h = day.sleep_h;
  let s = 100;
  if (h < 7) s = Math.max(20, 100 - (7 - h) * 20);
  if (h > 9) s = Math.max(50, 100 - (h - 9) * 15);
  if (day.sleep_q) s = 0.8 * s + 0.2 * (day.sleep_q * 20);
  // Resting heart rate well above your normal = less recovered
  if (day.resting_hr) {
    const base = avg(Object.values(ctx.days).filter((d) => d.date < D && d.resting_hr).map((d) => d.resting_hr));
    if (base && day.resting_hr > base + 5) s -= 10;
  }
  return { score: calc.round(clamp(s, 0, 100)), status: 'ok', note: null };
}

// overall = weighted average of areas WITH data; null if fewer than 2
function combineAreas(areaScores) {
  const have = AREAS.filter((a) => areaScores[a.key] != null);
  if (have.length < 2) return null;
  const w = have.reduce((s, a) => s + a.weight, 0);
  return calc.round(have.reduce((s, a) => s + a.weight * areaScores[a.key], 0) / w);
}

function scoreLabel(overall) {
  if (overall == null) return 'Not enough data';
  if (overall >= 70) return 'Good';
  if (overall >= 45) return 'Okay';
  return 'Needs care';
}

function computeScore(ctx, D, { isToday, hour }) {
  const frac = isToday ? dayFraction(hour) : 1;
  const results = {
    health: areaHealth(ctx, D, frac),
    fitness: areaFitness(ctx, D, frac),
    mind: areaMind(ctx, D),
    wealth: areaWealth(ctx, D),
    habits: areaHabits(ctx, D, isToday),
    recovery: areaRecovery(ctx, D),
  };
  const scores = Object.fromEntries(Object.entries(results).map(([k, v]) => [k, v.score]));
  return { overall: combineAreas(scores), scores, results };
}

// Why did the score change vs yesterday? (plain words)
function explainChange(todayS, yesterdayS) {
  const t = todayS.overall; const y = yesterdayS ? yesterdayS.overall : null;
  if (t == null) return { delta: null, explanation: 'Track at least two areas today (for example food and sleep) to get your HeartScore.' };
  if (y == null) return { delta: null, explanation: "This is your first HeartScore. Come back tomorrow and I'll explain how it changed." };
  const delta = t - y;
  const changes = AREAS
    .filter((a) => todayS.scores[a.key] != null && yesterdayS.scores[a.key] != null)
    .map((a) => ({ a, d: todayS.scores[a.key] - yesterdayS.scores[a.key] }));
  const join = (list) => (list.length === 1 ? list[0] : `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`);
  if (Math.abs(delta) < 1) return { delta: 0, explanation: 'Your score is steady compared with yesterday. Nice consistency.' };
  if (delta > 0) {
    const up = changes.filter((c) => c.d >= 3).sort((x, z) => z.d - x.d).slice(0, 2).map((c) => c.a.words);
    if (up.length) return { delta, explanation: `Your score rose ${delta} point${delta === 1 ? '' : 's'} because your ${join(up)} improved compared with yesterday.` };
    return { delta, explanation: `Your score rose ${delta} point${delta === 1 ? '' : 's'}, mostly because you tracked more areas today.` };
  }
  const down = changes.filter((c) => c.d <= -3).sort((x, z) => x.d - z.d).slice(0, 2).map((c) => c.a.words);
  const missing = AREAS.filter((a) => todayS.scores[a.key] == null && yesterdayS.scores[a.key] != null).map((a) => a.words);
  const n = -delta;
  if (down.length) return { delta, explanation: `Your score dropped ${n} point${n === 1 ? '' : 's'} because your ${join(down)} ${down.length > 1 ? 'are' : 'is'} below yesterday's level.` };
  if (missing.length) return { delta, explanation: `Your score dropped ${n} point${n === 1 ? '' : 's'} because ${join(missing)} ${missing.length > 1 ? "aren't" : "isn't"} tracked yet today.` };
  return { delta, explanation: `Your score dropped ${n} point${n === 1 ? '' : 's'}: small dips across a few areas. Nothing to worry about.` };
}

async function saveScore(userId, date, s) {
  await db.run(`INSERT INTO raphscore_daily (user_id, date, overall, areas) VALUES ($1, $2, $3, $4)
                ON CONFLICT (user_id, date) DO UPDATE SET overall = excluded.overall, areas = excluded.areas,
                computed_at = to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')`,
  [userId, date, s.overall, JSON.stringify(s.scores)]);
}

// ------------------------------------------------------------
// Nutrition safety: how big is the calorie deficit?
// >25% of TDEE = aggressive, >35% = very aggressive. Never suggest a
// target below 1,200 kcal (women) / 1,500 kcal (men).
// ------------------------------------------------------------
function nutritionSafety({ tdee, target, sex }) {
  const minimum = sex === 'male' ? 1500 : 1200;
  const deficit = calc.round(tdee - target);
  const pct = tdee > 0 ? calc.round((deficit / tdee) * 100) : 0;
  let safety = 'ok';
  if (pct > 35) safety = 'very_aggressive';
  else if (pct > 25) safety = 'aggressive';
  const gentle = Math.max(minimum, calc.round(tdee * 0.8));
  let message;
  if (deficit <= 0) {
    message = deficit < 0
      ? `Your target of ${num(target)} kcal is ${num(-deficit)} kcal above your daily burn of ${num(tdee)} kcal, which supports steady gaining. Pair it with strength training and enough protein.`
      : `Your target matches your daily burn of ${num(tdee)} kcal, so your weight should stay steady.`;
  } else if (safety === 'ok') {
    message = `Your target of ${num(target)} kcal is a steady, sustainable deficit of ${num(deficit)} kcal (${pct}%). Keep it up.`;
  } else {
    message = `Your target of ${num(target)} kcal is ${num(deficit)} kcal below your daily burn (${pct}%). That's ${safety === 'very_aggressive' ? 'a very' : 'an'} aggressive deficit. `
      + 'Keep an eye on your energy, hunger and progress, and please don\'t restrict too hard. '
      + `A gentler target of about ${num(gentle)} kcal is easier to stick with and still works.`;
  }
  return { tdee: calc.round(tdee), target: calc.round(target), deficit, deficit_pct: pct, safety, minimum_kcal: minimum,
    suggested_target: safety === 'ok' ? null : gentle, message };
}

// ------------------------------------------------------------
// Hydration advice that depends on the time of day in India
// ------------------------------------------------------------
function hydrationAdvice({ goal_ml, drunk_ml, hour }) {
  const goal = calc.round(goal_ml / 50) * 50;
  if (drunk_ml == null) {
    const msg = hour >= 21
      ? 'Start tracking water: have a small glass now and log it. Tomorrow, aim for a glass every couple of hours.'
      : `Start tracking water: have a glass (250 ml) now and log it. Your goal is about ${(goal / 1000).toFixed(1)} L today.`;
    return { goal_ml: goal, drunk_ml: null, behind_ml: null, status: 'no_data', message: msg };
  }
  const behind = Math.max(0, calc.round(goal - drunk_ml));
  if (behind === 0) return { goal_ml: goal, drunk_ml, behind_ml: 0, status: 'done', message: "You've reached your water goal today. Lovely work. Sip when you're thirsty." };
  const expectedNow = goal * clamp((hour - 7) / 14, 0, 1);
  const behindPace = expectedNow - drunk_ml;
  let message;
  if (hour >= 21) {
    message = `You're ${num(behind)} ml short today. Have a small glass (200 ml) now, but don't gulp a lot before bed. Start early tomorrow.`;
  } else {
    const now = behindPace > 400 ? 500 : 250;
    const leftAfter = Math.max(0, behind - now);
    const checkpoint = hour < 12 ? '1 PM' : hour < 16 ? '5 PM' : hour < 18 ? '7 PM' : '9 PM';
    const next = Math.min(500, calc.round(leftAfter / 50) * 50);
    message = next > 0
      ? `Have ${now} ml now and another ${next} ml before ${checkpoint}.`
      : `Have ${now} ml now and you'll reach your goal.`;
    if (behindPace <= 0) message = `You're on track. ${message}`;
  }
  return { goal_ml: goal, drunk_ml, behind_ml: behind, status: behindPace > 0 ? 'behind' : 'on_track', message };
}

// ------------------------------------------------------------
// Budget: remaining = income − spent this month − unpaid bills due this month
// ------------------------------------------------------------
function budgetBlock(ctx) {
  const m = monthMoney(ctx, ctx.D);
  if (!m.income && !m.expense_n && !m.bills.length) return null;
  const spent = m.expense_n ? m.spent : null;
  const upcoming = m.bills.length ? calc.round(m.unpaidThisMonth) : null;
  const daysLeft = daysInMonth(m.month) - m.dayNum + 1;
  if (!m.income) {
    return { income: null, spent, upcoming_bills: upcoming, remaining: null, savings_rate: null,
      message: 'Add your monthly income to your profile and I can show how much you have left this month.' };
  }
  const remaining = money.rupees(m.incomeP - (spent != null ? m.spentP : 0) - (m.bills.length ? m.unpaidP : 0));
  const savingsRate = spent != null ? calc.round((remaining / m.income) * 100) : null;
  let message;
  if (remaining < 0) message = `You're ${inr(-remaining)} over this month once bills are paid. Let's pause non-essential spending for a few days. You can get back on track.`;
  else {
    const perDay = remaining / daysLeft;
    message = `You have ${inr(remaining)} left after bills: about ${inr(perDay)} a day for the next ${daysLeft} day${daysLeft === 1 ? '' : 's'}.`;
    if (savingsRate != null && savingsRate >= 20) message += ' You\'re on track to save 20% or more. Great going.';
    if (spent == null) message += ' Log your expenses so this stays accurate.';
  }
  return { income: m.income, spent, upcoming_bills: upcoming, remaining, savings_rate: savingsRate, message };
}

// ------------------------------------------------------------
// Today's top priorities (max 3), most important first
// ------------------------------------------------------------
function priorities(ctx, hour, hydration, budget) {
  const day = ctx.days[ctx.D];
  const frac = dayFraction(hour);
  const t = ctx.targets;
  const out = [];
  // Move
  const goal = ctx.profile.step_goal || 8000;
  if (day.steps != null && day.steps < goal) {
    const behindPace = goal * frac - day.steps;
    if (behindPace > 800) out.push({ key: 'move', weight: 50 + Math.min(40, behindPace / 100), title: 'Move', detail: `You're ${num(goal - day.steps)} steps behind your target.` });
  } else if (day.steps == null && hour >= 11 && !day.workout_min) {
    out.push({ key: 'move', weight: 30, title: 'Move', detail: 'No steps synced yet today. A 15-minute walk is a great start.' });
  }
  // Hydrate
  if (hydration.status === 'behind' && hydration.behind_ml >= 300) out.push({ key: 'hydrate', weight: 45 + Math.min(40, hydration.behind_ml / 50), title: 'Hydrate', detail: hydration.message });
  else if (hydration.status === 'no_data' && hour >= 10) out.push({ key: 'hydrate', weight: 35, title: 'Hydrate', detail: hydration.message });
  // Food
  if (!day.food_n && hour >= 10) out.push({ key: 'log_food', weight: 40, title: 'Log your meals', detail: 'Log what you ate today so I can check your calories and protein.' });
  else if (day.food_n && t && hour >= 14 && day.protein < t.protein_g * frac * 0.6) {
    out.push({ key: 'protein', weight: 45, title: 'Protein', detail: `You've had ${calc.round(day.protein)} g of protein so far. Aim for about ${t.protein_g} g today: add dal, eggs, paneer or curd.` });
  }
  // Sleep
  const lastWeekSleep = dates(addDays(ctx.D, -6), ctx.D).map((d) => ctx.days[d]).filter((d) => d && d.sleep_h != null).map((d) => d.sleep_h);
  const avgSleep = avg(lastWeekSleep);
  if ((day.sleep_h != null && day.sleep_h < 6.5) || (avgSleep != null && lastWeekSleep.length >= 3 && avgSleep < 6.5)) {
    const h = day.sleep_h != null ? day.sleep_h : avgSleep;
    out.push({ key: 'sleep', weight: 40 + (6.5 - h) * 10, title: 'Sleep', detail: `You've been sleeping about ${hm(h * 60)}. Try to be in bed by 10:30 PM tonight.` });
  }
  // Spend
  if (budget && budget.remaining != null && budget.income) {
    if (budget.remaining < 0) out.push({ key: 'spend', weight: 70, title: 'Spending', detail: budget.message });
    else if (budget.remaining < budget.income * 0.1) out.push({ key: 'spend', weight: 50, title: 'Spending', detail: `Only ${inr(budget.remaining)} left this month after bills. Keep today's spending small.` });
  }
  const m = monthMoney(ctx, ctx.D);
  const over = m.budgets.filter((b) => (m.byCat[b.category] || 0) > b.amount);
  if (over.length && !out.some((p) => p.key === 'spend')) {
    out.push({ key: 'spend', weight: 45, title: 'Spending', detail: `You're over your ${over[0].category} budget by ${inr((m.byCat[over[0].category] || 0) - over[0].amount)} this month.` });
  }
  return out.sort((a, b) => b.weight - a.weight).slice(0, 3)
    .map((p, i) => ({ key: p.key, rank: i + 1, title: p.title, detail: p.detail, route: ROUTES[p.key] }));
}

// ------------------------------------------------------------
// GET /api/insights/today
// ------------------------------------------------------------
async function todayInsights(userId, { hour = hourNow(), date = today() } = {}) {
  const ctx = await loadContext(userId, date);
  const Y = addDays(date, -1);
  const todayS = computeScore(ctx, date, { isToday: true, hour });
  const yesterdayS = computeScore(ctx, Y, { isToday: false, hour });
  await Promise.all([saveScore(userId, date, todayS), saveScore(userId, Y, yesterdayS)]);
  const change = explainChange(todayS, yesterdayS);

  const t = ctx.targets;
  const nutrition = t ? nutritionSafety({ tdee: t.tdee, target: t.calories, sex: ctx.profile.sex }) : null;
  const day = ctx.days[date];
  const waterGoal = (t && t.water_ml) || (ctx.profile.weight_kg ? 35 * ctx.profile.weight_kg : 2500);
  const hydration = hydrationAdvice({ goal_ml: waterGoal, drunk_ml: day.water, hour });
  const budget = budgetBlock(ctx);
  const tr = await trends(userId, 7, { date });

  return {
    name: firstName(ctx.user && ctx.user.name),
    greeting: greeting(hour),
    date,
    raphscore: {
      overall: todayS.overall,
      label: scoreLabel(todayS.overall),
      delta: change.delta,
      explanation: change.explanation,
      areas: AREAS.map((a) => ({ key: a.key, label: a.label, score: todayS.results[a.key].score, status: todayS.results[a.key].status, note: todayS.results[a.key].note })),
    },
    priorities: priorities(ctx, hour, hydration, budget),
    insight: tr.insights.length ? { text: tr.insights[0], area: tr.insight_areas[0] } : null,
    nutrition,
    hydration,
    budget,
  };
}

// ------------------------------------------------------------
// GET /api/insights/trends?days=7|30
// ------------------------------------------------------------
async function trends(userId, days, { date = today() } = {}) {
  const from = addDays(date, -(days - 1));
  const prevFrom = addDays(from, -days);
  const all = await loadDays(userId, prevFrom, date);
  const cur = dates(from, date).map((d) => all[d]);
  const prev = dates(prevFrom, addDays(from, -1)).map((d) => all[d]);
  const ser = (fn) => cur.map((d) => ({ date: d.date, value: fn(d) }));
  const r1 = (v) => (v == null ? null : calc.round(v, 1));
  const series = {
    steps: ser((d) => d.steps),
    sleep_min: ser((d) => (d.sleep_h == null ? null : calc.round(d.sleep_h * 60))),
    mood: ser((d) => r1(d.mood)),
    water_ml: ser((d) => (d.water == null ? null : calc.round(d.water))),
    spend: ser((d) => (d.expense_n ? calc.round(d.spend) : null)),
    weight: ser((d) => d.weight),
    kcal: ser((d) => (d.food_n ? calc.round(d.kcal) : null)),
  };
  const vals = (list, fn) => list.map(fn).filter((v) => v != null);
  const stepsAvg = avg(vals(cur, (d) => d.steps)); const stepsPrev = avg(vals(prev, (d) => d.steps));
  const sleepAvg = avg(vals(cur, (d) => d.sleep_h)); const sleepPrev = avg(vals(prev, (d) => d.sleep_h));
  const moodAvg = avg(vals(cur, (d) => d.mood));
  const spendDays = cur.filter((d) => d.expense_n); const spendPrevDays = prev.filter((d) => d.expense_n);
  const spendTotal = spendDays.length ? money.rupees(spendDays.reduce((s, d) => s + d.spend_paise, 0)) : null;
  const spendPrev = spendPrevDays.length ? money.rupees(spendPrevDays.reduce((s, d) => s + d.spend_paise, 0)) : null;
  const waterAvg = avg(vals(cur, (d) => d.water)); const kcalAvg = avg(vals(cur.filter((d) => d.food_n), (d) => d.kcal));
  const weights = vals(cur, (d) => d.weight);
  const summaryOut = {
    steps_avg: stepsAvg == null ? null : calc.round(stepsAvg),
    steps_vs_prev_pct: pctChange(stepsAvg, stepsPrev),
    sleep_avg_min: sleepAvg == null ? null : calc.round(sleepAvg * 60),
    sleep_vs_prev_pct: pctChange(sleepAvg, sleepPrev),
    mood_avg: moodAvg == null ? null : calc.round(moodAvg, 1),
    water_avg_ml: waterAvg == null ? null : calc.round(waterAvg),
    kcal_avg: kcalAvg == null ? null : calc.round(kcalAvg),
    spend_total: spendTotal == null ? null : calc.round(spendTotal),
    spend_vs_prev_pct: pctChange(spendTotal, spendPrev),
    weight_change_kg: weights.length >= 2 ? calc.round(weights[weights.length - 1] - weights[0], 1) : null,
  };
  const period = days === 7 ? 'this week' : `over the last ${days} days`;
  const prevName = days === 7 ? 'last week' : `the ${days} days before`;
  const insights = []; const areas = [];
  const add = (text, area) => { insights.push(text); areas.push(area); };
  if (summaryOut.steps_avg != null) {
    const p = summaryOut.steps_vs_prev_pct;
    add(`You're averaging ${num(summaryOut.steps_avg)} steps ${period}${p == null ? '.' : p === 0 ? `, the same as ${prevName}.` : ` — ${Math.abs(p)}% ${p > 0 ? 'higher' : 'lower'} than ${prevName}.`}`, 'fitness');
  }
  if (summaryOut.sleep_avg_min != null) {
    const s = summaryOut.sleep_avg_min;
    add(`You're sleeping ${hm(s)} on average ${period}${s < 420 ? '. Aim for 7 hours or more: an earlier bedtime helps.' : '. Good rest.'}`, 'recovery');
  }
  if (summaryOut.spend_total != null) {
    const p = summaryOut.spend_vs_prev_pct;
    add(`You spent ${inr(summaryOut.spend_total)} ${period}${p == null ? '.' : ` — ${Math.abs(p)}% ${p > 0 ? 'more' : 'less'} than ${prevName}.`}`, 'wealth');
  }
  if (summaryOut.mood_avg != null) add(`Your average mood ${period} is ${summaryOut.mood_avg} out of 5.`, 'mind');
  if (summaryOut.weight_change_kg != null && summaryOut.weight_change_kg !== 0) {
    add(`Your weight changed by ${summaryOut.weight_change_kg > 0 ? '+' : ''}${summaryOut.weight_change_kg} kg ${period}.`, 'health');
  }
  return { days, series, summary: summaryOut, insights, insight_areas: areas };
}

// ------------------------------------------------------------
// GET /api/insights/patterns  ("Life Graph")
// ------------------------------------------------------------
async function patterns(userId, { date = today() } = {}) {
  const end = addDays(date, -1); // today is not finished, so it is left out
  const start = addDays(end, -89);
  const [all, profile] = await Promise.all([
    loadDays(userId, start, end),
    db.get('SELECT step_goal FROM profiles WHERE user_id = $1', [userId]),
  ]);
  const list = Object.values(all);
  const dataDays = list.filter((d) => d.logged).length;
  if (dataDays < MIN_PATTERN_DAYS) return { enough_data: false, days_needed: MIN_PATTERN_DAYS - dataDays, data_days: dataDays, patterns: [] };

  const goal = (profile && profile.step_goal) || 8000;
  const firstExpense = (list.find((d) => d.expense_n) || {}).date;
  // On days the user was tracking money, a day with no expense really is ₹0
  const spendOf = (d) => (firstExpense && d.date >= firstExpense && d.logged ? (d.spend || 0) : null);
  const foodOutOf = (d) => (firstExpense && d.date >= firstExpense && d.logged ? (d.food_out || 0) : null);
  const out = [];
  const meanOf = (arr, fn) => avg(arr.map(fn).filter((v) => v != null));

  // 1) Sleep -> spending
  const shortSleep = list.filter((d) => d.sleep_h != null && d.sleep_h < SHORT_SLEEP_H && spendOf(d) != null);
  const goodSleep = list.filter((d) => d.sleep_h != null && d.sleep_h >= GOOD_SLEEP_H && spendOf(d) != null);
  if (shortSleep.length >= MIN_GROUP_DAYS && goodSleep.length >= MIN_GROUP_DAYS) {
    const a = meanOf(shortSleep, spendOf); const b = meanOf(goodSleep, spendOf);
    const rel = b > 0 ? (a - b) / b : (a > 0 ? 1 : 0);
    if (Math.abs(rel) >= 0.15) {
      out.push({ id: 'sleep_spend', title: rel > 0 ? 'Your sleep affects your spending' : 'You spend less after short nights',
        detail: `On days after <6h sleep you spent ${inr(a)} on average vs ${inr(b)} after 7h+.`,
        strength: Math.abs(rel) >= 0.4 ? 'strong' : 'moderate', sample_days: shortSleep.length + goodSleep.length });
    }
  }
  // 2) Exercise -> mood
  const anyWorkouts = list.some((d) => d.workout_min != null);
  const active = list.filter((d) => d.mood != null && ((d.workout_min || 0) >= 20 || (d.steps != null && d.steps >= goal)));
  const inactive = list.filter((d) => d.mood != null && !active.includes(d) && (d.steps != null || anyWorkouts));
  if (active.length >= MIN_GROUP_DAYS && inactive.length >= MIN_GROUP_DAYS) {
    const a = meanOf(active, (d) => d.mood); const b = meanOf(inactive, (d) => d.mood);
    if (a - b >= 0.3) {
      out.push({ id: 'exercise_mood', title: 'Moving lifts your mood',
        detail: `On active days your mood averages ${calc.round(a, 1)}/5 vs ${calc.round(b, 1)}/5 on less active days.`,
        strength: a - b >= 0.8 ? 'strong' : 'moderate', sample_days: active.length + inactive.length });
    }
  }
  // 3) Sleep -> mood
  const shortMood = list.filter((d) => d.sleep_h != null && d.sleep_h < SHORT_SLEEP_H && d.mood != null);
  const goodMood = list.filter((d) => d.sleep_h != null && d.sleep_h >= GOOD_SLEEP_H && d.mood != null);
  if (shortMood.length >= MIN_GROUP_DAYS && goodMood.length >= MIN_GROUP_DAYS) {
    const a = meanOf(goodMood, (d) => d.mood); const b = meanOf(shortMood, (d) => d.mood);
    if (a - b >= 0.3) {
      out.push({ id: 'sleep_mood', title: 'Better sleep, better mood',
        detail: `After 7h+ sleep your mood averages ${calc.round(a, 1)}/5 vs ${calc.round(b, 1)}/5 after less than 6h.`,
        strength: a - b >= 0.8 ? 'strong' : 'moderate', sample_days: shortMood.length + goodMood.length });
    }
  }
  // 4) Weekend share of spending
  const tracked = list.filter((d) => spendOf(d) != null);
  const weekend = tracked.filter((d) => [0, 6].includes(weekday(d.date)));
  const weekdays = tracked.filter((d) => ![0, 6].includes(weekday(d.date)));
  if (weekend.length >= MIN_GROUP_DAYS && weekdays.length >= MIN_GROUP_DAYS) {
    const total = tracked.reduce((s, d) => s + spendOf(d), 0);
    const we = weekend.reduce((s, d) => s + spendOf(d), 0);
    const a = we / weekend.length; const b = (total - we) / weekdays.length;
    const ratio = b > 0 ? a / b : (a > 0 ? 2 : 1);
    if (total > 0 && (ratio >= 1.3 || ratio <= 0.7)) {
      const share = calc.round((we / total) * 100);
      out.push({ id: 'weekend_spend', title: ratio >= 1.3 ? 'Your spending increases on weekends' : 'You spend less on weekends',
        detail: `${share}% of your spending happens on Saturdays and Sundays: ${inr(a)} a day vs ${inr(b)} on weekdays.`,
        strength: ratio >= 1.8 || ratio <= 0.5 ? 'strong' : 'moderate', sample_days: tracked.length });
    }
  }
  // 5) Food delivery after poor sleep
  const shortFood = list.filter((d) => d.sleep_h != null && d.sleep_h < SHORT_SLEEP_H && foodOutOf(d) != null);
  const goodFood = list.filter((d) => d.sleep_h != null && d.sleep_h >= GOOD_SLEEP_H && foodOutOf(d) != null);
  if (shortFood.length >= MIN_GROUP_DAYS && goodFood.length >= MIN_GROUP_DAYS) {
    const a = meanOf(shortFood, foodOutOf); const b = meanOf(goodFood, foodOutOf);
    if (a > 0 && (b === 0 || a / b >= 1.2)) {
      out.push({ id: 'food_delivery_sleep', title: 'You order more food after poor sleep',
        detail: `After nights under 6h you spent ${inr(a)} on food delivery and eating out on average, vs ${inr(b)} after 7h+.`,
        strength: b === 0 || a / b >= 1.6 ? 'strong' : 'moderate', sample_days: shortFood.length + goodFood.length });
    }
  }
  return { enough_data: true, days_needed: 0, data_days: dataDays, patterns: out };
}

// ------------------------------------------------------------
// GET /api/insights/brief
// ------------------------------------------------------------
async function brief(userId, { hour = hourNow(), date = today() } = {}) {
  const ins = await todayInsights(userId, { hour, date });
  const ctx = await loadContext(userId, date);
  const d = ctx.days[date]; const y = ctx.days[addDays(date, -1)];
  const t = ctx.targets;
  const sections = [];

  // Health
  const h = [];
  if (d.sleep_h != null) h.push(`You slept ${hm(d.sleep_h * 60)} last night${d.sleep_h < 6.5 ? ', a bit short, so go easy on yourself today' : ''}.`);
  if (y.food_n) h.push(`Yesterday you ate ${num(y.kcal)} kcal${t ? ` (target ${num(t.calories)})` : ''} with ${calc.round(y.protein)} g protein.`);
  if (y.water != null) h.push(`You drank ${(y.water / 1000).toFixed(1)} L of water yesterday.`);
  sections.push({ area: 'health', text: h.length ? h.join(' ') : 'Start tracking your sleep, meals and water, and I\'ll summarise them here each morning.' });

  // Fitness
  const f = [];
  const goal = ctx.profile.step_goal || 8000;
  if (y.steps != null) f.push(`Yesterday you walked ${num(y.steps)} steps (${calc.round((y.steps / goal) * 100)}% of your ${num(goal)} goal).`);
  if (y.workout_min) f.push(`You also worked out for ${calc.round(y.workout_min)} minutes. Well done.`);
  const tr = await trends(userId, 7, { date });
  if (tr.summary.steps_avg != null) f.push(`Your 7-day average is ${num(tr.summary.steps_avg)} steps.`);
  sections.push({ area: 'fitness', text: f.length ? f.join(' ') : 'Sync your steps or log a workout and I\'ll track your progress here.' });

  // Money
  const b = ins.budget;
  const mtext = [];
  if (y.expense_n) mtext.push(`Yesterday you spent ${inr(y.spend)}.`);
  if (b) mtext.push(b.message);
  sections.push({ area: 'money', text: mtext.length ? mtext.join(' ') : 'Add your income and log expenses, and I\'ll show how your month is going.' });

  // One clear priority
  const top = ins.priorities[0];
  let priority = 'Keep your streak going: log your meals, water and mood today.';
  if (top) {
    if (top.key === 'move') {
      const behind = d.steps != null ? goal - d.steps : goal;
      const minutes = clamp(Math.round(behind / 100 / 5) * 5, 10, 45);
      priority = `Take a ${minutes}-minute walk today.`;
    } else if (top.key === 'hydrate') priority = 'Drink a glass of water now and keep a bottle nearby.';
    else if (top.key === 'log_food') priority = 'Log your meals today so I can guide your nutrition.';
    else if (top.key === 'protein') priority = 'Add a protein-rich food to your next meal: dal, eggs, paneer or curd.';
    else if (top.key === 'sleep') priority = 'Aim to be in bed by 10:30 PM tonight.';
    else if (top.key === 'spend') priority = 'Keep today a low-spend day: skip one non-essential purchase.';
  }
  return { date, title: "Here's your HeartPurse briefing", raphscore: ins.raphscore.overall, sections, priority };
}

// ------------------------------------------------------------
// GET /api/insights/profile ("Your patterns")
// ------------------------------------------------------------
async function userProfile(userId, { date = today() } = {}) {
  const end = date; const start = addDays(end, -29);
  const [all, ctx, pat] = await Promise.all([loadDays(userId, start, end), loadContext(userId, date), patterns(userId, { date })]);
  const list = Object.values(all);
  const v = (fn) => list.map(fn).filter((x) => x != null);
  const sleep = avg(v((d) => d.sleep_h)); const steps = avg(v((d) => d.steps)); const mood = avg(v((d) => d.mood));
  const protein = avg(list.filter((d) => d.food_n).map((d) => d.protein));
  const budget = budgetBlock(ctx);
  const traits = pat.patterns.map((p) => p.title + '.');
  // Most active day of the week
  const byWd = {};
  for (const d of list) if (d.steps != null) (byWd[weekday(d.date)] = byWd[weekday(d.date)] || []).push(d.steps);
  const wdEntries = Object.entries(byWd).filter(([, a]) => a.length >= 2);
  if (wdEntries.length >= 4) {
    const [best] = wdEntries.sort((a, b) => avg(b[1]) - avg(a[1]));
    const names = ['Sundays', 'Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays'];
    traits.push(`You're most active on ${names[best[0]]}.`);
  }
  if (sleep != null) traits.push(sleep >= 7 ? `You usually sleep well: about ${hm(sleep * 60)} a night.` : `You usually sleep about ${hm(sleep * 60)}. A little more rest would help.`);
  if (protein != null && ctx.targets) traits.push(protein >= ctx.targets.protein_g * 0.9 ? 'You usually hit your protein target.' : `You usually eat about ${calc.round(protein)} g protein, below your ${ctx.targets.protein_g} g target.`);
  return {
    sleep_avg_min: sleep == null ? null : calc.round(sleep * 60),
    steps_avg: steps == null ? null : calc.round(steps),
    savings_rate: budget ? budget.savings_rate : null,
    protein_avg_g: protein == null ? null : calc.round(protein),
    mood_avg: mood == null ? null : calc.round(mood, 1),
    traits,
  };
}

module.exports = {
  AREAS,
  todayInsights,
  trends,
  patterns,
  brief,
  userProfile,
  loadContext,
  computeScore,
  monthMoney,
  // pure helpers (tested directly)
  nutritionSafety,
  hydrationAdvice,
  combineAreas,
  explainChange,
  scoreLabel,
  dayFraction,
  inr,
  hm,
};
