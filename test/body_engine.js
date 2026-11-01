// test/body_engine.js — pure tests for the weekly weight forecast engine.
// No database needed. Run: node --test test/body_engine.js
const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../src/services/bodyEngine');

const TODAY = '2026-11-01';
const profile = { sex: 'male', age: 30, height_cm: 175, weight_kg: 80, goal: 'lose', target_weight_kg: 74 };
const day = (i, o = {}) => ({ date: E.addDays(TODAY, -i), intake_kcal: 2000, meal_types: 3, steps: 8000, workouts: [], ...o });
const week = (o) => [1, 2, 3, 4, 5, 6, 7].map((i) => day(i, typeof o === 'function' ? o(i) : o));

test('Mifflin and Katch-McArdle resting energy', () => {
  assert.equal(Math.round(E.restingKcal(profile).kcal), 1749); // 800+1093.75-150+5
  const k = E.restingKcal({ ...profile, body_fat_pct: 20 });
  assert.equal(k.method, 'katch_mcardle');
  assert.equal(Math.round(k.kcal), Math.round(370 + 21.6 * 64));
});

test('missing profile -> need_profile, no numbers', () => {
  const f = E.weeklyForecast({ today: TODAY, profile: { weight_kg: 80 }, weights: [], days: [] });
  assert.equal(f.status, 'need_profile');
  assert.equal(f.change_kg, undefined);
});

test('too few fully logged days -> honest need_logs, no prediction', () => {
  const days = week((i) => (i <= 3 ? {} : { meal_types: 1, intake_kcal: 600 }));
  const f = E.weeklyForecast({ today: TODAY, profile, weights: [{ date: TODAY, weight_kg: 80 }], days });
  assert.equal(f.status, 'need_logs');
  assert.equal(f.coverage.complete_days, 3);
  assert.equal(f.coverage.partial_days, 4);
  assert.equal(f.change_kg, undefined);
  assert.match(f.message, /1 more day/);
});

test('deficit gives a loss range with mid inside and correct sign', () => {
  const f = E.weeklyForecast({ today: TODAY, profile, weights: [{ date: TODAY, weight_kg: 80 }], days: week({ intake_kcal: 1800 }) });
  assert.equal(f.status, 'ok');
  assert.ok(f.change_kg.low < f.change_kg.mid && f.change_kg.mid < f.change_kg.high);
  assert.ok(f.change_kg.mid < 0);
  assert.equal(f.inputs.balance_kcal, Math.round(1800 - f.inputs.tdee_kcal));
  assert.ok(Math.abs(f.change_kg.mid - (7 * f.inputs.balance_kcal) / 7700) < 0.02);
  assert.equal(f.model_version, 'hp-forecast-1');
  assert.equal(f.horizon_end, '2026-11-08');
});

test('surplus gives gain; equal intake gives about_steady', () => {
  const g = E.weeklyForecast({ today: TODAY, profile: { ...profile, goal: 'gain' }, weights: [], days: week({ intake_kcal: 3600 }) });
  assert.equal(g.direction, 'gain');
  const tdee = E.weeklyForecast({ today: TODAY, profile, weights: [], days: week({}) }).inputs.tdee_kcal;
  const s = E.weeklyForecast({ today: TODAY, profile, weights: [], days: week({ intake_kcal: tdee }) });
  assert.equal(s.direction, 'about_steady');
});

test('partial days are excluded, not read as low intake', () => {
  const full = E.weeklyForecast({ today: TODAY, profile, weights: [], days: week({}) });
  const mixed = E.weeklyForecast({ today: TODAY, profile, weights: [], days: week((i) => (i > 5 ? { meal_types: 1, intake_kcal: 300 } : {})) });
  assert.equal(mixed.inputs.avg_intake_kcal, full.inputs.avg_intake_kcal);
  // fewer days -> wider range
  assert.ok(mixed.change_kg.high - mixed.change_kg.low > full.change_kg.high - full.change_kg.low);
});

test('walking workout is not double counted on a day with steps', () => {
  const walk = { activity: 'brisk_walking', minutes: 60, met: 4.3, weight_kg: 80 };
  const withSteps = E.dayExpenditure({ steps: 10000, workouts: [walk] }, profile, 1749);
  assert.equal(withSteps.workouts, 0);
  assert.equal(withSteps.skipped_step_workouts, 1);
  const noSteps = E.dayExpenditure({ steps: null, workouts: [walk] }, profile, 1749);
  assert.equal(Math.round(noSteps.workouts), Math.round(3.3 * 80));
  const gym = E.dayExpenditure({ steps: 10000, workouts: [{ activity: 'strength_training', minutes: 60, met: 5, weight_kg: 80 }] }, profile, 1749);
  assert.equal(Math.round(gym.workouts), 320); // net (5-1)*80*1
});

test('steps below everyday baseline add nothing; above add net walking cost', () => {
  assert.equal(E.stepKcal(2500, 80, 175), 0);
  const k = E.stepKcal(13000, 80, 175);
  assert.ok(k > 250 && k < 330, String(k)); // 10k extra steps ≈ 290 kcal at 80 kg
});

test('reprocessing the same input gives the same forecast (deterministic)', () => {
  const input = { today: TODAY, profile, weights: [{ date: '2026-10-25', weight_kg: 80.4 }, { date: TODAY, weight_kg: 80 }], days: week({ intake_kcal: 1900 }) };
  assert.deepEqual(E.weeklyForecast(input), E.weeklyForecast(JSON.parse(JSON.stringify(input))));
});

test('trend smooths a water spike and never inserts predictions as actuals', () => {
  const w = [{ date: '2026-10-28', weight_kg: 80 }, { date: '2026-10-29', weight_kg: 81.5 }, { date: '2026-10-30', weight_kg: 80 }];
  const s = E.trendSeries(w, TODAY);
  assert.equal(s.length, 5);
  assert.ok(s[1].trend < 80.2);                 // 1.5 kg spike moves trend only 0.15
  assert.equal(s.filter((p) => p.actual != null).length, 3); // no invented actuals
  assert.equal(s[4].actual, null);
});

test('safety flags: low intake, fast loss, underweight', () => {
  const f = E.weeklyForecast({ today: TODAY, profile, weights: [], days: week({ intake_kcal: 1000, meal_types: 3 }) });
  assert.ok(f.safety_flags.includes('low_intake'));
  assert.ok(f.safety_flags.includes('fast_loss'));
  assert.match(f.message, /safe daily minimum/);
  const thin = E.weeklyForecast({ today: TODAY, profile: { ...profile, weight_kg: 52 }, weights: [{ date: TODAY, weight_kg: 52 }], days: week({ intake_kcal: 1600 }) });
  assert.ok(thin.safety_flags.includes('underweight_loss'));
});

test('adaptive mode kicks in with 2+ weeks of weigh-ins and logs, clamped', () => {
  const days = []; const weights = [];
  for (let i = 1; i <= 28; i++) days.push(day(i, { intake_kcal: 2200 }));
  for (let i = 28; i >= 0; i -= 3) weights.push({ date: E.addDays(TODAY, -i), weight_kg: 80 + (28 - i) * -0.03 });
  const f = E.weeklyForecast({ today: TODAY, profile, weights, days });
  assert.equal(f.method, 'adaptive');
  assert.ok(f.inputs.observed_tdee_kcal >= f.inputs.formula_tdee_kcal * 0.75 - 1);
  assert.ok(f.inputs.observed_tdee_kcal <= f.inputs.formula_tdee_kcal * 1.25 + 1);
});

test('forecast evaluation tracks error against later actual trend', () => {
  const weights = [{ date: '2026-10-20', weight_kg: 80 }, { date: '2026-10-27', weight_kg: 79.5 }];
  const ev = E.evaluateForecasts([{ made_on: '2026-10-20', horizon_end: '2026-10-27', start_weight_kg: 80, low: -0.6, mid: -0.4, high: -0.2 }], weights, TODAY);
  assert.equal(ev.evaluated.length, 1);
  assert.equal(ev.evaluated[0].actual_change_kg, -0.05); // trend moved 0.05 (smoothing)
  assert.equal(ev.summary.count, 1);
  // no weigh-in near the horizon -> not evaluated
  assert.equal(E.evaluateForecasts([{ made_on: '2026-10-01', horizon_end: '2026-10-08', start_weight_kg: 80, low: -1, mid: 0, high: 1 }], weights, TODAY).evaluated.length, 0);
});

test('progress uses actual start and trend current', () => {
  const p = E.progress(profile, [{ date: '2026-10-01', weight_kg: 82 }, { date: TODAY, weight_kg: 80 }], TODAY);
  assert.equal(p.start_kg, 82);
  assert.ok(p.current_trend_kg < 82 && p.current_trend_kg > 80);
  assert.ok(p.progress_pct > 0 && p.progress_pct < 100);
  assert.equal(E.progress(profile, [], TODAY).status, 'no_weights');
});

test('message never shows a confusing 0.0 lower bound', () => {
  const tdee = E.weeklyForecast({ today: TODAY, profile, weights: [], days: week({}) }).inputs.tdee_kcal;
  const f = E.weeklyForecast({ today: TODAY, profile, weights: [], days: week({ intake_kcal: tdee - 340 }) });
  assert.doesNotMatch(f.message, /0\.0–/);
});
