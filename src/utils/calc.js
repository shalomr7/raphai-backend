// utils/calc.js
// ------------------------------------------------------------
// All the maths lives here, in small plain functions.
// No database code here, so these are easy to read and test.
// ------------------------------------------------------------

const round = (n, digits = 0) => {
  const p = 10 ** digits;
  return Math.round(n * p) / p;
};

// ---------------- HEALTH ----------------

/**
 * BMR (Basal Metabolic Rate) = calories your body burns at full rest.
 * Mifflin-St Jeor formula:
 *   men:   10 × kg + 6.25 × cm − 5 × age + 5
 *   women: 10 × kg + 6.25 × cm − 5 × age − 161
 */
function bmr({ sex, weight_kg, height_cm, age }) {
  const base = 10 * weight_kg + 6.25 * height_cm - 5 * age;
  return sex === 'male' ? base + 5 : base - 161;
}

/**
 * Daily targets from the profile.
 * - TDEE = BMR × activity factor (all calories you burn in a day)
 * - 1 kg of body fat ≈ 7700 kcal. To lose "pace" kg per week we remove
 *   7700 × pace / 7 calories per day (or add them to gain).
 * - Never go below 1500 kcal (men) / 1200 kcal (women) for safety.
 * - Protein: 1.6 g per kg (lose/gain), 1.2 g per kg (maintain)
 * - Fat: 25% of calories (1 g fat = 9 kcal)
 * - Carbs: whatever calories are left (1 g carbs/protein = 4 kcal)
 * - Water: 35 ml per kg
 */
function dailyTargets(p) {
  const b = bmr(p);
  const tdee = b * (p.activity_factor || 1.2);
  const dailyChange = (7700 * (p.pace_kg_week || 0)) / 7;

  let calories = tdee;
  if (p.goal === 'lose') calories = tdee - dailyChange;
  if (p.goal === 'gain') calories = tdee + dailyChange;

  const minimum = p.sex === 'male' ? 1500 : 1200;
  const clamped = calories < minimum;
  if (clamped) calories = minimum;

  const proteinPerKg = p.goal === 'maintain' ? 1.2 : 1.6;
  const protein_g = proteinPerKg * p.weight_kg;
  const fat_g = (calories * 0.25) / 9;
  const carbs_g = Math.max(0, (calories - protein_g * 4 - fat_g * 9) / 4);

  return {
    bmr: round(b),
    tdee: round(tdee),
    calories: round(calories),
    calories_clamped_to_minimum: clamped,
    protein_g: round(protein_g),
    fat_g: round(fat_g),
    carbs_g: round(carbs_g),
    water_ml: round(35 * p.weight_kg),
  };
}

/**
 * BMI = kg / (metres × metres)
 * Asian cut-offs (used in India): <18.5 under, 18.5–22.9 normal,
 * 23–24.9 overweight, 25+ obese.
 */
function bmi(weight_kg, height_cm) {
  const m = height_cm / 100;
  const value = weight_kg / (m * m);
  let category = 'obese';
  if (value < 18.5) category = 'underweight';
  else if (value < 23) category = 'normal';
  else if (value < 25) category = 'overweight';
  return { value: round(value, 1), category, cutoffs: 'Asian (18.5 / 23 / 25)' };
}

/**
 * Body fat % by the US Navy tape-measure method (all in cm).
 *  men:   495 / (1.0324 − 0.19077·log10(waist − neck) + 0.15456·log10(height)) − 450
 *  women: 495 / (1.29579 − 0.35004·log10(waist + hip − neck) + 0.22100·log10(height)) − 450
 * Returns null if a measurement is missing.
 */
function navyBodyFat({ sex, height_cm, neck_cm, waist_cm, hip_cm }) {
  if (!height_cm || !neck_cm || !waist_cm) return null;
  let value;
  if (sex === 'male') {
    if (waist_cm <= neck_cm) return null;
    value = 495 / (1.0324 - 0.19077 * Math.log10(waist_cm - neck_cm) + 0.15456 * Math.log10(height_cm)) - 450;
  } else {
    if (!hip_cm || waist_cm + hip_cm <= neck_cm) return null;
    value = 495 / (1.29579 - 0.35004 * Math.log10(waist_cm + hip_cm - neck_cm) + 0.221 * Math.log10(height_cm)) - 450;
  }
  return round(value, 1);
}

/**
 * MET = how hard an activity is compared to sitting still (1 MET).
 * Calories burned = MET × body weight (kg) × hours.
 * Values from the Compendium of Physical Activities (rounded).
 */
const MET_TABLE = {
  walking: 3.5,
  brisk_walking: 4.3,
  running: 9.8,
  jogging: 7.0,
  cycling: 7.5,
  swimming: 6.0,
  yoga: 2.5,
  strength_training: 5.0,
  hiit: 8.0,
  skipping_rope: 12.3,
  dancing: 5.0,
  cricket: 4.8,
  badminton: 5.5,
  football: 7.0,
  kabaddi: 6.0,
  stairs: 8.0,
  household_chores: 3.3,
};

function workoutCalories(met, weight_kg, minutes) {
  return round(met * weight_kg * (minutes / 60));
}

// ---------------- WEALTH ----------------

/**
 * SIP future value (money you'll have if you invest every month).
 * r = yearly return % / 12 / 100, n = number of months
 * FV = P × ((1 + r)^n − 1) / r × (1 + r)
 */
function sip(monthly, annualReturnPct, years) {
  const n = Math.round(years * 12);
  const r = annualReturnPct / 12 / 100;
  const invested = monthly * n;
  const futureValue = r === 0 ? invested : monthly * ((Math.pow(1 + r, n) - 1) / r) * (1 + r);
  return {
    invested: round(invested),
    future_value: round(futureValue),
    gains: round(futureValue - invested),
  };
}

/**
 * EMI (monthly loan payment).
 * r = yearly interest % / 12 / 100, n = months
 * EMI = P × r × (1 + r)^n / ((1 + r)^n − 1)
 */
function emi(principal, annualRatePct, months) {
  const r = annualRatePct / 12 / 100;
  const value = r === 0 ? principal / months : (principal * r * Math.pow(1 + r, months)) / (Math.pow(1 + r, months) - 1);
  const total = value * months;
  return {
    emi: round(value),
    total_payment: round(total),
    total_interest: round(total - principal),
  };
}

/**
 * 50/30/20 rule: 50% needs, 30% wants, 20% savings.
 */
function budget503020(income) {
  return {
    needs: round(income * 0.5),
    wants: round(income * 0.3),
    savings: round(income * 0.2),
  };
}

// Helper: turn a value into a 0..100 score where "target" or more = 100
const scoreUpTo = (value, target) => (target > 0 ? Math.max(0, Math.min(100, (value / target) * 100)) : 0);

module.exports = {
  round,
  bmr,
  dailyTargets,
  bmi,
  navyBodyFat,
  MET_TABLE,
  workoutCalories,
  sip,
  emi,
  budget503020,
  scoreUpTo,
};
