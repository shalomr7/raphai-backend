// admin/metrics.js
// ------------------------------------------------------------
// Aggregate business + product metrics for the owner dashboard.
// Rules (Privacy Policy + DPDP Act; see docs/ADMIN.md):
//   - Only AGGREGATES across users. No names, emails, phone numbers, user ids
//     or any one person's health or money records ever leave this file.
//   - Any group of 1-4 users is shown as "<5" (MIN_GROUP). An average or a
//     percentage built from fewer than 5 users is "<5" too.
//   - A metric with no data source is { not_tracked: true, note } and the
//     page shows "Not tracked yet". Nothing is ever made up.
// ------------------------------------------------------------

const db = require('../db');
const { PLANS, BASE_PLANS, LIMITS } = require('../utils/plans');
const { today, addDays, thisMonth } = require('../utils/dates');
const metricsMw = require('../middleware/requestMetrics');

const MIN_GROUP = 5;
const SMALL = '<5';
const tz = () => process.env.APP_TZ || 'Asia/Kolkata';

// A count of users (or anything tied to users): 1-4 -> "<5"
function count(n) { n = Number(n) || 0; return n > 0 && n < MIN_GROUP ? SMALL : n; }
// Percentage of users: suppressed if the group or the part is 1-4 users
function pct(part, whole) {
  part = Number(part) || 0; whole = Number(whole) || 0;
  if (!whole) return null;
  if (whole < MIN_GROUP || (part > 0 && part < MIN_GROUP)) return SMALL;
  return Math.round((part / whole) * 1000) / 10;
}
// Average over users: suppressed below 5 users
function avg(value, users, digits = 0) {
  if (!Number(users)) return null;
  if (Number(users) < MIN_GROUP) return SMALL;
  const f = 10 ** digits;
  return Math.round(Number(value) * f) / f;
}
const notTracked = (note) => ({ not_tracked: true, note });

function lastDays(n) {
  const D = today();
  const out = [];
  for (let i = n - 1; i >= 0; i--) out.push(addDays(D, -i));
  return out;
}

// Local (APP_TZ) date of users.created_at (TEXT 'YYYY-MM-DD HH:MM:SS' in UTC)
const SIGNUP_DATE = "to_char((u.created_at::timestamp AT TIME ZONE 'UTC') AT TIME ZONE @tz, 'YYYY-MM-DD')";

// One row per (user, local date) the user did something in the app
// (logged anything, used the coach/food parse, signed in, or opened the app).
// Background Health Connect syncs (activity_daily) do NOT count as active.
const ACTIVE_DAYS = `
  SELECT a.user_id, a.date FROM (
    SELECT user_id, date FROM food_logs WHERE date >= @from
    UNION SELECT user_id, date FROM step_logs WHERE date >= @from
    UNION SELECT user_id, date FROM water_logs WHERE date >= @from
    UNION SELECT user_id, date FROM workouts WHERE date >= @from
    UNION SELECT user_id, date FROM sleep_logs WHERE date >= @from
    UNION SELECT user_id, date FROM mood_logs WHERE date >= @from
    UNION SELECT user_id, date FROM weight_logs WHERE date >= @from
    UNION SELECT user_id, date FROM expenses WHERE date >= @from
    UNION SELECT user_id, date FROM feature_usage WHERE date >= @from
    UNION SELECT user_id, to_char(created_at AT TIME ZONE @tz, 'YYYY-MM-DD') FROM security_logs
      WHERE event = 'login_success' AND user_id IS NOT NULL AND created_at >= now() - interval '75 days'
    UNION SELECT id, to_char(last_active_at AT TIME ZONE @tz, 'YYYY-MM-DD') FROM users WHERE last_active_at IS NOT NULL
  ) a JOIN users uu ON uu.id = a.user_id
  WHERE a.date >= @from AND a.date <= @to`;

// ---------------- Growth ----------------
async function growth() {
  const D = today();
  const days = lastDays(30);
  const P = { tz: tz(), from: addDays(D, -70), to: D };
  const total = (await db.get('SELECT count(*)::int AS n FROM users')).n;
  const signupRows = await db.all(`SELECT ${SIGNUP_DATE} AS d, count(*)::int AS n FROM users u
    WHERE ${SIGNUP_DATE} >= @start GROUP BY 1`, { tz: tz(), start: days[0] });
  const byDay = Object.fromEntries(signupRows.map((r) => [r.d, r.n]));
  const signups = days.map((d) => ({ date: d, value: count(byDay[d] || 0) }));
  const signups30 = signupRows.reduce((s, r) => s + r.n, 0);

  const act = await db.get(`WITH act AS (${ACTIVE_DAYS})
    SELECT count(DISTINCT user_id) FILTER (WHERE date = @to)::int AS dau,
           count(DISTINCT user_id) FILTER (WHERE date >= @w)::int AS wau,
           count(DISTINCT user_id) FILTER (WHERE date >= @m)::int AS mau
    FROM act`, { ...P, w: addDays(D, -6), m: addDays(D, -29) });

  // Retention: of users who signed up in the 30 days before day N could be
  // reached, how many were active exactly N days after signing up.
  const retention = {};
  for (const n of [1, 7, 30]) {
    const r = await db.get(`WITH act AS (${ACTIVE_DAYS}),
      cohort AS (SELECT u.id, ${SIGNUP_DATE} AS sd FROM users u WHERE ${SIGNUP_DATE} BETWEEN @cfrom AND @cto)
      SELECT count(*)::int AS cohort,
             count(*) FILTER (WHERE EXISTS (SELECT 1 FROM act WHERE act.user_id = cohort.id
               AND act.date = to_char(cohort.sd::date + @n::int, 'YYYY-MM-DD')))::int AS kept
      FROM cohort`, { ...P, n, cfrom: addDays(D, -n - 29), cto: addDays(D, -n) });
    retention[`d${n}`] = { pct: pct(r.kept, r.cohort), cohort: count(r.cohort) };
  }

  const del = await db.get(`SELECT count(*) FILTER (WHERE created_at >= now() - interval '30 days')::int AS d30,
    count(*)::int AS d365 FROM security_logs WHERE event = 'account_deleted'`);

  return {
    total_users: total,
    new_signups_30d: count(signups30),
    signups_by_day: signups,
    dau: count(act.dau), wau: count(act.wau), mau: count(act.mau),
    stickiness_dau_mau_pct: pct(act.dau, act.mau),
    retention,
    deleted_accounts: { last_30_days: count(del.d30), last_12_months: count(del.d365) },
    notes: {
      active: 'Active = logged anything, used the coach or food parse, signed in, or opened the app that day (India time). Background step syncs do not count.',
      retention: 'Dn = of users who signed up in the 30 days before day N was possible, % active exactly N days after signing up.',
      deleted: 'From the security log (kept 1 year).',
    },
  };
}

// ---------------- Subscriptions / revenue ----------------
const PERIOD_TO_BASE = { monthly: 'monthly', quarterly: 'quarterly', yearly: 'yearly', monthly_prepaid: 'monthly-prepaid' };

// Same classification as middleware/requirePlan currentPlan(), plus trials.
const SUB_STATE_SQL = `
  SELECT u.id AS user_id, COALESCE(s.plan, 'free') AS plan, s.period, s.status, s.expires_at, s.auto_renew,
         s.source, COALESCE(s.trial_used, 0) AS trial_used, COALESCE(g.in_trial, 0) AS in_trial, COALESCE(g.test_purchase, 0) AS test_purchase,
         (COALESCE(s.plan, 'free') <> 'free' AND s.status = 'active'
           AND (s.expires_at IS NULL OR s.expires_at::timestamptz > now())) AS is_active
  FROM users u
  LEFT JOIN subscriptions s ON s.user_id = u.id
  LEFT JOIN google_play_purchases g ON g.purchase_token = s.google_purchase_token`;

function classify(r) {
  if (!r.is_active) return 'free';
  if (r.period === 'trial' || Number(r.in_trial) === 1) return 'trial';
  return 'paid';
}

function listPrice(plan, period) {
  const p = PLANS[plan]; if (!p) return null;
  const key = PERIOD_TO_BASE[period] || 'monthly';
  const price = p.prices[key];
  const months = (BASE_PLANS[key] && BASE_PLANS[key].months) || 1;
  return price == null ? null : { price, months, key };
}

async function revenue() {
  const rows = await db.all(SUB_STATE_SQL);
  const everTrial = new Set((await db.all(`SELECT DISTINCT user_id FROM google_play_purchases
    WHERE user_id IS NOT NULL AND (in_trial = 1 OR offer_id LIKE 'trial%')`)).map((r) => r.user_id));
  let free = 0; let trial = 0; let paid = 0; let mrrPaise = 0; let testPaid = 0; let willNotRenew = 0;
  let trialEnded = 0; let converted = 0;
  const byPlan = {};
  for (const r of rows) {
    const c = classify(r);
    if (c === 'free') free++;
    else if (c === 'trial') trial++;
    else {
      paid++;
      const label = `${PLANS[r.plan] ? PLANS[r.plan].name : r.plan} ${String(r.period || 'monthly').replace('_', ' ')}`;
      byPlan[label] = (byPlan[label] || 0) + 1;
      if (Number(r.test_purchase) === 1) testPaid++;
      else {
        const lp = listPrice(r.plan, r.period);
        if (lp) mrrPaise += Math.round((lp.price * 100) / lp.months);
      }
      if (r.source === 'google_play' && Number(r.auto_renew) === 0 && r.period !== 'monthly_prepaid') willNotRenew++;
    }
    const trialed = Number(r.trial_used) === 1 || everTrial.has(r.user_id);
    if (trialed && c !== 'trial') { trialEnded++; if (c === 'paid') converted++; }
  }
  const ended30 = await db.get(`SELECT count(DISTINCT user_id)::int AS n FROM google_play_purchases
    WHERE user_id IS NOT NULL AND test_purchase = 0 AND updated_at >= now() - interval '30 days'
      AND subscription_state IN ('SUBSCRIPTION_STATE_CANCELED', 'SUBSCRIPTION_STATE_EXPIRED', 'SUBSCRIPTION_STATE_ON_HOLD', 'SUBSCRIPTION_STATE_PAUSED')`);
  const revoked30 = await db.get(`SELECT count(DISTINCT user_id)::int AS n FROM google_play_purchases
    WHERE user_id IS NOT NULL AND revoked_at >= now() - interval '30 days'`);

  return {
    plans: { free: count(free), trial: count(trial), paid: count(paid) },
    paid_by_plan: Object.entries(byPlan).sort((a, b) => b[1] - a[1]).map(([label, n]) => ({ label, value: count(n) })),
    active_subscriptions: count(paid + trial),
    trial_to_paid_pct: pct(converted, trialEnded),
    trial_ended_users: count(trialEnded),
    estimated_mrr_inr: Math.round(mrrPaise / 100),
    test_purchases_excluded: count(testPaid),
    cancellations: {
      paid_set_to_not_renew: count(willNotRenew),
      play_cancelled_or_expired_30d: count(ended30.n),
      refunded_or_revoked_30d: count(revoked30.n),
      in_app_downgrades: notTracked('Switching back to Free in the app is not recorded yet.'),
    },
    notes: {
      mrr: 'Estimated from list prices in the app (yearly / 12, quarterly / 3). Google Play is the source of truth for what people actually paid (offers, legacy prices, taxes). Trials and Play test purchases are excluded.',
      conversion: 'Of users whose trial has ended, % now on a paid plan.',
    },
  };
}

// ---------------- Health (aggregates only) ----------------
async function health() {
  const D = today(); const a7 = addDays(D, -6); const a30 = addDays(D, -29);
  const total = (await db.get('SELECT count(*)::int AS n FROM users')).n;

  const st = await db.get(`WITH s AS (
      SELECT user_id, date, max(steps) AS steps FROM (
        SELECT user_id, date, steps FROM activity_daily WHERE date BETWEEN @a AND @d AND steps IS NOT NULL
        UNION ALL SELECT user_id, date, steps FROM step_logs WHERE date BETWEEN @a AND @d) x
      GROUP BY user_id, date),
    pu AS (SELECT s.user_id, avg(s.steps) AS avg_steps, COALESCE(max(p.step_goal), 8000) AS goal
      FROM s LEFT JOIN profiles p ON p.user_id = s.user_id GROUP BY s.user_id)
    SELECT count(*)::int AS users, COALESCE(avg(avg_steps), 0) AS avg_steps,
           count(*) FILTER (WHERE avg_steps >= goal)::int AS hit FROM pu`, { a: a7, d: D });

  const hc = await db.get(`SELECT count(*) FILTER (WHERE c.granted)::int AS granted FROM (
      SELECT DISTINCT ON (user_id) user_id, granted FROM consents
      WHERE type = 'health_connect' AND account_deleted_at IS NULL ORDER BY user_id, created_at DESC, id DESC) c
    JOIN users u ON u.id = c.user_id`);
  const hcSync = await db.get(`SELECT count(DISTINCT user_id)::int AS n FROM activity_daily
    WHERE source = 'health_connect' AND date BETWEEN @a AND @d`, { a: a7, d: D });

  const water = await db.get(`WITH w AS (SELECT user_id, date, sum(ml) AS ml FROM water_logs WHERE date BETWEEN @a AND @d GROUP BY 1, 2),
    pu AS (SELECT user_id, avg(ml) AS ml FROM w GROUP BY 1)
    SELECT count(*)::int AS users, COALESCE(avg(ml), 0) AS ml FROM pu`, { a: a7, d: D });

  const food = await db.get(`WITH f AS (SELECT user_id, count(DISTINCT date) AS days FROM food_logs WHERE date BETWEEN @a AND @d GROUP BY 1)
    SELECT count(*)::int AS users, COALESCE(avg(days), 0) AS days FROM f`, { a: a7, d: D });
  const days14 = lastDays(14);
  const foodDaily = await db.all(`SELECT date, count(DISTINCT user_id)::int AS n FROM food_logs WHERE date >= @s GROUP BY 1`, { s: days14[0] });
  const fd = Object.fromEntries(foodDaily.map((r) => [r.date, r.n]));

  const bmi = await db.all(`WITH b AS (SELECT weight_kg / ((height_cm / 100.0) ^ 2) AS bmi FROM profiles p JOIN users u ON u.id = p.user_id
      WHERE height_cm BETWEEN 100 AND 250 AND weight_kg BETWEEN 20 AND 350)
    SELECT CASE WHEN bmi < 18.5 THEN 'Under 18.5' WHEN bmi < 23 THEN '18.5-22.9' WHEN bmi < 25 THEN '23-24.9'
                WHEN bmi < 30 THEN '25-29.9' ELSE '30+' END AS bucket, count(*)::int AS n FROM b GROUP BY 1`);
  const BMI_ORDER = ['Under 18.5', '18.5-22.9', '23-24.9', '25-29.9', '30+'];
  const bm = Object.fromEntries(bmi.map((r) => [r.bucket, r.n]));

  const wt = await db.all(`WITH w AS (SELECT user_id, date, weight_kg,
        row_number() OVER (PARTITION BY user_id ORDER BY date, id) AS rn_first,
        row_number() OVER (PARTITION BY user_id ORDER BY date DESC, id DESC) AS rn_last,
        count(*) OVER (PARTITION BY user_id) AS cnt
      FROM weight_logs WHERE date BETWEEN @a AND @d),
    t AS (SELECT user_id, max(weight_kg) FILTER (WHERE rn_last = 1) - max(weight_kg) FILTER (WHERE rn_first = 1) AS delta
      FROM w WHERE cnt >= 2 GROUP BY user_id)
    SELECT CASE WHEN delta < -0.5 THEN 'Losing' WHEN delta > 0.5 THEN 'Gaining' ELSE 'Stable (within 0.5 kg)' END AS bucket, count(*)::int AS n
    FROM t GROUP BY 1`, { a: a30, d: D });
  const wm = Object.fromEntries(wt.map((r) => [r.bucket, r.n]));

  const workouts = await db.all(`SELECT activity, count(DISTINCT user_id)::int AS users, count(*)::int AS sessions
    FROM workouts WHERE date BETWEEN @a AND @d GROUP BY activity ORDER BY users DESC, sessions DESC LIMIT 20`, { a: a30, d: D });
  const shown = workouts.filter((w) => w.users >= MIN_GROUP).slice(0, 8);
  const smallGroups = workouts.length - shown.length;
  const featureUse = await db.all(`SELECT feature, count(DISTINCT user_id)::int AS users FROM feature_usage
    WHERE date BETWEEN @a AND @d GROUP BY feature`, { a: a30, d: D });
  const fu = Object.fromEntries(featureUse.map((r) => [r.feature, r.users]));
  const users30 = async (table) => (await db.get(`SELECT count(DISTINCT user_id)::int AS n FROM ${table} WHERE date BETWEEN @a AND @d`, { a: a30, d: D })).n;

  return {
    avg_daily_steps_7d: avg(st.avg_steps, st.users),
    step_goal_hit_pct_7d: pct(st.hit, st.users),
    users_with_steps_7d: count(st.users),
    health_connect_connected_pct: pct(hc.granted, total),
    health_connect_syncing_7d: count(hcSync.n),
    avg_water_ml_7d: avg(water.ml, water.users),
    calorie_logging: {
      users_logging_food_7d: count(food.users),
      pct_of_users_7d: pct(food.users, total),
      avg_logging_days_per_week: avg(food.days, food.users, 1),
      loggers_by_day: days14.map((d) => ({ date: d, value: count(fd[d] || 0) })),
    },
    bmi_distribution: BMI_ORDER.map((b) => ({ label: b, value: count(bm[b] || 0) })),
    weight_trend_30d: ['Losing', 'Stable (within 0.5 kg)', 'Gaining'].map((b) => ({ label: b, value: count(wm[b] || 0) })),
    fitness_features_30d: [
      { label: 'Step tracking', value: count(await users30('step_logs')) },
      { label: 'Workout logging', value: count(await users30('workouts')) },
      { label: 'Water', value: count(await users30('water_logs')) },
      { label: 'Sleep', value: count(await users30('sleep_logs')) },
      { label: 'Weight', value: count(await users30('weight_logs')) },
      { label: 'Mood', value: count(await users30('mood_logs')) },
      { label: 'AI food parse', value: count(fu.food_parse || 0) },
    ],
    top_workouts_30d: shown.map((w) => ({ label: w.activity, users: w.users, sessions: w.sessions })),
    workout_types_hidden_small: smallGroups,
    hiit_plans: notTracked('HIIT plan use happens in the app and is not sent to the server.'),
    notes: {
      bmi: 'Asian-Indian cut-offs (23 and 25) from each profile\'s current height and weight. Groups of 1-4 people show "<5".',
      steps: 'Average of each user\'s 7-day average (Health Connect or pedometer).',
      fitness: 'Distinct users using each feature in the last 30 days.',
    },
  };
}

// ---------------- Money (aggregates only) ----------------
async function money() {
  const D = today(); const a30 = addDays(D, -29); const month = thisMonth();
  const total = (await db.get('SELECT count(*)::int AS n FROM users')).n;
  const budgets = (await db.get('SELECT count(DISTINCT user_id)::int AS n FROM budgets WHERE month = $1', [month])).n;
  const goals = (await db.get('SELECT count(DISTINCT user_id)::int AS n FROM savings_goals')).n;

  const sr = await db.get(`WITH sp AS (SELECT user_id, sum(amount_paise) AS spent FROM expenses WHERE date BETWEEN @a AND @d GROUP BY 1),
    r AS (SELECT GREATEST(-1, LEAST(1, (p.income_paise - sp.spent)::float8 / p.income_paise)) AS rate
      FROM sp JOIN profiles p ON p.user_id = sp.user_id WHERE p.income_paise > 0)
    SELECT count(*)::int AS users, COALESCE(avg(rate), 0) AS rate FROM r`, { a: a30, d: D });

  const cats = await db.all(`SELECT category, sum(amount_paise)::float8 AS spent, count(DISTINCT user_id)::int AS users
    FROM expenses WHERE date BETWEEN @a AND @d GROUP BY category ORDER BY spent DESC`, { a: a30, d: D });
  const totalSpent = cats.reduce((s, c) => s + c.spent, 0);
  const spenders = (await db.get('SELECT count(DISTINCT user_id)::int AS n FROM expenses WHERE date BETWEEN $1 AND $2', [a30, D])).n;
  let topCats = [];
  if (spenders >= MIN_GROUP && totalSpent > 0) {
    const big = cats.filter((c) => c.users >= MIN_GROUP);
    const otherSpent = cats.filter((c) => c.users < MIN_GROUP).reduce((s, c) => s + c.spent, 0);
    topCats = big.slice(0, 8).map((c) => ({ label: c.category, share_pct: Math.round((c.spent / totalSpent) * 1000) / 10 }));
    const rest = big.slice(8).reduce((s, c) => s + c.spent, 0) + otherSpent;
    if (rest > 0) topCats.push({ label: 'Other (incl. small groups)', share_pct: Math.round((rest / totalSpent) * 1000) / 10 });
  }

  const gc = await db.get(`SELECT count(*)::int AS goals, count(*) FILTER (WHERE saved >= target)::int AS done,
    count(DISTINCT user_id)::int AS users, count(DISTINCT user_id) FILTER (WHERE saved >= target)::int AS users_done
    FROM savings_goals WHERE target > 0`);

  return {
    users_with_budget_this_month_pct: pct(budgets, total),
    users_with_savings_goal_pct: pct(goals, total),
    avg_savings_rate_30d_pct: sr.users >= MIN_GROUP ? Math.round(sr.rate * 1000) / 10 : (sr.users ? SMALL : null),
    savings_rate_users: count(sr.users),
    top_spending_categories_30d: spenders >= MIN_GROUP ? topCats : (spenders ? SMALL : []),
    goal_completion: {
      goals_completed_pct: gc.users >= MIN_GROUP ? (gc.goals ? Math.round((gc.done / gc.goals) * 1000) / 10 : null) : (gc.users ? SMALL : null),
      users_with_a_completed_goal: count(gc.users_done),
    },
    calculators: {
      persistent: notTracked('SIP and EMI calculator use is not stored per day yet.'),
      since_server_start: {
        sip: metricsMw.hits('GET', '/api/wealth/calculators/sip'),
        emi: metricsMw.hits('GET', '/api/wealth/calculators/emi'),
        since: metricsMw.STARTED_AT.toISOString(),
      },
    },
    notes: {
      savings_rate: '(monthly income - last 30 days spend) / income, per user with an income set, capped at -100%..100%, averaged.',
      categories: 'Share of all spending in the last 30 days. Only categories used by 5+ people are named.',
    },
  };
}

// ---------------- AI coach ----------------
async function coach() {
  const D = today(); const a30 = addDays(D, -29);
  const days = lastDays(14);
  const daily = await db.all(`SELECT date, sum(count)::int AS chats, count(DISTINCT user_id)::int AS users
    FROM feature_usage WHERE feature IN ('coach', 'coach_ai') AND date >= @s GROUP BY date`, { s: days[0] });
  const dm = Object.fromEntries(daily.map((r) => [r.date, r]));
  const sums = await db.get(`SELECT COALESCE(sum(count) FILTER (WHERE feature = 'coach_ai'), 0)::int AS ai,
      COALESCE(sum(count) FILTER (WHERE feature = 'coach'), 0)::int AS free_rule,
      count(DISTINCT user_id) FILTER (WHERE feature = 'coach_ai')::int AS ai_users,
      count(DISTINCT user_id) FILTER (WHERE feature IN ('coach', 'coach_ai'))::int AS users
    FROM feature_usage WHERE date BETWEEN @a AND @d`, { a: a30, d: D });
  const freeLimit = LIMITS.free.coach_per_day;
  const limits = await db.get(`SELECT
      count(*) FILTER (WHERE f.feature = 'coach' AND f.count >= @fl)::int AS free_hits,
      count(DISTINCT f.user_id) FILTER (WHERE f.feature = 'coach' AND f.count >= @fl)::int AS free_hit_users,
      count(*) FILTER (WHERE f.feature = 'coach_ai' AND f.count >= CASE COALESCE(s.plan, 'free')
        WHEN 'plus' THEN @lp WHEN 'pro' THEN @lpr WHEN 'elite' THEN @le ELSE 999999 END)::int AS ai_hits,
      count(DISTINCT f.user_id) FILTER (WHERE f.feature = 'coach_ai' AND f.count >= CASE COALESCE(s.plan, 'free')
        WHEN 'plus' THEN @lp WHEN 'pro' THEN @lpr WHEN 'elite' THEN @le ELSE 999999 END)::int AS ai_hit_users
    FROM feature_usage f LEFT JOIN subscriptions s ON s.user_id = f.user_id
    WHERE f.date BETWEEN @a AND @d`, {
    a: a30, d: D, fl: freeLimit,
    lp: LIMITS.plus.ai_coach_per_day || 999999, lpr: LIMITS.pro.ai_coach_per_day || 999999, le: LIMITS.elite.ai_coach_per_day || 999999,
  });
  return {
    chats_by_day: days.map((d) => ({ date: d, value: dm[d] ? (dm[d].users < MIN_GROUP ? SMALL : dm[d].chats) : 0 })),
    chat_users_30d: count(sums.users),
    ai_answers_30d: sums.users >= MIN_GROUP ? sums.ai : (sums.ai ? SMALL : 0),
    free_rule_based_answers_30d: sums.users >= MIN_GROUP ? sums.free_rule : (sums.free_rule ? SMALL : 0),
    gemini_vs_fallback: notTracked('Only AI answers and Free-plan answers are counted. Rule-based answers on paid plans (incl. fallback after the AI allowance) are not counted yet.'),
    topics: notTracked('Coach topics (health / money / other) are not recorded yet.'),
    daily_limit_hits_30d: {
      free_limit_reached_user_days: count(limits.free_hits),
      free_limit_users: count(limits.free_hit_users),
      ai_allowance_used_up_user_days: count(limits.ai_hits),
      ai_allowance_users: count(limits.ai_hit_users),
    },
    guardrail_blocks: notTracked('Guardrail blocks are not recorded yet.'),
    notes: {
      chats: 'Coach questions counted per day: Free-plan rule-based answers + AI (Gemini) answers. Days with fewer than 5 users show "<5".',
      limits: `Free limit = ${freeLimit} questions a day. AI allowance by plan: Plus ${LIMITS.plus.ai_coach_per_day}, Pro ${LIMITS.pro.ai_coach_per_day}, Elite ${LIMITS.elite.ai_coach_per_day} (counted against each user's current plan).`,
    },
  };
}

// ---------------- App health ----------------
async function app() {
  const pkg = require('../../package.json');
  const migrations = await db.all('SELECT id, applied_at FROM schema_migrations ORDER BY id DESC LIMIT 5');
  const commit = process.env.RENDER_GIT_COMMIT || null;
  return {
    requests: metricsMw.snapshot(),
    deploy: {
      version: pkg.version,
      commit: commit ? commit.slice(0, 7) : null,
      branch: process.env.RENDER_GIT_BRANCH || null,
      service: process.env.RENDER_SERVICE_NAME || null,
      started_at: metricsMw.STARTED_AT.toISOString(),
      uptime_s: Math.round(process.uptime()),
      node: process.version,
      latest_migrations: migrations.map((m) => ({ id: m.id, applied_at: new Date(m.applied_at).toISOString() })),
      deploy_history: notTracked('Deploy history lives in Render; this server only knows its own commit and start time.'),
    },
    notes: { requests: 'Counted in memory since the server started (Render free sleeps when idle, which resets these). No user data is kept, only route patterns, status codes and timings.' },
  };
}

module.exports = { growth, revenue, health, money, coach, app, count, pct, avg, MIN_GROUP, SMALL, SUB_STATE_SQL, classify, listPrice };
