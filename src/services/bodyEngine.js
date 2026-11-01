// services/bodyEngine.js
// ------------------------------------------------------------
// Adaptive Body Goals: the deterministic maths behind the weekly weight
// forecast. No database and no AI here, so every number is testable and
// explainable. The AI coach only EXPLAINS these numbers; it never makes them.
//
// Model "hp-forecast-1" (documented in docs/BODY_GOALS.md):
//  - Weight trend: exponentially smoothed daily weight (alpha 0.1/day, the
//    "Hacker's Diet" trend). Single weigh-ins swing with water and food
//    volume, so the trend, not the last weigh-in, is the starting point.
//  - Resting energy: Katch-McArdle when the user gave a body-fat %, else
//    Mifflin-St Jeor. Daily base use = resting × 1.2 (sitting lifestyle,
//    about 3,000 steps of normal life included).
//  - Steps: net walking cost ≈ 0.5 kcal per kg per km, stride ≈ 0.414 × height,
//    only for steps above the 3,000 already inside the 1.2 base.
//  - Workouts: NET kcal = (MET − 1) × kg × hours (the "1" is already in the
//    resting number). Step-based workouts (walking, running …) are NOT added
//    on days with step data, because their steps are already counted.
//  - Intake: only days the user logged fully (2+ meal types and ≥ 800 kcal).
//    Half-logged days are left out instead of being read as "ate little".
//  - Balance → weight: 7,700 kcal ≈ 1 kg. Shown as a RANGE that widens with
//    estimate error (food ±12 %, energy use ±10 %, workouts ±25 %) and with
//    missing days.
//  - Adaptive: with 2+ weeks of weigh-ins and logs, the energy use seen in
//    the user's own trend is blended 50/50 with the formula (clamped ±25 %).
// ------------------------------------------------------------

const MODEL_VERSION = 'hp-forecast-1';
const KCAL_PER_KG = 7700;
const TREND_ALPHA = 0.1;
const BASE_FACTOR = 1.2;
const BASE_STEPS = 3000;
const MIN_COMPLETE_DAYS = 4;            // of the last 7
const COMPLETE_MIN_MEALS = 2;
const COMPLETE_MIN_KCAL = 800;
const STEP_BASED = new Set(['walking', 'brisk_walking', 'running', 'jogging', 'stairs']);

const r = (n, d = 0) => { const p = 10 ** d; return Math.round(n * p) / p; };
const DAY_MS = 86400000;
const toDay = (s) => Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10)) / DAY_MS;
const fromDay = (n) => new Date(n * DAY_MS).toISOString().slice(0, 10);
const addDays = (date, n) => fromDay(toDay(date) + n);

/** Resting energy (kcal/day) and which formula gave it. */
function restingKcal({ sex, age, height_cm, weight_kg, body_fat_pct }) {
  if (!weight_kg) return null;
  if (body_fat_pct && body_fat_pct > 3 && body_fat_pct < 70) {
    const lean = weight_kg * (1 - body_fat_pct / 100);
    return { kcal: 370 + 21.6 * lean, method: 'katch_mcardle' };
  }
  if (!height_cm || !age || !sex) return null;
  const base = 10 * weight_kg + 6.25 * height_cm - 5 * age;
  return { kcal: sex === 'male' ? base + 5 : base - 161, method: 'mifflin_st_jeor' };
}

/** Net kcal for steps above the everyday baseline. */
function stepKcal(steps, weight_kg, height_cm) {
  if (!steps || steps <= BASE_STEPS) return 0;
  const strideKm = (0.414 * (height_cm || 165)) / 100000;
  return (steps - BASE_STEPS) * strideKm * 0.5 * weight_kg;
}

/** Net kcal of one workout and whether it was counted (dedup with steps). */
function workoutNetKcal(w, weight_kg, dayHasSteps) {
  const met = Number(w.met) || 0;
  const kg = Number(w.weight_kg) || weight_kg;
  const net = Math.max(0, (met - 1) * kg * (Number(w.minutes) / 60));
  if (dayHasSteps && STEP_BASED.has(w.activity)) return { kcal: 0, counted: false, reason: 'steps_already_counted' };
  return { kcal: net, counted: true };
}

/**
 * Smoothed weight trend. weights: [{date, weight_kg}] in any order (several
 * per day are averaged). Returns one point per calendar day from the first
 * weigh-in to `until` (days without a weigh-in carry the trend forward).
 */
function trendSeries(weights, until) {
  const byDay = new Map();
  for (const w of weights || []) {
    const d = String(w.date).slice(0, 10);
    const v = Number(w.weight_kg);
    if (!Number.isFinite(v) || v <= 0) continue;
    const a = byDay.get(d) || [];
    a.push(v); byDay.set(d, a);
  }
  const days = [...byDay.keys()].sort();
  if (!days.length) return [];
  const last = until && until > days[days.length - 1] ? until : days[days.length - 1];
  const out = [];
  let trend = null;
  for (let n = toDay(days[0]); n <= toDay(last); n++) {
    const d = fromDay(n);
    const vals = byDay.get(d);
    const actual = vals ? vals.reduce((s, v) => s + v, 0) / vals.length : null;
    if (actual != null) trend = trend == null ? actual : trend + TREND_ALPHA * (actual - trend);
    out.push({ date: d, actual: actual == null ? null : r(actual, 2), trend: r(trend, 2) });
  }
  return out;
}

/** Least-squares slope (kg/day) of the trend over the last `window` days. */
function trendSlope(series, window = 28) {
  const pts = series.slice(-window);
  if (pts.length < 2) return null;
  const xs = pts.map((_, i) => i); const ys = pts.map((p) => p.trend);
  const mx = xs.reduce((a, b) => a + b, 0) / xs.length; const my = ys.reduce((a, b) => a + b, 0) / ys.length;
  let num = 0; let den = 0;
  for (let i = 0; i < xs.length; i++) { num += (xs[i] - mx) * (ys[i] - my); den += (xs[i] - mx) ** 2; }
  return den ? num / den : null;
}

/** A day is "fully logged" when 2+ meal types and enough food were logged. */
function isComplete(day) {
  return (day.meal_types || 0) >= COMPLETE_MIN_MEALS && (day.intake_kcal || 0) >= COMPLETE_MIN_KCAL;
}

/**
 * Energy use for one day. day: {date, steps|null, workouts:[...]}.
 */
function dayExpenditure(day, profile, resting) {
  const hasSteps = day.steps != null && day.steps > 0;
  const steps = stepKcal(hasSteps ? day.steps : 0, profile.weight_kg, profile.height_cm);
  let workouts = 0; let skipped = 0;
  for (const w of day.workouts || []) {
    const x = workoutNetKcal(w, profile.weight_kg, hasSteps);
    if (x.counted) workouts += x.kcal; else skipped++;
  }
  return { base: resting * BASE_FACTOR, steps, workouts, total: resting * BASE_FACTOR + steps + workouts, skipped_step_workouts: skipped, has_steps: hasSteps };
}

function safetyFlags({ profile, avgIntake, weeklyMid, startKg, goal }) {
  const flags = [];
  const minKcal = profile.sex === 'male' ? 1500 : 1200;
  if (avgIntake != null && avgIntake < minKcal) flags.push('low_intake');
  if (startKg && weeklyMid < 0 && -weeklyMid > startKg * 0.01) flags.push('fast_loss');
  if (weeklyMid > 0.5) flags.push('fast_gain');
  if (profile.height_cm && startKg) {
    const bmi = startKg / (profile.height_cm / 100) ** 2;
    if (bmi < 18.5 && (goal === 'lose' || weeklyMid < 0)) flags.push('underweight_loss');
  }
  if (profile.age != null && profile.age < 18) flags.push('minor');
  return flags;
}

/**
 * Weekly forecast.
 * input: {
 *   today: 'YYYY-MM-DD',
 *   profile: {sex, age, height_cm, weight_kg, body_fat_pct, goal, target_weight_kg},
 *   weights: [{date, weight_kg}]            // actual measurements only
 *   days: [{date, intake_kcal, meal_types, steps, workouts:[{activity, minutes, met, weight_kg}]}] // last 28 days
 * }
 */
function weeklyForecast({ today, profile, weights, days }) {
  const base = { model_version: MODEL_VERSION, made_on: today, horizon_end: addDays(today, 7) };
  if (!profile || !profile.weight_kg || !profile.height_cm || !profile.age || !profile.sex) {
    return { ...base, status: 'need_profile', message: 'Add your age, sex, height and weight so HeartPurse can estimate your energy use.' };
  }
  const series = trendSeries(weights, today);
  const lastActual = [...series].reverse().find((p) => p.actual != null) || null;
  const startKg = series.length ? series[series.length - 1].trend : profile.weight_kg;
  const p = { ...profile, weight_kg: startKg };
  const rest = restingKcal(p);
  const byDate = new Map((days || []).map((d) => [d.date, d]));

  // Last 7 days, ending yesterday (today is still being logged).
  const window = [];
  for (let i = 7; i >= 1; i--) {
    const d = addDays(today, -i);
    window.push(byDate.get(d) || { date: d, intake_kcal: 0, meal_types: 0, steps: null, workouts: [] });
  }
  const complete = window.filter(isComplete);
  const partial = window.filter((d) => !isComplete(d) && (d.meal_types || 0) > 0).length;
  const stepDays = window.filter((d) => d.steps != null && d.steps > 0).length;
  const workoutCount = window.reduce((s, d) => s + (d.workouts || []).length, 0);
  const coverage = { window_days: 7, complete_days: complete.length, partial_days: partial, step_days: stepDays, workouts: workoutCount, weigh_ins_28d: (weights || []).filter((w) => String(w.date).slice(0, 10) > addDays(today, -28)).length, min_complete_days: MIN_COMPLETE_DAYS };

  if (complete.length < MIN_COMPLETE_DAYS) {
    const need = MIN_COMPLETE_DAYS - complete.length;
    return { ...base, status: 'need_logs', coverage, start_weight_kg: r(startKg, 1), last_weigh_in: lastActual,
      message: `Log your meals fully on ${need} more day${need === 1 ? '' : 's'} (at least 2 meals a day) to see your weekly forecast. Half-logged days are left out so they don't look like eating less.` };
  }

  // Averages over fully logged days only.
  const exp = complete.map((d) => dayExpenditure(d, p, rest.kcal));
  const avgIntake = complete.reduce((s, d) => s + d.intake_kcal, 0) / complete.length;
  const avgBase = exp.reduce((s, e) => s + e.base, 0) / exp.length;
  const avgSteps = exp.reduce((s, e) => s + e.steps, 0) / exp.length;
  const avgWorkouts = exp.reduce((s, e) => s + e.workouts, 0) / exp.length;
  let formulaTdee = avgBase + avgSteps + avgWorkouts;

  // Adaptive: energy use implied by the user's own trend (needs 2+ weeks).
  let method = 'formula';
  let observedTdee = null;
  const recentW = (weights || []).filter((w) => String(w.date).slice(0, 10) >= addDays(today, -28));
  const wDays = [...new Set(recentW.map((w) => String(w.date).slice(0, 10)))].sort();
  const longComplete = (days || []).filter((d) => d.date >= addDays(today, -28) && d.date < today && isComplete(d));
  if (wDays.length >= 5 && toDay(wDays[wDays.length - 1]) - toDay(wDays[0]) >= 14 && longComplete.length >= 10) {
    const slope = trendSlope(series.filter((s) => s.date >= wDays[0]), 28);
    if (slope != null) {
      const longIntake = longComplete.reduce((s, d) => s + d.intake_kcal, 0) / longComplete.length;
      observedTdee = Math.min(formulaTdee * 1.25, Math.max(formulaTdee * 0.75, longIntake - slope * KCAL_PER_KG));
      method = 'adaptive';
    }
  }
  const tdee = observedTdee != null ? 0.5 * formulaTdee + 0.5 * observedTdee : formulaTdee;
  const balance = avgIntake - tdee;

  // Uncertainty (1 sigma), widened when days are missing.
  const sigma = Math.sqrt((0.12 * avgIntake) ** 2 + (0.10 * (avgBase + avgSteps)) ** 2 + (0.25 * avgWorkouts) ** 2)
    * (method === 'adaptive' ? 0.75 : 1) * (1 + (7 - complete.length) / 7 * 0.5);
  const mid = (7 * balance) / KCAL_PER_KG;
  const low = (7 * (balance - sigma)) / KCAL_PER_KG;
  const high = (7 * (balance + sigma)) / KCAL_PER_KG;
  const direction = high < 0 ? 'loss' : low > 0 ? 'gain' : 'about_steady';

  const flags = safetyFlags({ profile, avgIntake, weeklyMid: mid, startKg, goal: profile.goal });
  const toward = profile.target_weight_kg ? Math.sign(profile.target_weight_kg - startKg) : profile.goal === 'lose' ? -1 : profile.goal === 'gain' ? 1 : 0;
  let goal_eta_weeks = null;
  if (profile.target_weight_kg && toward !== 0 && Math.sign(mid) === toward && Math.abs(mid) >= 0.05 && direction !== 'about_steady') {
    goal_eta_weeks = { low: Math.ceil(Math.abs(profile.target_weight_kg - startKg) / Math.max(Math.abs(low), Math.abs(high))), high: Math.ceil(Math.abs(profile.target_weight_kg - startKg) / Math.max(0.05, Math.min(Math.abs(low), Math.abs(high)))) };
    if (Math.sign(low) !== Math.sign(high)) goal_eta_weeks = null;
  }

  return {
    ...base,
    status: 'ok',
    method,
    resting_method: rest.method,
    start_weight_kg: r(startKg, 1),
    start_is_trend: series.length > 0,
    last_weigh_in: lastActual,
    coverage,
    inputs: {
      avg_intake_kcal: r(avgIntake), base_kcal: r(avgBase), steps_kcal: r(avgSteps), workouts_kcal: r(avgWorkouts),
      formula_tdee_kcal: r(formulaTdee), observed_tdee_kcal: observedTdee == null ? null : r(observedTdee),
      tdee_kcal: r(tdee), balance_kcal: r(balance), sigma_kcal: r(sigma),
      window: { from: window[0].date, to: window[6].date },
    },
    change_kg: { low: r(low, 2), mid: r(mid, 2), high: r(high, 2) },
    direction,
    goal_eta_weeks,
    toward_goal: toward === 0 ? direction === 'about_steady' : Math.sign(mid) === toward,
    safety_flags: flags,
    message: forecastMessage({ low, high, direction, flags, complete: complete.length }),
  };
}

const fmt = (x) => Math.abs(x).toFixed(1);
function forecastMessage({ low, high, direction, flags, complete }) {
  let s;
  const span = (near, far) => (Math.abs(near) < 0.05 ? `up to about ${fmt(far)} kg` : `about ${fmt(near)}–${fmt(far)} kg`);
  if (direction === 'loss') s = `At this pace you're likely to lose ${span(high, low)} this week.`;
  else if (direction === 'gain') s = `At this pace you're likely to gain ${span(low, high)} this week.`;
  else s = `At this pace your weight is likely to stay about the same this week (between ${low < 0 ? '−' : '+'}${fmt(low)} and +${fmt(high)} kg).`;
  s += ` Based on ${complete} fully logged day${complete === 1 ? '' : 's'} of the last 7. The scale can still move up to a kilo day to day with water and food.`;
  if (flags.includes('low_intake')) s += ' Your logged food is below a safe daily minimum — please don\'t go lower; a doctor or dietitian can help plan a safe deficit.';
  else if (flags.includes('fast_loss')) s += ' That is faster than about 1% of body weight a week, which is hard to sustain safely.';
  if (flags.includes('underweight_loss')) s += ' Your weight is already in the underweight range, so losing more is not advised — please check with a doctor.';
  if (flags.includes('fast_gain')) s += ' Gaining more than 0.5 kg a week is mostly fat; a slower surplus is healthier.';
  return s;
}

/**
 * Compare saved forecasts with what the weight trend actually did.
 * forecasts: [{made_on, horizon_end, start_weight_kg, low, mid, high}]
 * Returns the evaluated ones (needs a weigh-in within 3 days of horizon_end).
 */
function evaluateForecasts(forecasts, weights, today) {
  const series = trendSeries(weights, today);
  const byDate = new Map(series.map((s) => [s.date, s]));
  const out = [];
  for (const f of forecasts || []) {
    if (!f.horizon_end || f.horizon_end > today) continue;
    const near = (weights || []).some((w) => Math.abs(toDay(String(w.date).slice(0, 10)) - toDay(f.horizon_end)) <= 3);
    const pt = byDate.get(f.horizon_end);
    if (!near || !pt) continue;
    const actual = pt.trend - Number(f.start_weight_kg);
    out.push({ made_on: f.made_on, horizon_end: f.horizon_end, predicted_mid: Number(f.mid), actual_change_kg: r(actual, 2), error_kg: r(actual - Number(f.mid), 2), within_range: actual >= Number(f.low) && actual <= Number(f.high) });
  }
  const n = out.length;
  return { evaluated: out, summary: n ? { count: n, mean_abs_error_kg: r(out.reduce((s, e) => s + Math.abs(e.error_kg), 0) / n, 2), within_range: out.filter((e) => e.within_range).length } : null };
}

/** Progress toward the target from actual measurements (trend-based). */
function progress(profile, weights, today) {
  const series = trendSeries(weights, today);
  if (!series.length) return { status: 'no_weights', series: [] };
  const firstActual = series.find((s) => s.actual != null);
  const current = series[series.length - 1].trend;
  const start = firstActual.actual;
  const target = profile && profile.target_weight_kg ? Number(profile.target_weight_kg) : null;
  let pct = null;
  if (target != null && start !== target) pct = Math.max(0, Math.min(100, ((start - current) / (start - target)) * 100));
  const slope = trendSlope(series, 28);
  return {
    status: 'ok', start_kg: r(start, 1), start_date: firstActual.date, current_trend_kg: r(current, 1),
    target_kg: target, progress_pct: pct == null ? null : r(pct), weekly_trend_kg: slope == null || series.length < 7 ? null : r(slope * 7, 2),
    series: series.slice(-90),
  };
}

module.exports = {
  MODEL_VERSION, KCAL_PER_KG, STEP_BASED, MIN_COMPLETE_DAYS,
  restingKcal, stepKcal, workoutNetKcal, trendSeries, trendSlope, isComplete, dayExpenditure,
  weeklyForecast, evaluateForecasts, progress, addDays,
};
