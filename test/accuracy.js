// test/accuracy.js — accuracy pass (2026-11-02): reference cases with answers
// worked out BY HAND (not by running the code), for the energy maths, the
// weekly forecast, HeartScore weights / missing data, and the food library.
// Run: node --test test/accuracy.js
const test = require('node:test');
const assert = require('node:assert/strict');
const calc = require('../src/utils/calc');
const body = require('../src/services/bodyEngine');

// ---------------- energy ----------------
test('E1 Mifflin-St Jeor man 30 y, 175 cm, 70 kg = 1,648.75 kcal', () => {
  assert.equal(calc.bmr({ sex: 'male', weight_kg: 70, height_cm: 175, age: 30 }), 1648.75);
  assert.deepEqual(body.restingKcal({ sex: 'male', weight_kg: 70, height_cm: 175, age: 30 }), { kcal: 1648.75, method: 'mifflin_st_jeor' });
});
test('E2 Mifflin-St Jeor woman 28 y, 160 cm, 60 kg = 1,299 kcal', () => {
  assert.equal(calc.bmr({ sex: 'female', weight_kg: 60, height_cm: 160, age: 28 }), 1299);
});
test('E3 Katch-McArdle 80 kg at 25% fat: lean 60 kg -> 370 + 21.6 x 60 = 1,666 kcal', () => {
  const r = body.restingKcal({ sex: 'male', weight_kg: 80, height_cm: 180, age: 35, body_fat_pct: 25 });
  assert.equal(r.method, 'katch_mcardle');
  assert.ok(Math.abs(r.kcal - 1666) < 1e-9);
});
test('E4 daily targets, man above, maintain, factor 1.2: TDEE 1,979, protein 84 g, fat 55 g, carbs 287 g, water 2,450 ml', () => {
  const t = calc.dailyTargets({ sex: 'male', weight_kg: 70, height_cm: 175, age: 30, activity_factor: 1.2, goal: 'maintain' });
  assert.deepEqual(t, { bmr: 1649, tdee: 1979, calories: 1979, calories_clamped_to_minimum: false, protein_g: 84, fat_g: 55, carbs_g: 287, water_ml: 2450 });
});
test('E5 woman above losing 0.5 kg/week: 1,558.8 - 550 = 1,008.8 -> held at the 1,200 kcal safe minimum', () => {
  const t = calc.dailyTargets({ sex: 'female', weight_kg: 60, height_cm: 160, age: 28, activity_factor: 1.2, goal: 'lose', pace_kg_week: 0.5 });
  assert.equal(t.tdee, 1559); assert.equal(t.calories, 1200); assert.equal(t.calories_clamped_to_minimum, true);
});
test('E6 step kcal: 10,000 steps, 70 kg, 175 cm -> 7,000 extra x 0.7245 m = 5.07 km x 0.5 x 70 = 177.5 kcal; 3,000 or fewer = 0', () => {
  assert.ok(Math.abs(body.stepKcal(10000, 70, 175) - 177.5025) < 1e-6);
  assert.equal(body.stepKcal(3000, 70, 175), 0);
  assert.equal(body.stepKcal(null, 70, 175), 0);
});
test('E7 workouts: running 9.8 MET 30 min 70 kg = 343 kcal shown, 308 net in the forecast; walking on a step day = not counted', () => {
  assert.equal(calc.workoutCalories(9.8, 70, 30), 343);
  assert.ok(Math.abs(body.workoutNetKcal({ activity: 'running', met: 9.8, minutes: 30 }, 70, false).kcal - 308) < 1e-9);
  assert.deepEqual(body.workoutNetKcal({ activity: 'walking', met: 3.5, minutes: 60 }, 70, true), { kcal: 0, counted: false, reason: 'steps_already_counted' });
  // strength training on a step day IS counted: (5 - 1) x 70 x 1 h = 280
  assert.equal(body.workoutNetKcal({ activity: 'strength_training', met: 5, minutes: 60 }, 70, true).kcal, 280);
});
test('E8 no double counting: a day with steps + a walk + a gym session = base + steps + gym only', () => {
  const e = body.dayExpenditure({ steps: 10000, workouts: [{ activity: 'walking', met: 3.5, minutes: 45 }, { activity: 'strength_training', met: 5, minutes: 60 }] },
    { weight_kg: 70, height_cm: 175 }, 1648.75);
  assert.equal(e.skipped_step_workouts, 1);
  assert.ok(Math.abs(e.total - (1978.5 + 177.5025 + 280)) < 1e-6);
});

// ---------------- weekly forecast ----------------
const TODAY = '2026-11-02';
const week = (intake, steps = 10000, n = 7) => Array.from({ length: n }, (_, i) => ({ date: body.addDays(TODAY, -(i + 1)), intake_kcal: intake, meal_types: 3, steps, workouts: [] }));
const MAN = { sex: 'male', age: 30, height_cm: 175, weight_kg: 70, goal: 'lose' };

test('F1 forecast, 2,000 kcal/day, 10k steps: TDEE 2,156, balance -156, sigma 323, range -0.44 / -0.14 / +0.15 kg, "about the same"', () => {
  const f = body.weeklyForecast({ today: TODAY, profile: MAN, weights: [], days: week(2000) });
  assert.equal(f.status, 'ok'); assert.equal(f.method, 'formula');
  assert.deepEqual([f.inputs.base_kcal, f.inputs.steps_kcal, f.inputs.tdee_kcal, f.inputs.balance_kcal, f.inputs.sigma_kcal], [1979, 178, 2156, -156, 323]);
  assert.deepEqual(f.change_kg, { low: -0.44, mid: -0.14, high: 0.15 });
  assert.equal(f.direction, 'about_steady');
  assert.match(f.message, /between −0\.4 and \+0\.2 kg/);
});
test('F2 forecast, 1,700 kcal/day: balance -456, range -0.68 / -0.41 / -0.14 kg, message "lose about 0.1–0.7 kg"', () => {
  const f = body.weeklyForecast({ today: TODAY, profile: MAN, weights: [], days: week(1700) });
  assert.equal(f.inputs.balance_kcal, -456); assert.equal(f.inputs.sigma_kcal, 297);
  assert.deepEqual(f.change_kg, { low: -0.68, mid: -0.41, high: -0.14 });
  assert.equal(f.direction, 'loss');
  assert.match(f.message, /lose about 0\.1–0\.7 kg this week/);
});
test('F3 forecast with 5 of 7 days logged: sigma x (1 + 2/7 x 0.5) = 323 x 1.142857 = 369', () => {
  const f = body.weeklyForecast({ today: TODAY, profile: MAN, weights: [], days: week(2000, 10000, 5) });
  assert.equal(f.coverage.complete_days, 5);
  assert.equal(f.inputs.sigma_kcal, 369);
});
test('F4 half-logged days are left out, 3 complete days -> no forecast (asks for 1 more day)', () => {
  const days = week(2000, 10000, 3).concat([{ date: body.addDays(TODAY, -5), intake_kcal: 500, meal_types: 1, steps: 9000, workouts: [] }]);
  const f = body.weeklyForecast({ today: TODAY, profile: MAN, weights: [], days });
  assert.equal(f.status, 'need_logs'); assert.match(f.message, /1 more day /);
});

// ---------------- HeartScore ----------------
const intel = require('../src/services/intelligence');
test('H1 HeartScore weights are the documented ones (Health, Fitness, Wealth 20%; Mind, Recovery 15%; Habits 10%) and add to 100%', () => {
  const w = Object.fromEntries(intel.AREAS.map((a) => [a.key, a.weight]));
  assert.deepEqual(w, { health: 0.2, fitness: 0.2, mind: 0.15, wealth: 0.2, habits: 0.1, recovery: 0.15 });
  assert.ok(Math.abs(intel.AREAS.reduce((s, a) => s + a.weight, 0) - 1) < 1e-9);
});
test('H2 overall = weighted average of areas WITH data: health 80, fitness 60, recovery 90 -> 41.5 / 0.55 = 75', () => {
  assert.equal(intel.combineAreas({ health: 80, fitness: 60, mind: null, wealth: null, habits: null, recovery: 90 }), 75);
  assert.equal(intel.combineAreas({ health: 100, fitness: 0, mind: 50, wealth: 100, habits: 100, recovery: 50 }), 65); // 20+0+7.5+20+10+7.5 = 65
});
test('H3 missing data is never a zero: one area -> no score; empty day -> every area null', () => {
  assert.equal(intel.combineAreas({ health: 90, fitness: null, mind: null, wealth: null, habits: null, recovery: null }), null);
  const D = TODAY; const days = {};
  for (let i = 0; i < 40; i++) { const d = body.addDays(D, -i); days[d] = { date: d, steps: null, sleep_h: null, sleep_q: null, mood: null, water: null, kcal: null, protein: null, food_n: 0, workout_min: null, spend: null, expense_n: 0, weight: null, active_min: null, resting_hr: null, logged: false }; }
  const ctx = { D, days, profile: {}, bills: [], budgets: [], catRows: [], targets: null, recordedIncome: {}, firstLog: null };
  const s = intel.computeScore(ctx, D, { isToday: false, hour: 20 });
  assert.equal(s.overall, null);
  for (const k of Object.keys(s.scores)) assert.equal(s.scores[k], null, k);
});
test('H4 Wealth area: refunds lower spending, Investment is not spending (₹1,000 food - ₹400 refund + ₹5,000 SIP = ₹600 spent)', () => {
  const D = TODAY; const days = { [D]: { date: D } };
  const ctx = { D, days, profile: { income: 50000 }, bills: [], budgets: [{ month: '2026-11', category: 'Food', amount: 700 }],
    catRows: [{ date: '2026-11-01', category: 'Food', amount: 1000, amount_paise: 100000, type: 'expense' },
      { date: '2026-11-02', category: 'Food', amount: 400, amount_paise: 40000, type: 'refund' },
      { date: '2026-11-02', category: 'Investment', amount: 5000, amount_paise: 500000, type: 'expense' },
      { date: '2026-10-31', category: 'Food', amount: 9999, amount_paise: 999900, type: 'expense' }],
    recordedIncome: {} };
  const m = intel.monthMoney(ctx, D);
  assert.equal(m.spent, 600); assert.equal(m.expense_n, 2); assert.equal(m.byCat.Food, 600); assert.equal(m.byCat.Investment, 5000);
});

// ---------------- food library ----------------
const { baseFoods, regionalFoods } = require('../src/seed/sql');
const ALL = baseFoods.concat(regionalFoods);
test('N1 every built-in food: protein x4 + carbs x4 + fat x9 is within 15% of its kcal', () => {
  const bad = ALL.filter((f) => Math.abs(4 * f.protein_g + 4 * f.carbs_g + 9 * f.fat_g - f.kcal) / f.kcal > 0.15).map((f) => f.name);
  assert.deepEqual(bad, []);
});
test('N2 every built-in food has a serving, positive kcal, no negative macros, unique name', () => {
  assert.equal(new Set(ALL.map((f) => f.name)).size, ALL.length);
  for (const f of ALL) { assert.ok(f.serving && f.kcal > 0, f.name); for (const k of ['protein_g', 'carbs_g', 'fat_g']) assert.ok(f[k] >= 0, f.name); }
});
// Foods with ONE published reference (IFCT 2017 / USDA FoodData Central /
// pack label), kcal per this app's serving. Must be within 10%.
const REF = {
  'Steamed Rice': 195,            // USDA white rice, cooked 130 kcal/100 g x 150 g
  'Brown Rice': 184.5,            // USDA brown rice, cooked 123 kcal/100 g x 150 g
  'Phulka (no ghee)': 72,         // ~22.5 g whole-wheat atta (IFCT ~320 kcal/100 g) in 30 g cooked
  'Naan': 262,                    // USDA naan, 1 piece (90 g)
  'Egg (boiled)': 78,             // USDA large egg 50 g
  'Grilled Chicken Breast': 165,  // USDA chicken breast, roasted, 100 g
  'Soya Chunks (cooked)': 172.5,  // label 345 kcal/100 g dry x 50 g
  'Roasted Chana': 110.7,         // IFCT roasted Bengal gram ~369 kcal/100 g x 30 g
  'Milk (toned)': 145,            // FSSAI toned milk (3% fat) ~58 kcal/100 ml x 250 ml
  'Curd / Dahi': 91.5,            // USDA whole-milk plain yogurt 61 kcal/100 g x 150 g
  'Banana': 105,                  // USDA medium banana 118 g
  'Apple': 94.6,                  // USDA medium apple 182 g
  'Peanuts': 170,                 // USDA raw peanuts 567 kcal/100 g x 30 g
  'Bread (white)': 74.5,          // USDA white bread 266 kcal/100 g x 28 g
  'Ghee': 45,                     // 900 kcal/100 g x 5 g
  'Sugar': 19.4,                  // 387 kcal/100 g x 5 g
  'Tender Coconut Water': 47.5,   // USDA coconut water 19 kcal/100 g x 250 g
  'Potato Chips': 162,            // typical pack label ~540 kcal/100 g x 30 g
  'Glucose Biscuits': 126,        // typical pack label ~450 kcal/100 g x 28 g
};
test(`N3 ${Object.keys(REF).length} single-reference foods are within 10% of the reference`, () => {
  const off = [];
  for (const [name, ref] of Object.entries(REF)) {
    const f = ALL.find((x) => x.name === name);
    assert.ok(f, `missing ${name}`);
    if (Math.abs(f.kcal - ref) / ref > 0.10) off.push(`${name}: ${f.kcal} vs ${ref}`);
  }
  assert.deepEqual(off, []);
});
