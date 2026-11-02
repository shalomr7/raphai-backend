// services/streaks.js
// ------------------------------------------------------------
// Two daily streaks (habit loops keep people coming back):
//   1) logging streak    = days in a row where you logged ANYTHING
//                          (food, water, steps, workout, sleep, mood, weight, expense)
//   2) HeartScore streak  = days in a row where your HeartScore was "Good" (60+)
// If today has nothing yet, the streak counts up to yesterday, so it is
// still "alive" until the day ends.
// ------------------------------------------------------------

const db = require('../db');
const { today, addDays, hourNow } = require('../utils/dates');
const intelligence = require('./intelligence');

const GOOD_SCORE = 60; // HeartScore needed for the day to count
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

// HeartScore for one day: the SAME score Home shows (services/intelligence.js
// computeScore: six areas, documented weights, missing areas left out, today
// scored for the part of the day gone so far). Until 2026-11-02 this used an
// older formula (health + wealth only, missing data counted as 0), so the
// "HeartScore 60+" streak did not match the HeartScore on screen.
// One loaded context covers a month (and the week before a date), so a long
// streak needs only a few database round trips.
async function raphScoreFor(userId, date, cache) {
  let ctx = cache.ctx;
  if (!ctx || date > ctx.D || date.slice(0, 7) !== ctx.D.slice(0, 7) || !ctx.days[addDays(date, -6)]) {
    ctx = await intelligence.loadContext(userId, date);
    cache.ctx = ctx;
  }
  const isToday = date === today();
  return intelligence.computeScore(ctx, date, { isToday, hour: hourNow() }).overall;
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
  // Only work out HeartScore on days with logs (a day with no logs can't be Good)
  const score = await countBack(async (d) => logged.has(d) && ((await raphScoreFor(userId, d, cache)) ?? -1) >= GOOD_SCORE);

  return {
    logging: { ...logging, label: 'Days logged in a row' },
    raph_score: { ...score, min_score: GOOD_SCORE, label: `Days in a row with HeartScore ${GOOD_SCORE}+` },
  };
}

module.exports = { streaks, GOOD_SCORE };
