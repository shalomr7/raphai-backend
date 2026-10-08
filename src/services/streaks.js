// services/streaks.js
// ------------------------------------------------------------
// Two daily streaks (habit loops keep people coming back):
//   1) logging streak    = days in a row where you logged ANYTHING
//                          (food, water, steps, workout, sleep, mood, weight, expense)
//   2) RaphScore streak  = days in a row where your RaphScore was "Good" (60+)
// If today has nothing yet, the streak counts up to yesterday, so it is
// still "alive" until the day ends.
// ------------------------------------------------------------

const db = require('../db');
const calc = require('../utils/calc');
const { today } = require('../utils/dates');
const summary = require('./summary');

const GOOD_SCORE = 60; // RaphScore needed for the day to count
const MAX_DAYS = 120;  // we look back at most this many days

// The day before a 'YYYY-MM-DD' date
function dayBefore(date) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

// All dates (as a Set) on which the user logged something
async function loggedDates(userId) {
  const rows = await db.all(`
    SELECT date FROM food_logs WHERE user_id = $1
    UNION SELECT date FROM water_logs WHERE user_id = $1
    UNION SELECT date FROM step_logs WHERE user_id = $1 AND steps > 0
    UNION SELECT date FROM workouts WHERE user_id = $1
    UNION SELECT date FROM sleep_logs WHERE user_id = $1
    UNION SELECT date FROM mood_logs WHERE user_id = $1
    UNION SELECT date FROM weight_logs WHERE user_id = $1
    UNION SELECT date FROM expenses WHERE user_id = $1
  `, [userId]);
  return new Set(rows.map((r) => r.date));
}

// RaphScore for one day (same maths as the dashboard)
async function raphScoreFor(userId, date, wealthCache) {
  const month = date.slice(0, 7);
  if (!(month in wealthCache)) wealthCache[month] = summary.wealthScore(await summary.wealthMonth(userId, month)).score;
  const health = summary.healthScore(await summary.healthDay(userId, date)).score;
  return calc.round((health + wealthCache[month]) / 2);
}

// Count days in a row where test(date) is true, starting today (or yesterday)
// (test may be async, so we "await" it)
async function countBack(test) {
  let date = today();
  const todayDone = await test(date);
  if (!todayDone) date = dayBefore(date);
  let count = 0;
  while (count < MAX_DAYS && (await test(date))) {
    count++;
    date = dayBefore(date);
  }
  return { days: count, today_done: todayDone };
}

async function streaks(userId) {
  const logged = await loggedDates(userId);
  const logging = await countBack((d) => logged.has(d));

  const cache = {};
  // Only work out RaphScore on days with logs (a day with no logs can't be Good)
  const score = await countBack(async (d) => logged.has(d) && (await raphScoreFor(userId, d, cache)) >= GOOD_SCORE);

  return {
    logging: { ...logging, label: 'Days logged in a row' },
    raph_score: { ...score, min_score: GOOD_SCORE, label: `Days in a row with RaphScore ${GOOD_SCORE}+` },
  };
}

module.exports = { streaks, GOOD_SCORE };
