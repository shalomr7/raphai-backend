// test/smoke.js
// ------------------------------------------------------------
// A quick "does everything basically work?" test.
// Run it with:   node test/smoke.js   (or: npm test)
// It needs a Postgres database: set DATABASE_URL (or TEST_DATABASE_URL)
// in .env or in your terminal. It makes a fresh, empty schema
// (like a folder inside the database) just for this run, starts the
// app on a random port, registers a user, calls the main endpoints,
// and then deletes that schema again. Your real tables are not touched.
// If anything is wrong it prints FAIL and exits with code 1.
// ------------------------------------------------------------

require('dotenv').config();

// Settings for the test (set BEFORE loading the app)
if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
if (!process.env.DATABASE_URL) {
  console.error('Set DATABASE_URL (or TEST_DATABASE_URL) to a Postgres database to run the smoke test.');
  process.exit(1);
}
const testSchema = `raphai_smoke_${Date.now()}_${process.pid}`;
process.env.DB_SCHEMA = testSchema;
process.env.JWT_SECRET = 'smoke-test-secret';
process.env.NODE_ENV = 'test';
// Google Play: fake settings. The Google API itself is replaced by a fake below.
const FAKE_SA = JSON.stringify({ type: 'service_account', client_email: 'smoke@example.iam.gserviceaccount.com', private_key: '-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----\n' });
process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON = Buffer.from(FAKE_SA).toString('base64'); // base64 form
process.env.GOOGLE_PLAY_PACKAGE_NAME = 'com.raphai.app';
process.env.GOOGLE_RTDN_SECRET = 'smoke_rtdn_secret';
delete process.env.GOOGLE_RTDN_AUDIENCE;

const db = require('../src/db');
const { createApp } = require('../src/app');
const { today, thisMonth } = require('../src/utils/dates');
const play = require('../src/services/googlePlay');

// ---- Fake Google Play Developer API ----
// fakeGoogle[token] = the SubscriptionPurchaseV2 answer Google would give.
const fakeGoogle = {};
let googleCalls = 0;
play.setPlayApiFetcher(async (token) => {
  googleCalls++;
  if (!fakeGoogle[token]) { const e = new Error('Not found'); e.googleStatus = 404; throw e; }
  return JSON.parse(JSON.stringify(fakeGoogle[token]));
});
const DAY = 86400000;
const iso = (msFromNow) => new Date(Date.now() + msFromNow).toISOString();
function gSub({ product = 'raphai_pro', basePlan = 'yearly', state = 'SUBSCRIPTION_STATE_ACTIVE', expiresIn = 30 * DAY,
  autoRenew = true, trial = false, accountId = null, linked = null, prepaid = false }) {
  return {
    kind: 'androidpublisher#subscriptionPurchaseV2',
    regionCode: 'IN',
    startTime: iso(-DAY),
    subscriptionState: state,
    acknowledgementState: 'ACKNOWLEDGEMENT_STATE_PENDING',
    latestOrderId: 'GPA.1234-5678-9012-34567',
    ...(linked ? { linkedPurchaseToken: linked } : {}),
    ...(accountId ? { externalAccountIdentifiers: { obfuscatedExternalAccountId: accountId } } : {}),
    testPurchase: {},
    lineItems: [{
      productId: product,
      expiryTime: iso(expiresIn),
      ...(prepaid ? { prepaidPlan: { allowExtendAfterTime: iso(expiresIn - 3 * DAY) } } : { autoRenewingPlan: { autoRenewEnabled: autoRenew } }),
      offerDetails: { basePlanId: basePlan, ...(trial ? { offerId: basePlan === 'yearly' ? 'trial-14d' : 'trial-7d' } : {}) },
      offerPhase: trial ? { freeTrial: {} } : { basePrice: {} },
    }],
  };
}
// What Pub/Sub would POST to our RTDN endpoint
function rtdnBody(note) {
  return { message: { data: Buffer.from(JSON.stringify({ version: '1.0', packageName: 'com.raphai.app', eventTimeMillis: String(Date.now()), ...note })).toString('base64'), messageId: '1' }, subscription: 'projects/x/subscriptions/raphai-rtdn' };
}
const subNote = (purchaseToken, notificationType) => rtdnBody({ subscriptionNotification: { version: '1.0', notificationType, purchaseToken } });

let base; let token; let passed = 0;

// Call the API and return { status, body }
async function api(method, url, body, extraHeaders = {}) {
  const headers = { 'Content-Type': 'application/json', ...extraHeaders };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(base + url, { method, headers, body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)) });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json };
}

// Check something is true, or stop with a clear message
function check(name, condition, extra) {
  if (!condition) {
    console.error(`FAIL: ${name}`, extra !== undefined ? JSON.stringify(extra, null, 2) : '');
    const e = new Error(name); e.fromCheck = true; throw e;
  }
  passed++;
  console.log(`  ok  ${name}`);
}

async function run() {
  const D = today();
  const M = thisMonth();

  console.log('\nPublic legal pages');
  for (const [url, heading] of [['/privacy', 'RaphAi Privacy Policy'], ['/terms', 'RaphAi Terms &amp; Conditions']]) {
    const res = await fetch(base + url);
    const html = await res.text();
    check(`GET ${url} -> 200 text/html (no login)`, res.status === 200 && /^text\/html/.test(res.headers.get('content-type') || ''), { status: res.status, type: res.headers.get('content-type') });
    check(`GET ${url} shows its heading`, html.includes(`<h1>${heading}</h1>`), html.slice(0, 300));
  }

  console.log('\nAuth');
  let r = await api('POST', '/api/auth/register', { name: 'Ravi', email: 'ravi@example.com', password: 'secret123', accepted_terms: true });
  check('register returns 201 + token', r.status === 201 && r.body.token, r.body);
  r = await api('POST', '/api/auth/register', { name: 'Ravi', email: 'ravi@example.com', password: 'secret123', accepted_terms: true });
  check('duplicate email -> 409', r.status === 409, r.body);
  r = await api('POST', '/api/auth/login', { email: 'ravi@example.com', password: 'wrongpass' });
  check('wrong password -> 401', r.status === 401, r.body);
  r = await api('POST', '/api/auth/login', { email: 'ravi@example.com', password: 'secret123' });
  check('login works', r.status === 200 && r.body.token, r.body);
  r = await api('GET', '/api/profile'); // no token yet
  check('no token -> 401', r.status === 401, r.body);
  token = (await api('POST', '/api/auth/login', { email: 'ravi@example.com', password: 'secret123' })).body.token;
  r = await api('GET', '/api/auth/me');
  check('me', r.status === 200 && r.body.user.email === 'ravi@example.com', r.body);
  await privacyTests(r.body.user.id);

  console.log('\nProfile + targets');
  r = await api('GET', '/api/health/targets');
  check('targets need a profile -> 400', r.status === 400, r.body);
  r = await api('PUT', '/api/profile', { age: 'abc' });
  check('bad input -> 400 with details', r.status === 400 && Array.isArray(r.body.details), r.body);
  r = await api('PUT', '/api/profile', { age: 17 });
  check('age under 18 -> 400 (adults only)', r.status === 400 && Array.isArray(r.body.details), r.body);
  r = await api('PUT', '/api/profile', { age: 18 });
  check('age 18 is allowed', r.status === 200 && r.body.profile.age === 18, r.body);
  r = await api('PUT', '/api/profile', {
    sex: 'male', age: 30, height_cm: 175, weight_kg: 75, activity_factor: 1.55,
    goal: 'lose', pace_kg_week: 0.5, income: 60000, neck_cm: 38, waist_cm: 86,
  });
  check('update profile', r.status === 200 && r.body.profile.weight_kg === 75, r.body);
  r = await api('GET', '/api/health/targets');
  // BMR = 10*75 + 6.25*175 - 5*30 + 5 = 1698.75 ; TDEE = 1698.75*1.55 = 2633.06 ; lose 0.5 -> -550 = 2083
  check('BMR 1699', r.body.bmr === 1699, r.body);
  check('TDEE 2633', r.body.tdee === 2633, r.body);
  check('calories 2083', r.body.calories === 2083, r.body);
  check('protein 120 g (1.6 g/kg)', r.body.protein_g === 120, r.body);
  check('water 2625 ml', r.body.water_ml === 2625, r.body);
  check('BMI 24.5 overweight (Asian)', r.body.bmi.value === 24.5 && r.body.bmi.category === 'overweight', r.body.bmi);
  check('body fat locked on Free (macros stay free)', r.body.body_fat_locked === true && r.body.body_fat_pct === null && r.body.protein_g === 120 && r.body.carbs_g > 0, r.body);

  console.log('\nFoods + food log');
  r = await api('GET', '/api/foods?q=roti');
  check('search roti', r.status === 200 && r.body.foods.length >= 1 && r.body.foods[0].kcal === 120, r.body);
  const roti = r.body.foods[0];
  r = await api('GET', '/api/foods');
  check('~40 foods seeded', r.body.foods.length >= 40, r.body.foods.length);
  const dal = (await api('GET', '/api/foods?q=dal')).body.foods[0];
  const paneer = (await api('GET', '/api/foods?q=paneer')).body.foods.find((f) => f.name === 'Paneer');
  r = await api('POST', '/api/food-logs', { food_id: roti.id, meal: 'lunch', servings: 3 });
  check('log 3 roti', r.status === 201 && r.body.entry.kcal === 360, r.body);
  const rotiLogId = r.body.entry.id;
  await api('POST', '/api/food-logs', { food_id: dal.id, meal: 'lunch' });
  await api('POST', '/api/food-logs', { food_id: paneer.id, meal: 'dinner', servings: 2 });
  r = await api('PUT', `/api/food-logs/${rotiLogId}`, { servings: 2 });
  check('edit food log', r.status === 200 && r.body.entry.kcal === 240, r.body);
  r = await api('GET', `/api/food-logs?date=${D}`);
  check('daily totals 240+150+530 = 920 kcal', r.body.totals.kcal === 920 && r.body.meals.lunch.entries.length === 2, r.body.totals);
  r = await api('POST', '/api/food-logs', { food_id: 99999, meal: 'lunch' });
  check('unknown food -> 404', r.status === 404, r.body);

  console.log('\nFast food logging (verified, favourites, recent, repeat)');
  check('seeded foods are verified', roti.verified === true, roti);
  r = await api('POST', '/api/foods', { name: 'My protein shake', serving: '1 glass', kcal: 200, protein_g: 25, carbs_g: 10, fat_g: 5 });
  check('user-added food is NOT verified', r.status === 201 && r.body.food.verified === false, r.body);
  r = await api('POST', `/api/foods/${dal.id}/favourite`);
  check('star a food', r.body.is_favourite === true, r.body);
  r = await api('GET', '/api/foods/favourites');
  check('favourites list', r.body.foods.length === 1 && r.body.foods[0].id === dal.id, r.body);
  r = await api('GET', '/api/foods');
  check('search: favourite first, then recent', r.body.foods[0].id === dal.id && r.body.foods[0].is_favourite === true
    && [roti.id, paneer.id].includes(r.body.foods[1].id) && r.body.foods[1].last_used, r.body.foods.slice(0, 3));
  r = await api('GET', '/api/foods/recent');
  check('recent foods', r.body.foods.length === 3, r.body);
  r = await api('DELETE', `/api/foods/${dal.id}/favourite`);
  check('un-star a food', r.body.is_favourite === false, r.body);
  const yday = new Date(Date.parse(D + 'T00:00:00Z') - 86400000).toISOString().slice(0, 10);
  await api('POST', '/api/food-logs', { food_id: roti.id, meal: 'breakfast', servings: 2, date: yday });
  await api('POST', '/api/food-logs', { food_id: dal.id, meal: 'breakfast', date: yday });
  r = await api('POST', '/api/food-logs/repeat', { meal: 'breakfast' });
  check("repeat yesterday's breakfast", r.status === 201 && r.body.entries.length === 2 && r.body.from_date === yday && r.body.to_date === D, r.body);
  r = await api('POST', '/api/food-logs/repeat', { meal: 'snack' });
  check('repeat empty meal -> 404', r.status === 404, r.body);
  // remove today's repeated breakfast so the totals below stay simple
  for (const e of (await api('GET', `/api/food-logs?date=${D}`)).body.meals.breakfast.entries) await api('DELETE', `/api/food-logs/${e.id}`);

  console.log('\nSteps, workouts, water, sleep, mood, weight, reminders');
  r = await api('PUT', '/api/health/steps', { steps: 4000 });
  r = await api('PUT', '/api/health/steps', { steps: 6500 });
  check('steps upsert', r.body.steps === 6500, r.body);
  r = await api('GET', '/api/health/steps');
  check('steps history has 1 day', r.body.steps.length === 1, r.body);
  r = await api('POST', '/api/health/workouts', { activity: 'running', minutes: 30 });
  // 9.8 MET * 75 kg * 0.5 h = 367.5 -> 368
  check('workout kcal = MET x kg x hours', r.status === 201 && r.body.workout.kcal === 368, r.body);
  r = await api('POST', '/api/health/workouts', { activity: 'flying', minutes: 30 });
  check('unknown activity -> 400', r.status === 400, r.body);
  r = await api('POST', '/api/health/water', { ml: 500 });
  check('log water', r.status === 201, r.body);
  const waterId = r.body.entry.id;
  r = await api('PUT', `/api/health/water/${waterId}`, { ml: 750 });
  check('edit water', r.body.entry.ml === 750, r.body);
  r = await api('POST', '/api/health/sleep', { hours: 7.5, quality: 4 });
  check('log sleep', r.status === 201, r.body);
  r = await api('POST', '/api/health/mood', { mood: 4, note: 'Good day' });
  check('log mood', r.status === 201, r.body);
  r = await api('POST', '/api/health/weight', { weight_kg: 74.6 });
  check('log weight', r.status === 201, r.body);
  r = await api('GET', '/api/profile');
  check('weight log updates profile', r.body.profile.weight_kg === 74.6, r.body.profile);
  r = await api('PUT', '/api/health/reminders', { enabled: true, interval_min: 45 });
  check('reminder settings', r.body.reminders.interval_min === 45 && r.body.reminders.enabled === true, r.body);
  r = await api('GET', '/api/health/today');
  check('health today has score', typeof r.body.health_score.score === 'number', r.body);

  console.log('\nWealth');
  r = await api('POST', '/api/wealth/expenses', { amount: 450, category: 'Food', mode: 'UPI', note: 'Swiggy' });
  check('add expense', r.status === 201, r.body);
  const expId = r.body.expense.id;
  await api('POST', '/api/wealth/expenses', { amount: 3200, category: 'Groceries', mode: 'Card' });
  await api('POST', '/api/wealth/expenses', { amount: 15000, category: 'Rent', mode: 'UPI' });
  r = await api('POST', '/api/wealth/expenses', { amount: 100, category: 'Food', mode: 'Bitcoin' });
  check('bad payment mode -> 400', r.status === 400, r.body);
  r = await api('PUT', `/api/wealth/expenses/${expId}`, { amount: 500 });
  check('edit expense', r.body.expense.amount === 500, r.body);
  r = await api('GET', `/api/wealth/expenses?month=${M}`);
  check('list expenses', r.body.expenses.length === 3 && r.body.total === 18700, r.body);
  r = await api('GET', `/api/wealth/expenses/summary?month=${M}`);
  check('monthly summary by category', r.body.total_spent === 18700 && r.body.by_category[0].category === 'Rent', r.body);
  r = await api('GET', '/api/wealth/budgets/suggestion');
  check('50/30/20 suggestion', r.body.needs === 30000 && r.body.wants === 18000 && r.body.savings === 12000, r.body);
  r = await api('PUT', '/api/wealth/budgets', { category: 'Food', amount: 4000 });
  check('set budget', r.status === 200 && r.body.budget.amount === 4000, r.body);
  await api('PUT', '/api/wealth/budgets', { category: 'Transport', amount: 2000 });
  await api('PUT', '/api/wealth/budgets', { category: 'Shopping', amount: 3000 });
  r = await api('PUT', '/api/wealth/budgets', { category: 'Travel', amount: 3000 });
  check('Free: 4th budget -> 402, upgrade to Plus', r.status === 402 && r.body.upgrade_to === 'plus' && r.body.limit === 3, r.body);
  r = await api('PUT', '/api/wealth/budgets', { category: 'Food', amount: 4000 });
  check('Free: editing an existing budget still works', r.status === 200, r.body);
  r = await api('GET', '/api/wealth/budgets');
  check('budget shows spent', r.body.budgets[0].spent === 500 && r.body.budgets[0].over_budget === false, r.body);
  r = await api('POST', '/api/wealth/goals', { name: 'Goa trip', target: 30000, deadline: '2027-06-01' });
  check('add goal', r.status === 201 && r.body.goal.save_per_month > 0, r.body);
  r = await api('POST', `/api/wealth/goals/${r.body.goal.id}/add`, { amount: 5000 });
  check('add money to goal', r.body.goal.saved === 5000, r.body);
  await api('POST', '/api/wealth/goals', { name: 'Emergency fund', target: 100000 });
  r = await api('POST', '/api/wealth/goals', { name: 'New phone', target: 20000 });
  check('Free: 3rd goal -> 402, upgrade to Plus', r.status === 402 && r.body.upgrade_to === 'plus', r.body);
  r = await api('POST', '/api/wealth/bills', { name: 'Electricity', amount: 1200, due_day: 1 });
  check('add bill', r.status === 201, r.body);
  const billId = r.body.bill.id;
  r = await api('GET', `/api/wealth/bills?month=${M}`);
  // due_day 1 has passed (unless today is the 1st), unpaid -> overdue
  check('unpaid past bill is overdue', r.body.bills[0].overdue === (D > `${M}-01`), r.body);
  r = await api('POST', `/api/wealth/bills/${billId}/pay`, {});
  check('pay bill', r.body.bill.paid === true && r.body.bill.overdue === false, r.body);
  r = await api('GET', '/api/wealth/calculators/sip?monthly=5000&rate=12&years=10');
  check('Free: SIP calculator -> 402, needs Plus', r.status === 402 && r.body.upgrade_to === 'plus' && r.body.current_plan === 'free', r.body);

  console.log('\nPlans + subscription');
  r = await api('GET', '/api/plans');
  const pro = r.body.plans.find((p) => p.id === 'pro');
  const elite = r.body.plans.find((p) => p.id === 'elite');
  const plus = r.body.plans.find((p) => p.id === 'plus');
  check('plans: 14-day trial, yearly is best value (Pro yearly)', r.body.trial_days === 14 && r.body.best_value_period === 'yearly'
    && r.body.best_value.plan === 'pro' && r.body.best_value.base_plan_id === 'yearly' && r.body.prices_include_tax === true, r.body);
  check('plans: 4 tiers in order Free, Plus, Pro, Elite', r.body.plans.map((p) => p.id).join() === 'free,plus,pro,elite', r.body.plans.map((p) => p.id));
  check('plans prices (old fields kept)', plus.price_monthly === 79 && plus.price_yearly === 599 && pro.price_monthly === 199 && pro.price_yearly === 1499
    && elite.price_monthly === 349 && elite.price_yearly === 2499, r.body.plans);
  check('plans prices per base plan', JSON.stringify(plus.prices) === JSON.stringify({ monthly: 79, quarterly: 199, yearly: 599, 'monthly-prepaid': 89 })
    && JSON.stringify(pro.prices) === JSON.stringify({ monthly: 199, quarterly: 499, yearly: 1499, 'monthly-prepaid': 219 })
    && JSON.stringify(elite.prices) === JSON.stringify({ monthly: 349, quarterly: 899, yearly: 2499, 'monthly-prepaid': 379 }), r.body.plans);
  check('plans: yearly saving 37% / 37% / 40%', plus.yearly_saving_percent === 37 && pro.yearly_saving_percent === 37 && elite.yearly_saving_percent === 40, r.body.plans);
  const proBp = Object.fromEntries(pro.base_plans.map((b) => [b.id, b]));
  check('plans: Pro base plans with trials, prepaid has no auto-renew/trial', Object.keys(proBp).join() === 'monthly,quarterly,yearly,monthly-prepaid'
    && proBp.monthly.trial_days === 7 && proBp.quarterly.trial_days === 7 && proBp.yearly.trial_days === 14 && proBp.yearly.price === 1499
    && proBp['monthly-prepaid'].auto_renew === false && proBp['monthly-prepaid'].trial_days === 0 && proBp['monthly-prepaid'].offers.length === 0
    && proBp.yearly.offers.includes('launch-y1') && proBp.monthly.offers.includes('winback-3m'), pro.base_plans);
  check('plans: Plus is raphai_plus, launch offer only on Pro', plus.google_product_id === 'raphai_plus'
    && !plus.base_plans.find((b) => b.id === 'yearly').offers.includes('launch-y1') && r.body.plans[0].base_plans.length === 0, plus);
  check('plans: limits per tier', r.body.plans.map((p) => p.limits.food_parse_per_day).join() === '5,20,50,100'
    && r.body.plans.map((p) => p.limits.ai_coach_per_day).join() === '0,5,15,25' && r.body.plans.map((p) => p.limits.photo_scan_per_day).join() === '0,0,5,6'
    && r.body.plans.map((p) => p.limits.coach_per_day).join() === '5,,,' && elite.limits.family_members === 3 && elite.coming_soon.includes('family_members'), r.body.plans.map((p) => p.limits));
  check('plans: offers listed (no student offer in code)', r.body.offers.map((o) => o.id).join() === 'trial-7d,trial-14d,launch-y1,winback-3m', r.body.offers);
  r = await api('GET', '/api/subscription');
  check('starts on free', r.body.subscription.active_plan === 'free', r.body);
  r = await api('POST', '/api/coach', { question: 'calories left?' });
  check('coach on free: allowed, 4 left today', r.status === 200 && r.body.remaining_today === 4, r.body);
  for (let i = 0; i < 4; i++) r = await api('POST', '/api/coach', { question: 'calories left?' });
  check('coach on free: 5th question ok, 0 left', r.status === 200 && r.body.remaining_today === 0, r.body);
  r = await api('POST', '/api/coach', { question: 'calories left?' });
  check('coach on free: 6th question -> 402, upsell Plus', r.status === 402 && r.body.upgrade_to === 'plus' && r.body.limit === 5 && /Plus/.test(r.body.error), r.body);
  r = await api('POST', '/api/subscription/order', { plan: 'pro', period: 'yearly' });
  check('old payment-order stub is gone -> 404', r.status === 404, r.body);
  r = await api('POST', '/api/webhooks/razorpay', '{}');
  check('old payment webhook is gone -> 404', r.status === 404, r.body);
  r = await api('POST', '/api/subscription/dev-activate', { plan: 'pro', period: 'yearly' });
  check('dev-activate pro yearly (development only)', r.status === 200, r.body);
  r = await api('GET', '/api/subscription');
  check('now on pro yearly', r.body.subscription.active_plan === 'pro' && r.body.subscription.period === 'yearly', r.body);

  console.log('\nPro features unlocked');
  r = await api('GET', '/api/health/targets');
  check('Pro: body fat calculated', r.body.body_fat_locked === false && typeof r.body.body_fat_pct === 'number' && r.body.body_fat_pct > 5 && r.body.body_fat_pct < 40, r.body);
  r = await api('PUT', '/api/wealth/budgets', { category: 'Travel', amount: 3000 });
  check('Pro: 4th budget allowed', r.status === 200, r.body);
  r = await api('GET', '/api/wealth/calculators/sip?monthly=5000&rate=12&years=10');
  // Standard answer: ₹11,61,695 for 5000/month, 12%, 10 years
  check('SIP 5000 @12% 10y ≈ 11,61,695', r.body.future_value === 1161695 && r.body.invested === 600000, r.body);
  r = await api('GET', '/api/wealth/calculators/emi?principal=500000&rate=10&months=60');
  // Standard answer: ₹10,624 per month
  check('EMI 5L @10% 60m = 10,624', r.body.emi === 10624, r.body);

  console.log('\nCoach (Pro)');
  r = await api('POST', '/api/coach', { question: 'How many calories left today?' });
  check('coach: calories left', r.status === 200 && r.body.topic === 'calories_left', r.body);
  console.log('      ->', r.body.answer);
  r = await api('POST', '/api/coach', { question: 'what is my food spend this month' });
  check('coach: food spend = 3700', r.body.topic === 'food_spend' && r.body.data.total === 3700, r.body);
  console.log('      ->', r.body.answer);
  r = await api('POST', '/api/coach', { question: 'how much should I save?' });
  check('coach: save 12000', r.body.topic === 'how_much_to_save' && r.body.data.suggested_monthly === 12000, r.body);
  console.log('      ->', r.body.answer);
  r = await api('POST', '/api/coach', { question: 'good protein foods?' });
  check('coach: protein foods', r.body.topic === 'protein_foods' && r.body.data.foods.length > 0, r.body);
  console.log('      ->', r.body.answer);

  console.log('\nDashboard');
  r = await api('GET', '/api/dashboard');
  const s = r.body.raph_score && r.body.raph_score.score;
  check('RaphScore between 0 and 100', r.status === 200 && s >= 0 && s <= 100, r.body);
  console.log(`      -> RaphScore ${s} (${r.body.raph_score.label}); health ${r.body.health.score}, wealth ${r.body.wealth.score}`);
  const st = r.body.streaks;
  check('streaks: logged today and yesterday = 2 days', st && st.logging.days === 2 && st.logging.today_done === true, st);
  check('streaks: RaphScore streak is a number', typeof st.raph_score.days === 'number' && st.raph_score.min_score === 60, st);
  r = await api('GET', '/api/dashboard/streaks');
  check('GET /api/dashboard/streaks', r.status === 200 && r.body.streaks.logging.days === 2, r.body);

  console.log('\nCleanup + misc');
  r = await api('DELETE', `/api/wealth/expenses/${expId}`);
  check('delete expense', r.body.deleted === true, r.body);
  r = await api('DELETE', `/api/food-logs/${rotiLogId}`);
  check('delete food log', r.body.deleted === true, r.body);
  r = await api('GET', '/api/does-not-exist');
  check('unknown route -> 404', r.status === 404, r.body);

  console.log('\nFree trial (second user)');
  const mainToken = token;
  token = (await api('POST', '/api/auth/register', { name: 'Priya', email: 'priya@example.com', password: 'secret123', accepted_terms: true })).body.token;
  r = await api('POST', '/api/subscription/trial');
  check('start 14-day Pro trial', r.status === 200 && r.body.subscription.active_plan === 'pro' && r.body.subscription.on_trial === true, r.body);
  r = await api('POST', '/api/coach', { question: 'protein foods' });
  check('trial unlocks coach', r.status === 200, r.body);
  await api('POST', '/api/subscription/cancel');
  r = await api('POST', '/api/subscription/trial');
  check('only one trial per account -> 409', r.status === 409, r.body);
  token = mainToken;

  console.log('\nGoogle Play Billing (Google API mocked)');
  const savedSa = process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON;
  delete process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON;
  token = (await api('POST', '/api/auth/register', { name: 'Gita', email: 'gita@example.com', password: 'secret123', accepted_terms: true })).body.token;
  const gitaToken = token;
  r = await api('POST', '/api/subscription/google/verify', { purchaseToken: 'tok_x', productId: 'raphai_pro', basePlanId: 'yearly' });
  check('verify without Google settings -> 503 billing not configured', r.status === 503 && /not configured/i.test(r.body.error), r.body);
  process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON = 'not json at all';
  r = await api('POST', '/api/subscription/google/verify', { purchaseToken: 'tok_x', productId: 'raphai_pro' });
  check('verify with a broken service-account JSON -> 503', r.status === 503, r.body);
  process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON = FAKE_SA; // raw JSON form works too
  r = await api('GET', '/api/plans');
  check('plans list Google product ids', r.body.plans.find((p) => p.id === 'pro').google_product_id === 'raphai_pro'
    && r.body.plans.find((p) => p.id === 'elite').google_product_id === 'raphai_elite' && r.body.google_play.billing_configured === true, r.body);
  process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON = savedSa;

  r = await api('GET', '/api/subscription');
  const gitaAccount = r.body.subscription.play_account_id;
  check('status gives a hashed play_account_id', typeof gitaAccount === 'string' && gitaAccount.length === 64, r.body);
  r = await api('POST', '/api/subscription/google/verify', { purchaseToken: 'tok_x', productId: 'raphai_gold' });
  check('verify: unknown productId -> 400', r.status === 400, r.body);
  r = await api('POST', '/api/subscription/google/verify', { purchaseToken: 'tok_unknown', productId: 'raphai_pro', basePlanId: 'yearly' });
  check('verify: token Google does not know -> 400', r.status === 400, r.body);

  fakeGoogle.tok_pro_yearly = gSub({ product: 'raphai_pro', basePlan: 'yearly', trial: true, expiresIn: 14 * DAY, accountId: gitaAccount });
  r = await api('POST', '/api/subscription/google/verify', { purchaseToken: 'tok_pro_yearly', productId: 'raphai_pro', basePlanId: 'yearly' });
  check('verify: valid Pro yearly (in 14-day trial)', r.status === 200 && r.body.valid === true && r.body.google.in_trial === true
    && r.body.subscription.active_plan === 'pro' && r.body.subscription.on_trial === true && r.body.subscription.source === 'google_play'
    && r.body.subscription.auto_renew === true, r.body);
  check('verify: status shows Play manage link', /play\.google\.com\/store\/account\/subscriptions\?sku=raphai_pro&package=com\.raphai\.app/.test(r.body.subscription.manage_url), r.body.subscription);
  r = await api('POST', '/api/subscription/google/verify', { purchaseToken: 'tok_pro_yearly', productId: 'raphai_pro', basePlanId: 'yearly' });
  check('verify: same user, same token again is fine (restore)', r.status === 200 && r.body.valid === true, r.body);
  r = await api('GET', '/api/insights/brief');
  check('Play Pro unlocks Pro features (brief)', r.status === 200 && !r.body.locked, r.body);
  r = await api('POST', '/api/subscription/cancel');
  check('cancel a Play plan in-app -> 409 (use Play Store)', r.status === 409, r.body);

  token = (await api('POST', '/api/auth/register', { name: 'Hari', email: 'hari@example.com', password: 'secret123', accepted_terms: true })).body.token;
  const hariToken = token;
  const hariAccount = (await api('GET', '/api/subscription')).body.subscription.play_account_id;
  r = await api('POST', '/api/subscription/google/verify', { purchaseToken: 'tok_pro_yearly', productId: 'raphai_pro', basePlanId: 'yearly' });
  check('duplicate token on a second account -> 409', r.status === 409, r.body);
  r = await api('GET', '/api/subscription');
  check('second account stays Free', r.body.subscription.active_plan === 'free', r.body);
  fakeGoogle.tok_bought_by_gita = gSub({ product: 'raphai_elite', basePlan: 'monthly', accountId: gitaAccount });
  r = await api('POST', '/api/subscription/google/verify', { purchaseToken: 'tok_bought_by_gita', productId: 'raphai_elite', basePlanId: 'monthly' });
  check('token bought with another account id -> 409', r.status === 409, r.body);

  fakeGoogle.tok_expired = gSub({ product: 'raphai_elite', basePlan: 'monthly', state: 'SUBSCRIPTION_STATE_EXPIRED', expiresIn: -2 * DAY, autoRenew: false, accountId: hariAccount });
  r = await api('POST', '/api/subscription/google/verify', { purchaseToken: 'tok_expired', productId: 'raphai_elite', basePlanId: 'monthly' });
  check('verify: expired subscription -> valid:false, still Free', r.status === 200 && r.body.valid === false && r.body.subscription.active_plan === 'free', r.body);
  fakeGoogle.tok_pending = gSub({ product: 'raphai_elite', basePlan: 'monthly', state: 'SUBSCRIPTION_STATE_PENDING', accountId: hariAccount });
  r = await api('POST', '/api/subscription/google/verify', { purchaseToken: 'tok_pending', productId: 'raphai_elite', basePlanId: 'monthly' });
  check('verify: pending payment -> valid:false, pending:true', r.status === 200 && r.body.valid === false && r.body.pending === true && r.body.subscription.active_plan === 'free', r.body);
  r = await api('GET', '/api/insights/brief');
  check('pending Play plan does not unlock Pro features', r.body.locked === true, r.body);

  // Elite monthly for Hari, then "time passes" past the expiry
  fakeGoogle.tok_elite_monthly = gSub({ product: 'raphai_elite', basePlan: 'monthly', accountId: hariAccount });
  r = await api('POST', '/api/subscription/google/verify', { purchaseToken: 'tok_elite_monthly', productId: 'raphai_elite', basePlanId: 'monthly' });
  check('verify: valid Elite monthly', r.body.valid === true && r.body.subscription.active_plan === 'elite' && r.body.subscription.period === 'monthly', r.body);
  // Google renewed it but we missed the notification: status re-checks with Google
  fakeGoogle.tok_elite_monthly = gSub({ product: 'raphai_elite', basePlan: 'monthly', expiresIn: 31 * DAY, accountId: hariAccount });
  await db.run("UPDATE subscriptions SET expires_at = $1 WHERE user_id = (SELECT id FROM users WHERE email = 'hari@example.com')", [iso(-60000)]);
  r = await api('GET', '/api/subscription');
  check('expired-looking plan is re-checked with Google (missed renewal -> still Elite)', r.body.subscription.active_plan === 'elite' && new Date(r.body.subscription.expires_at) > new Date(Date.now() + 30 * DAY), r.body);
  // Now it really expired at Google too
  fakeGoogle.tok_elite_monthly = gSub({ product: 'raphai_elite', basePlan: 'monthly', state: 'SUBSCRIPTION_STATE_EXPIRED', expiresIn: -60000, autoRenew: false, accountId: hariAccount });
  await db.run("UPDATE subscriptions SET expires_at = $1 WHERE user_id = (SELECT id FROM users WHERE email = 'hari@example.com')", [iso(-60000)]);
  await db.run("UPDATE google_play_purchases SET expires_at = $1 WHERE purchase_token = 'tok_elite_monthly'", [iso(-60000)]);
  r = await api('GET', '/api/insights/brief');
  check('plan check respects expiry (no RTDN needed) -> locked', r.body.locked === true, r.body);
  r = await api('GET', '/api/subscription');
  check('status after expiry -> Free (status expired)', r.body.subscription.active_plan === 'free' && r.body.subscription.status === 'expired', r.body);

  console.log('\nGoogle Play: Plus, quarterly and prepaid base plans');
  const pia = await newUser('Pia', 'pia@example.com');
  const piaAccount = (await api('GET', '/api/subscription')).body.subscription.play_account_id;
  r = await api('POST', '/api/subscription/google/verify', { purchaseToken: 'tok_x', productId: 'raphai_plus', basePlanId: 'weekly' });
  check('verify: unknown basePlanId -> 400', r.status === 400, r.body);
  fakeGoogle.tok_plus_q = gSub({ product: 'raphai_plus', basePlan: 'quarterly', trial: true, expiresIn: 7 * DAY, accountId: piaAccount });
  r = await api('POST', '/api/subscription/google/verify', { purchaseToken: 'tok_plus_q', productId: 'raphai_plus', basePlanId: 'quarterly' });
  check('verify: raphai_plus quarterly (7-day trial) -> Plus', r.status === 200 && r.body.valid === true && r.body.google.plan === 'plus'
    && r.body.google.period === 'quarterly' && r.body.google.offer_id === 'trial-7d' && r.body.google.prepaid === false
    && r.body.subscription.active_plan === 'plus' && r.body.subscription.on_trial === true, r.body);
  r = await api('GET', '/api/wealth/calculators/sip?monthly=5000&rate=12&years=10');
  check('Plus via Play: calculators unlocked', r.status === 200, r.body);
  // Upgrade to Pro prepaid (no auto-renew): Google links the old token
  fakeGoogle.tok_pro_prepaid = gSub({ product: 'raphai_pro', basePlan: 'monthly-prepaid', prepaid: true, expiresIn: 30 * DAY, accountId: piaAccount, linked: 'tok_plus_q' });
  r = await api('POST', '/api/subscription/google/verify', { purchaseToken: 'tok_pro_prepaid', productId: 'raphai_pro', basePlanId: 'monthly-prepaid' });
  check('verify: Pro monthly-prepaid -> Pro, prepaid, no auto-renew, expiry from lineItems', r.body.valid === true && r.body.google.prepaid === true
    && r.body.google.auto_renew === false && r.body.google.period === 'monthly_prepaid'
    && r.body.subscription.active_plan === 'pro' && r.body.subscription.period === 'monthly_prepaid' && r.body.subscription.auto_renew === false
    && r.body.subscription.google_play.prepaid === true && Math.abs(new Date(r.body.subscription.expires_at) - (Date.now() + 30 * DAY)) < 60000, r.body);
  // Prepaid time runs out: Google says EXPIRED (RTDN 13)
  fakeGoogle.tok_pro_prepaid = gSub({ product: 'raphai_pro', basePlan: 'monthly-prepaid', prepaid: true, state: 'SUBSCRIPTION_STATE_EXPIRED', expiresIn: -60000, accountId: piaAccount, linked: 'tok_plus_q' });
  token = null;
  r = await api('POST', '/api/subscription/google/rtdn?secret=smoke_rtdn_secret', subNote('tok_pro_prepaid', 13));
  check('RTDN: prepaid expired -> 200', r.status === 200 && r.body.type === 'EXPIRED', r.body);
  token = pia.token;
  r = await api('GET', '/api/subscription');
  check('prepaid expired -> Free (old Plus token stays superseded)', r.body.subscription.active_plan === 'free', r.body);
  // Top-up style: a new prepaid purchase whose expiry is in the future, but Google still says ACTIVE after expiry -> no access
  fakeGoogle.tok_elite_prepaid = gSub({ product: 'raphai_elite', basePlan: 'monthly-prepaid', prepaid: true, expiresIn: -1000, accountId: piaAccount });
  r = await api('POST', '/api/subscription/google/verify', { purchaseToken: 'tok_elite_prepaid', productId: 'raphai_elite', basePlanId: 'monthly-prepaid' });
  check('prepaid past its expiryTime gives no access even if state is ACTIVE', r.body.valid === false && r.body.subscription.active_plan === 'free', r.body);
  token = hariToken;

  console.log('\nGoogle Play RTDN (Pub/Sub push)');
  token = null;
  r = await api('POST', '/api/subscription/google/rtdn?secret=wrong', subNote('tok_pro_yearly', 2));
  check('RTDN with wrong secret -> 401', r.status === 401, r.body);
  r = await api('POST', '/api/subscription/google/rtdn', subNote('tok_pro_yearly', 2));
  check('RTDN with no secret -> 401', r.status === 401, r.body);
  process.env.GOOGLE_RTDN_AUDIENCE = 'https://raphai-backend.onrender.com/api/subscription/google/rtdn';
  r = await api('POST', '/api/subscription/google/rtdn?secret=smoke_rtdn_secret', subNote('tok_pro_yearly', 2));
  check('RTDN with JWT check on but no Pub/Sub token -> 401', r.status === 401, r.body);
  delete process.env.GOOGLE_RTDN_AUDIENCE;
  const RT = '/api/subscription/google/rtdn?secret=smoke_rtdn_secret';
  r = await api('POST', RT, rtdnBody({ testNotification: { version: '1.0' } }));
  check('RTDN test notification -> 200', r.status === 200 && r.body.test === true, r.body);
  r = await api('POST', RT, { message: { data: '!!!not-base64-json' } });
  check('RTDN broken message is acked (200) so Pub/Sub stops retrying', r.status === 200, r.body);
  r = await api('POST', RT, subNote('tok_nobody_knows', 4));
  check('RTDN for a token Google does not know -> 200 ignored', r.status === 200 && r.body.ignored, r.body);

  // Renewal: trial ended, first yearly payment taken, expiry moves a year ahead
  fakeGoogle.tok_pro_yearly = gSub({ product: 'raphai_pro', basePlan: 'yearly', expiresIn: 379 * DAY, accountId: gitaAccount });
  const callsBefore = googleCalls;
  r = await api('POST', RT, subNote('tok_pro_yearly', 2));
  check('RTDN renewal -> 200, state re-fetched from Google', r.status === 200 && r.body.type === 'RENEWED' && googleCalls === callsBefore + 1, r.body);
  token = gitaToken;
  r = await api('GET', '/api/subscription');
  check('after renewal: Pro yearly, trial over, expiry ~1 year ahead', r.body.subscription.active_plan === 'pro' && r.body.subscription.period === 'yearly'
    && r.body.subscription.on_trial === false && new Date(r.body.subscription.expires_at) > new Date(Date.now() + 370 * DAY), r.body);

  // Cancel: user turns off auto-renew; keeps Pro until the paid time ends
  fakeGoogle.tok_pro_yearly = gSub({ product: 'raphai_pro', basePlan: 'yearly', state: 'SUBSCRIPTION_STATE_CANCELED', autoRenew: false, expiresIn: 379 * DAY, accountId: gitaAccount });
  token = null;
  r = await api('POST', RT, subNote('tok_pro_yearly', 3));
  check('RTDN cancel -> 200', r.status === 200 && r.body.type === 'CANCELED', r.body);
  token = gitaToken;
  r = await api('GET', '/api/subscription');
  check('after cancel: still Pro until expiry, auto_renew off', r.body.subscription.active_plan === 'pro' && r.body.subscription.auto_renew === false
    && r.body.subscription.google_play.state === 'SUBSCRIPTION_STATE_CANCELED', r.body);

  // Expired: paid time is over
  fakeGoogle.tok_pro_yearly = gSub({ product: 'raphai_pro', basePlan: 'yearly', state: 'SUBSCRIPTION_STATE_EXPIRED', autoRenew: false, expiresIn: -60000, accountId: gitaAccount });
  token = null;
  r = await api('POST', RT, subNote('tok_pro_yearly', 13));
  check('RTDN expired -> 200', r.status === 200 && r.body.type === 'EXPIRED', r.body);
  token = gitaToken;
  r = await api('GET', '/api/subscription');
  check('after expiry RTDN: back to Free', r.body.subscription.active_plan === 'free', r.body);
  r = await api('GET', '/api/insights/brief');
  check('after expiry RTDN: Pro features locked', r.body.locked === true, r.body);

  // Re-subscribe with a NEW token linked to the old one, then a refund (revoke)
  fakeGoogle.tok_pro_again = gSub({ product: 'raphai_pro', basePlan: 'monthly', accountId: gitaAccount, linked: 'tok_pro_yearly' });
  r = await api('POST', '/api/subscription/google/verify', { purchaseToken: 'tok_pro_again', productId: 'raphai_pro', basePlanId: 'monthly' });
  check('re-subscribe (linkedPurchaseToken) -> Pro monthly', r.body.valid === true && r.body.subscription.active_plan === 'pro' && r.body.subscription.period === 'monthly', r.body);
  const old = await db.get("SELECT superseded_by FROM google_play_purchases WHERE purchase_token = 'tok_pro_yearly'");
  check('old token marked as replaced', old.superseded_by === 'tok_pro_again', old);
  token = null;
  r = await api('POST', RT, rtdnBody({ voidedPurchaseNotification: { purchaseToken: 'tok_pro_again', orderId: 'GPA.1', productType: 1, refundType: 1 } }));
  check('RTDN refund (voided purchase) -> 200', r.status === 200, r.body);
  token = gitaToken;
  r = await api('GET', '/api/subscription');
  check('after refund/revoke: access removed -> Free', r.body.subscription.active_plan === 'free', r.body);

  // RTDN can arrive before the app sends the token: it is saved without a user,
  // and the right user can still claim it later.
  fakeGoogle.tok_early = gSub({ product: 'raphai_elite', basePlan: 'yearly', accountId: hariAccount });
  token = null;
  r = await api('POST', RT, subNote('tok_early', 4));
  check('RTDN purchase before verify -> saved', r.status === 200 && r.body.type === 'PURCHASED', r.body);
  token = hariToken;
  r = await api('POST', '/api/subscription/google/verify', { purchaseToken: 'tok_early', productId: 'raphai_elite', basePlanId: 'yearly' });
  check('verify after RTDN links it to the user -> Elite yearly', r.body.valid === true && r.body.subscription.active_plan === 'elite', r.body);
  fakeGoogle.tok_early = gSub({ product: 'raphai_elite', basePlan: 'yearly', state: 'SUBSCRIPTION_STATE_ON_HOLD', expiresIn: -DAY, accountId: hariAccount });
  token = null;
  await api('POST', RT, subNote('tok_early', 5));
  token = hariToken;
  r = await api('GET', '/api/subscription');
  check('RTDN on hold (payment failed) -> no access', r.body.subscription.active_plan === 'free', r.body);
  token = mainToken;

  // =====================================================================
  //  RaphAi Intelligence (v2)
  // =====================================================================
  await intelligenceTests({ D, mainToken });
  token = mainToken;

  await deleteAccountWebTests();
  token = mainToken;

  console.log('\nYour data: export + delete account');
  r = await api('GET', '/api/export');
  check('export has your data and no password', r.status === 200 && r.body.user.email === 'ravi@example.com' && r.body.expenses.length >= 2
    && r.body.food_logs.length >= 1 && r.body.custom_foods.length === 1 && !JSON.stringify(r.body).includes('password_hash'), Object.keys(r.body));
  const raviId = r.body.user.id;
  check('export includes consent records, not the old payments table', Array.isArray(r.body.consents) && r.body.consents.some((c) => c.type === 'terms_privacy' && c.granted === true)
    && !('payments' in r.body), Object.keys(r.body));
  const exportLog = await db.get("SELECT * FROM security_logs WHERE user_id = $1 AND event = 'export' ORDER BY id DESC LIMIT 1", [raviId]);
  check('security log: export written', Boolean(exportLog), exportLog);
  r = await api('DELETE', '/api/auth/me', { password: 'wrongpass' });
  check('delete account needs the right password -> 401', r.status === 401, r.body);
  r = await api('DELETE', '/api/auth/me', { password: 'secret123' });
  check('delete account', r.status === 200 && r.body.deleted === true, r.body);
  const delLog = await db.get("SELECT * FROM security_logs WHERE user_id = $1 AND event = 'account_deleted'", [raviId]);
  check('in-app delete: security log account_deleted', Boolean(delLog), delLog);
  const keptConsents = await db.all('SELECT * FROM consents WHERE user_id = $1', [raviId]);
  check('in-app delete: consent records kept, marked account_deleted_at', keptConsents.length >= 1 && keptConsents.every((c) => c.account_deleted_at), keptConsents);
  token = null;
  r = await api('POST', '/api/auth/login', { email: 'ravi@example.com', password: 'secret123' });
  check('deleted account cannot log in', r.status === 401, r.body);
}

// ---------------------------------------------------------------------
// RaphAi Intelligence tests: insights, trends, patterns, brief, profile,
// food parse, activity, sleep import, coach intents, Free vs Pro gating.
// ---------------------------------------------------------------------
const intel = require('../src/services/intelligence');
const { addDays } = require('../src/utils/dates');

// Every path in a JSON value where the value is exactly 0
function zeroPaths(v, path = '$', out = []) {
  if (v === 0) out.push(path);
  else if (Array.isArray(v)) v.forEach((x, i) => zeroPaths(x, `${path}[${i}]`, out));
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) zeroPaths(x, `${path}.${k}`, out);
  return out;
}
async function newUser(name, email) {
  const r = await api('POST', '/api/auth/register', { name, email, password: 'secret123', accepted_terms: true });
  token = r.body.token;
  return { token, id: r.body.user.id };
}

// SMOKE_SHOW=1 npm test prints the intelligence answers so you can read them
const show = (label, v) => { if (process.env.SMOKE_SHOW) console.log(`      -> ${label}:`, JSON.stringify(v, null, 1)); };

async function intelligenceTests({ D, mainToken }) {
  console.log('\nRaphAi Intelligence: nutrition safety rules');
  let n = intel.nutritionSafety({ tdee: 2633, target: 2083, sex: 'male' });
  check('deficit 21% -> ok (no suggested target)', n.safety === 'ok' && n.deficit === 550 && n.deficit_pct === 21 && n.suggested_target === null, n);
  n = intel.nutritionSafety({ tdee: 2633, target: 1808, sex: 'male' });
  check('deficit 31% -> aggressive, kind message', n.safety === 'aggressive' && /energy, hunger and progress/.test(n.message) && /restrict too hard/.test(n.message), n);
  n = intel.nutritionSafety({ tdee: 2798, target: 1698, sex: 'male' });
  check('deficit 39% -> very_aggressive (contract example)', n.safety === 'very_aggressive' && n.deficit === 1100 && n.deficit_pct === 39, n);
  n = intel.nutritionSafety({ tdee: 1300, target: 800, sex: 'female' });
  check('women: never suggest below 1,200 kcal', n.safety === 'very_aggressive' && n.suggested_target === 1200, n);
  n = intel.nutritionSafety({ tdee: 1800, target: 1100, sex: 'male' });
  check('men: never suggest below 1,500 kcal', n.suggested_target === 1500, n);
  n = intel.nutritionSafety({ tdee: 2200, target: 2500, sex: 'female' });
  check('surplus (gain) -> ok', n.safety === 'ok' && n.deficit === -300, n);

  console.log('\nRaphAi Intelligence: hydration by time of day (Asia/Kolkata)');
  let h = intel.hydrationAdvice({ goal_ml: 2800, drunk_ml: 1600, hour: 15 });
  check('3 PM, 1.6 of 2.8 L -> behind 1200, advice before 5 PM', h.behind_ml === 1200 && /before 5 PM/.test(h.message), h);
  h = intel.hydrationAdvice({ goal_ml: 2800, drunk_ml: 200, hour: 9 });
  check('9 AM -> checkpoint 1 PM', /before 1 PM/.test(h.message) && h.status === 'behind', h);
  h = intel.hydrationAdvice({ goal_ml: 2800, drunk_ml: 600, hour: 17 });
  check('5 PM, far behind -> 500 ml now, before 7 PM', /^Have 500 ml now/.test(h.message) && /before 7 PM/.test(h.message), h);
  h = intel.hydrationAdvice({ goal_ml: 2800, drunk_ml: 1000, hour: 22 });
  check('10 PM -> small glass, not a lot before bed', /before bed/.test(h.message), h);
  h = intel.hydrationAdvice({ goal_ml: 2800, drunk_ml: null, hour: 11 });
  check('no water logged -> drunk null, status no_data (not 0)', h.drunk_ml === null && h.behind_ml === null && h.status === 'no_data' && /Start tracking/.test(h.message), h);
  h = intel.hydrationAdvice({ goal_ml: 2800, drunk_ml: 3000, hour: 18 });
  check('goal reached -> done', h.status === 'done', h);

  console.log('\nRaphAi Intelligence: score maths');
  check('overall null with fewer than 2 areas', intel.combineAreas({ health: 80, fitness: null, mind: null, wealth: null, habits: null, recovery: null }) === null);
  check('overall = renormalised weighted average', intel.combineAreas({ health: 80, fitness: null, mind: null, wealth: 60, habits: null, recovery: null }) === 70);
  const ex = intel.explainChange({ overall: 60, scores: { health: 50, fitness: 40, mind: 70, wealth: 80, habits: 90, recovery: 70 } },
    { overall: 66, scores: { health: 70, fitness: 60, mind: 70, wealth: 80, habits: 90, recovery: 70 } });
  check('explanation names the areas that dropped', ex.delta === -6 && /dropped 6 points/.test(ex.explanation) && /activity/.test(ex.explanation) && /food & water/.test(ex.explanation), ex);
  const ex2 = intel.explainChange({ overall: 70, scores: { recovery: 90, mind: 70 } }, { overall: 64, scores: { recovery: 70, mind: 70 } });
  check('explanation for a rise', ex2.delta === 6 && /rose 6 points/.test(ex2.explanation) && /sleep/.test(ex2.explanation), ex2);

  console.log('\nRaphAi Intelligence: empty-data user (Free) never gets fake zeros');
  await newUser('Esha Rao', 'esha@example.com');
  let r = await api('GET', '/api/insights/today');
  check('GET /api/insights/today (empty) -> 200', r.status === 200 && r.body.name === 'Esha' && ['Good morning', 'Good afternoon', 'Good evening'].includes(r.body.greeting), r.body);
  check('empty: overall null, "Not enough data", delta null', r.body.raphscore.overall === null && r.body.raphscore.label === 'Not enough data' && r.body.raphscore.delta === null && r.body.raphscore.explanation.length > 10, r.body.raphscore);
  check('empty: 6 areas, all null + no_data + a note', r.body.raphscore.areas.length === 6
    && r.body.raphscore.areas.every((a) => a.score === null && a.status === 'no_data' && /Start|Add|Log/.test(a.note))
    && r.body.raphscore.areas.map((a) => a.key).join() === 'health,fitness,mind,wealth,habits,recovery', r.body.raphscore.areas);
  check('empty: nutrition and budget are null, hydration not tracked', r.body.nutrition === null && r.body.budget === null && r.body.hydration.drunk_ml === null && r.body.insight === null, r.body);
  check('empty: priorities are at most 3', Array.isArray(r.body.priorities) && r.body.priorities.length <= 3, r.body.priorities);
  check('empty: no 0 anywhere in /today', zeroPaths(r.body).length === 0, zeroPaths(r.body));
  r = await api('GET', '/api/insights/trends?days=7');
  check('GET /api/insights/trends (empty) -> all null, 7 days', r.status === 200 && r.body.days === 7 && r.body.series.steps.length === 7
    && Object.values(r.body.series).every((s) => s.every((p) => p.value === null)) && Object.values(r.body.summary).every((v) => v === null) && r.body.insights.length === 0, r.body);
  check('empty: no 0 anywhere in /trends', zeroPaths(r.body).length === 0, zeroPaths(r.body));

  console.log('\nRaphAi Intelligence: Free vs Pro gating');
  r = await api('GET', '/api/insights/trends?days=30');
  check('Free: 30-day trends -> 402, upgrade to Plus', r.status === 402 && r.body.upgrade_to === 'plus', r.body);
  r = await api('GET', '/api/insights/trends?days=14');
  check('trends days must be 7, 30, 90 or 365 -> 400', r.status === 400, r.body);
  for (const p of ['patterns', 'brief', 'profile']) {
    r = await api('GET', `/api/insights/${p}`);
    check(`Free: /api/insights/${p} -> { locked: true }`, r.status === 200 && r.body.locked === true, r.body);
  }
  r = await api('POST', '/api/coach', { question: 'what should I do today?' });
  check('Free: coach answers with a daily allowance', r.status === 200 && typeof r.body.remaining_today === 'number', r.body);
  for (let i = 1; i <= 5; i++) {
    r = await api('POST', '/api/food/parse', { text: '2 idli' });
    if (r.status !== 200) break;
  }
  check('Free: 5 food parses a day allowed', r.status === 200 && r.body.usage.used === 5 && r.body.usage.remaining === 0, r.body);
  r = await api('POST', '/api/food/parse', { text: '2 idli' });
  check('Free: 6th food parse -> 402, Plus gives 20', r.status === 402 && r.body.upgrade_to === 'plus' && /20 a day/.test(r.body.error), r.body);
  r = await api('GET', '/api/plans');
  const proFeatures = r.body.plans.find((p) => p.id === 'pro').features.join('|');
  const plusFeatures = r.body.plans.find((p) => p.id === 'plus').features.join('|');
  check('plans: Pro lists the intelligence features', ['RaphAi Intelligence', 'Trends for 365 days', 'Your patterns', 'AI food parse (50 a day)'].every((f) => proFeatures.includes(f)), proFeatures);
  check('plans: Plus lists patterns, brief, 30-day trends, no ads', ['Life patterns', 'Daily brief', 'Trends for 30 days', 'No ads', 'AI food parse (20 a day)'].every((f) => plusFeatures.includes(f)), plusFeatures);
  check('plans: Free lists AI food parse (5 a day)', r.body.plans.find((p) => p.id === 'free').features.join('|').includes('AI food parse (5 a day)'), r.body.plans[0]);

  // Nutrition safety through the API: woman, 1 kg/week -> target clamped to 1,200 = aggressive deficit
  await api('PUT', '/api/profile', { sex: 'female', age: 30, height_cm: 160, weight_kg: 70, activity_factor: 1.2, goal: 'lose', pace_kg_week: 1 });
  r = await api('GET', '/api/insights/today');
  check('API nutrition: TDEE 1667, target 1200, aggressive, suggested >= 1200', r.body.nutrition && r.body.nutrition.tdee === 1667 && r.body.nutrition.target === 1200
    && r.body.nutrition.safety === 'aggressive' && r.body.nutrition.suggested_target >= 1200, r.body.nutrition);

  console.log('\nRaphAi Intelligence: main user (Pro) with real data');
  token = mainToken;
  r = await api('GET', '/api/insights/today');
  const t = r.body;
  show('insights/today', t);
  check('GET /api/insights/today -> score 0-100 with label', r.status === 200 && t.raphscore.overall >= 0 && t.raphscore.overall <= 100 && ['Good', 'Okay', 'Needs care'].includes(t.raphscore.label), t.raphscore);
  check('today: delta vs yesterday + explanation', typeof t.raphscore.delta === 'number' && /point|steady/.test(t.raphscore.explanation), t.raphscore);
  check('today: tracked areas scored, untracked ones explain themselves', t.raphscore.areas.find((a) => a.key === 'recovery').status === 'ok'
    && t.raphscore.areas.every((a) => (a.score === null) === (a.status === 'no_data')), t.raphscore.areas);
  check('today: nutrition 21% deficit is ok', t.nutrition.safety === 'ok' && t.nutrition.deficit === 550 && t.nutrition.deficit_pct === 21, t.nutrition);
  check('today: hydration from real water log', t.hydration.drunk_ml === 750 && t.hydration.goal_ml > 2000 && typeof t.hydration.message === 'string', t.hydration);
  check('today: budget remaining = income - spent - unpaid bills', t.budget.income === 60000 && t.budget.remaining === t.budget.income - t.budget.spent - (t.budget.upcoming_bills || 0)
    && typeof t.budget.savings_rate === 'number', t.budget);
  check('today: priorities ranked, max 3, with routes', t.priorities.length <= 3 && t.priorities.every((p, i) => p.rank === i + 1 && p.route.startsWith('/(tabs)/')), t.priorities);
  check('today: an insight from the data', t.insight && typeof t.insight.text === 'string', t.insight);
  const saved = await db.all('SELECT date, overall FROM raphscore_daily WHERE user_id = (SELECT id FROM users WHERE email = $1) ORDER BY date', ['ravi@example.com']);
  check('raphscore_daily stores today and yesterday', saved.length === 2 && saved[1].date === D && saved[1].overall === t.raphscore.overall, saved);

  r = await api('GET', '/api/insights/trends?days=30');
  check('Pro: 30-day trends', r.status === 200 && r.body.days === 30 && r.body.series.kcal.length === 30, r.body.summary);
  r = await api('GET', '/api/insights/trends');
  check('trends: today steps + averages', r.body.series.steps[6].date === D && r.body.series.steps[6].value === 6500 && r.body.summary.steps_avg === 6500
    && r.body.insights.some((s) => s.includes('6,500 steps')), r.body);
  r = await api('GET', '/api/insights/brief');
  show('brief', r.body);
  check('GET /api/insights/brief -> health, fitness, money + priority', r.status === 200 && r.body.date === D
    && r.body.sections.map((s) => s.area).join() === 'health,fitness,money' && r.body.sections.every((s) => s.text.length > 10) && r.body.priority.length > 5, r.body);
  r = await api('GET', '/api/insights/profile');
  check('GET /api/insights/profile -> averages + traits', r.status === 200 && r.body.steps_avg === 6500 && r.body.sleep_avg_min === 450 && Array.isArray(r.body.traits), r.body);
  r = await api('GET', '/api/insights/patterns');
  check('patterns: not enough data yet -> days_needed', r.status === 200 && r.body.enough_data === false && r.body.days_needed > 0 && r.body.patterns.length === 0, r.body);

  console.log('\nRaphAi Intelligence: activity + sleep import');
  r = await api('POST', '/api/activity/daily', { date: D, steps: 7200, distance_m: 5000, active_kcal: 300, active_minutes: 45, resting_hr: 64, source: 'health_connect' });
  check('POST /api/activity/daily upserts', r.status === 200 && r.body.steps === 7200 && r.body.resting_hr === 64, r.body);
  r = await api('POST', '/api/activity/daily', { date: D, steps: 7300, source: 'health_connect' });
  check('activity upsert keeps other fields', r.body.steps === 7300 && r.body.distance_m === 5000, r.body);
  r = await api('GET', `/api/health/steps?date=${D}`);
  check('activity also updates steps', r.body.steps[0].steps === 7300, r.body);
  r = await api('GET', '/api/activity/daily?days=7');
  check('GET /api/activity/daily?days=7 -> array', Array.isArray(r.body) && r.body.length === 1 && r.body[0].date === D, r.body);
  r = await api('POST', '/api/activity/daily', { steps: 10, source: 'fitbit' });
  check('activity: unknown source -> 400', r.status === 400, r.body);
  r = await api('POST', '/api/health/sleep/import', { date: D, minutes: 400, source: 'health_connect' });
  check('sleep import skipped when a manual entry exists', r.status === 200 && r.body.imported === false, r.body);
  const yday = addDays(D, -1);
  r = await api('POST', '/api/health/sleep/import', { date: yday, minutes: 438, source: 'health_connect' });
  check('sleep import saves minutes as hours', r.body.imported === true && r.body.entry.hours === 7.3, r.body);
  r = await api('POST', '/api/health/sleep/import', { date: yday, minutes: 450, source: 'health_connect' });
  r = await api('GET', `/api/health/sleep?date=${yday}`);
  check('sleep import again replaces (no duplicates)', r.body.entries.length === 1 && r.body.entries[0].hours === 7.5, r.body);

  console.log('\nRaphAi Intelligence: food parser');
  r = await api('POST', '/api/food/parse', { text: 'I ate 2 eggs, 2 rotis and a glass of milk' });
  const it = r.body.items || [];
  check('parse: 3 items found', r.status === 200 && it.length === 3 && it.every((i) => i.matched && i.food_id), r.body);
  check('parse: 2 eggs = 156 kcal', it[0].name === 'Egg (boiled)' && it[0].qty === 2 && it[0].unit === 'piece' && it[0].kcal === 156 && it[0].servings === 2, it[0]);
  check('parse: 2 rotis = 240 kcal', it[1].name === 'Roti / Chapati' && it[1].kcal === 240, it[1]);
  check('parse: a glass of milk = 145 kcal', it[2].name === 'Milk (toned)' && it[2].qty === 1 && it[2].unit === 'glass' && it[2].kcal === 145, it[2]);
  check('parse: totals 541 kcal', r.body.totals.kcal === 541 && r.body.totals.protein === 26, r.body.totals);
  check('Pro: food parse limit 50 a day', r.body.usage.limit === 50 && r.body.usage.plan === 'pro', r.body.usage);
  r = await api('POST', '/api/food/parse', { text: '1 plate chicken biryani' });
  check('parse: 1 plate chicken biryani = 500 kcal', r.body.items.length === 1 && r.body.items[0].name === 'Chicken Biryani' && r.body.items[0].unit === 'plate' && r.body.items[0].kcal === 500, r.body);
  r = await api('POST', '/api/food/parse', { text: 'half katori dal' });
  check('parse: half katori dal = 75 kcal', r.body.items[0].name === 'Dal (toor/moong)' && r.body.items[0].qty === 0.5 && r.body.items[0].unit === 'katori' && r.body.items[0].kcal === 75 && r.body.items[0].servings === 0.5, r.body);
  r = await api('POST', '/api/food/parse', { text: 'two chapatis with half a bowl of curd, 200g paneer & 1 cup chai' });
  check('parse: number words, bowl, grams, cup', r.body.items.length === 4 && r.body.items[0].qty === 2 && r.body.items[1].name === 'Curd / Dahi'
    && r.body.items[2].name === 'Paneer' && r.body.items[2].kcal === 530 && r.body.items[3].name.startsWith('Masala Chai'), r.body.items);
  r = await api('POST', '/api/food/parse', { text: 'chiken biriyani and some unicorn steak' });
  check('parse: fuzzy match + unknown food stays unmatched (null, not 0)', r.body.items[0].name === 'Chicken Biryani' && r.body.items[1].matched === false
    && r.body.items[1].kcal === null && r.body.totals.kcal === 500, r.body.items);
  const parsedFood = (await api('POST', '/api/food/parse', { text: '3 idli' })).body.items[0];
  r = await api('POST', '/api/food-logs', { food_id: parsedFood.food_id, servings: parsedFood.servings, meal: 'breakfast' });
  check('parsed item can be logged with the food-log endpoint', r.status === 201 && r.body.entry.kcal === 174, r.body);
  await api('DELETE', `/api/food-logs/${r.body.entry.id}`);
  r = await api('POST', '/api/food/parse', {});
  check('parse: text required -> 400', r.status === 400, r.body);

  console.log('\nRaphAi Intelligence: coach intents (Pro)');
  const ask = async (question, context) => {
    const body = (await api('POST', '/api/coach', context ? { question, context } : { question })).body;
    show(`coach "${question}"`, body.answer);
    return body;
  };
  const raw = (await api('POST', '/api/coach', { question: 'What should I do today?' })).body;
  check('Pro coach: rule-based today (no AI connected), AI allowance 15 on Flash', raw.engine === 'rule_based' && raw.plan === 'pro'
    && raw.ai.connected === false && raw.ai.limit === 15 && raw.ai.model === 'gemini-2.5-flash' && raw.remaining_today === null, raw);
  let c = await ask('What should I do today?');
  check('coach: what should I do today', c.topic === 'what_to_do_today' && c.answer.length > 20, c);
  c = await ask('Why are my steps low?');
  check('coach: why are my steps low (real numbers)', c.topic === 'steps_low' && c.answer.includes('7,300'), c);
  c = await ask('How can I save more this month?');
  check('coach: save more this month', c.topic === 'save_more' && c.answer.includes('₹60,000'), c);
  c = await ask('Optimise my day');
  check('coach: optimise my day', c.topic === 'optimise_day' && c.answer.length > 40, c);
  c = await ask("How's today's nutrition?");
  check("coach: today's nutrition (real target)", c.topic === 'nutrition_today' && c.answer.includes(t.nutrition.target.toLocaleString('en-IN')), c);
  c = await ask('Can I really lose my belly fat?');
  check('coach: fat loss motivation, warm + plan', c.topic === 'fat_loss' && c.answer.startsWith('Yes, you can') && c.answer.includes('kcal'), c);
  c = await ask('How is my sleep?');
  check('coach: sleep', c.topic === 'sleep' && /7h 30m/.test(c.answer), c);
  c = await ask('I feel stressed and sad');
  check('coach: mood support mentions Tele-MANAS 14416', c.topic === 'mood_support' && c.answer.includes('14416'), c);
  c = await ask('I feel hopeless and want to die');
  check('coach: distress -> helpline first', c.topic === 'mood_support' && c.answer.includes('14416') && c.answer.includes('112'), c);
  c = await ask('blah blah', 'wealth');
  check('coach: context picks a helpful default', c.topic === 'save_more' && c.guessed_from_context === true, c);
  c = await ask('blah blah');
  check('coach: unknown lists what it can do', c.topic === 'unknown' && c.answer.includes('nutrition'), c);
  r = await api('POST', '/api/coach', { question: 'hi', context: 'kitchen' });
  check('coach: bad context -> 400', r.status === 400, r.body);

  console.log('\nRaphAi Intelligence: seeded 20-day user -> Life Graph patterns');
  const lata = await newUser('Lata', 'lata@example.com');
  await api('POST', '/api/subscription/trial');
  await api('PUT', '/api/profile', { sex: 'female', age: 28, height_cm: 158, weight_kg: 58, activity_factor: 1.375, goal: 'maintain', income: 40000, step_goal: 8000 });
  for (let i = 0; i < 20; i++) {
    const day = addDays(D, -(i + 1));
    const short = i % 2 === 0;
    const activeDay = i % 3 !== 0;
    const wd = new Date(`${day}T00:00:00Z`).getUTCDay();
    await db.run('INSERT INTO sleep_logs (user_id, date, hours) VALUES ($1, $2, $3)', [lata.id, day, short ? 5.5 : 7.5]);
    await db.run('INSERT INTO step_logs (user_id, date, steps) VALUES ($1, $2, $3)', [lata.id, day, activeDay ? 9500 : 4000]);
    await db.run('INSERT INTO mood_logs (user_id, date, mood) VALUES ($1, $2, $3)', [lata.id, day, 2 + (short ? 0 : 1) + (activeDay ? 1 : 0)]);
    await db.run("INSERT INTO expenses (user_id, amount, category, mode, date, note) VALUES ($1, $2, 'Food', 'UPI', $3, 'Swiggy')", [lata.id, short ? 400 : 100, day]);
    await db.run("INSERT INTO expenses (user_id, amount, category, mode, date) VALUES ($1, $2, 'Groceries', 'UPI', $3)", [lata.id, short ? 300 : 150, day]);
    if (wd === 0 || wd === 6) await db.run("INSERT INTO expenses (user_id, amount, category, mode, date) VALUES ($1, 1500, 'Entertainment', 'Card', $2)", [lata.id, day]);
  }
  r = await api('GET', '/api/insights/patterns');
  const ids = (r.body.patterns || []).map((p) => p.id);
  show('patterns', r.body);
  check('patterns: enough data (20 days)', r.status === 200 && r.body.enough_data === true && r.body.days_needed === 0, r.body);
  check('pattern: sleep -> spend', ids.includes('sleep_spend'), r.body.patterns);
  check('pattern: exercise -> mood', ids.includes('exercise_mood'), r.body.patterns);
  check('pattern: sleep -> mood', ids.includes('sleep_mood'), r.body.patterns);
  check('pattern: weekend share of spending', ids.includes('weekend_spend'), r.body.patterns);
  check('pattern: food delivery after poor sleep', ids.includes('food_delivery_sleep'), r.body.patterns);
  const ss = r.body.patterns.find((p) => p.id === 'sleep_spend');
  check('pattern detail uses real numbers + min 5 days per group', ss && /<6h sleep you spent ₹\d/.test(ss.detail) && ss.sample_days >= 10 && ['strong', 'moderate'].includes(ss.strength), ss);
  r = await api('GET', '/api/insights/profile');
  check('profile: averages from 20 days + traits', r.body.sleep_avg_min === 390 && r.body.mood_avg > 2 && r.body.traits.length >= 3, r.body);
  r = await api('GET', '/api/insights/today');
  check('20-day user: today works before anything is logged today', r.status === 200 && r.body.raphscore.areas.find((a) => a.key === 'recovery').status === 'no_data', r.body.raphscore);

  await plusTierTests();

  const tara = await newUser('Tara', 'tara@example.com');
  await api('POST', '/api/subscription/trial');
  for (let i = 0; i < 10; i++) await db.run('INSERT INTO sleep_logs (user_id, date, hours) VALUES ($1, $2, 7)', [tara.id, addDays(D, -(i + 1))]);
  r = await api('GET', '/api/insights/patterns');
  check('patterns: 10 days -> enough_data false, days_needed 4', r.body.enough_data === false && r.body.days_needed === 4, r.body);
}

// ---------------------------------------------------------------------
// Plus tier (dev-activate), per-tier limits, AI coach allowance + fallback
// ---------------------------------------------------------------------
const aiCoach = require('../src/services/aiCoach');

async function plusTierTests() {
  console.log('\nPlus tier: features and limits');
  await newUser('Om', 'om@example.com');
  let r = await api('POST', '/api/subscription/dev-activate', { plan: 'plus', period: 'quarterly' });
  check('dev-activate plus quarterly', r.status === 200 && r.body.subscription.active_plan === 'plus' && r.body.subscription.period === 'quarterly'
    && Math.round((new Date(r.body.subscription.expires_at) - Date.now()) / DAY) >= 89, r.body.subscription);
  await api('PUT', '/api/profile', { sex: 'male', age: 30, height_cm: 172, weight_kg: 75, activity_factor: 1.375, goal: 'maintain', neck_cm: 38, waist_cm: 86, income: 50000 });
  r = await api('GET', '/api/health/targets');
  check('Plus: body fat unlocked', r.body.body_fat_locked === false, r.body);
  for (const c of ['Food', 'Transport', 'Shopping', 'Travel']) r = await api('PUT', '/api/wealth/budgets', { category: c, amount: 1000 });
  check('Plus: 4th budget allowed', r.status === 200, r.body);
  r = await api('GET', '/api/insights/trends?days=30');
  check('Plus: 30-day trends', r.status === 200 && r.body.days === 30, r.body);
  r = await api('GET', '/api/insights/trends?days=90');
  check('Plus: 90-day trends -> 402, upgrade to Pro', r.status === 402 && r.body.upgrade_to === 'pro' && r.body.limit === 30, r.body);
  r = await api('GET', '/api/insights/patterns');
  check('Plus: life patterns unlocked', r.status === 200 && r.body.locked !== true, r.body);
  r = await api('GET', '/api/insights/brief');
  check('Plus: daily brief unlocked', r.status === 200 && r.body.locked !== true, r.body);
  r = await api('GET', '/api/insights/profile');
  check('Plus: "Your patterns" locked, needs Pro', r.body.locked === true && r.body.plan_needed === 'pro', r.body);
  for (let i = 1; i <= 20; i++) {
    r = await api('POST', '/api/food/parse', { text: '1 roti' });
    if (r.status !== 200) break;
  }
  check('Plus: 20 food parses a day', r.status === 200 && r.body.usage.used === 20 && r.body.usage.limit === 20, r.body.usage);
  r = await api('POST', '/api/food/parse', { text: '1 roti' });
  check('Plus: 21st parse -> 402, Pro gives 50', r.status === 402 && r.body.upgrade_to === 'pro' && /50 a day/.test(r.body.error), r.body);
  for (let i = 0; i < 6; i++) r = await api('POST', '/api/coach', { question: 'calories left?' });
  check('Plus: rule-based coach unlimited (6th ok), AI limit 5 on Flash-Lite', r.status === 200 && r.body.engine === 'rule_based'
    && r.body.ai.limit === 5 && r.body.ai.model === 'gemini-2.5-flash-lite' && r.body.ai.limit_reached === false, r.body);

  console.log('\nAI coach allowance + rule-based fallback (fake AI provider)');
  aiCoach.setAiProvider(async ({ model }) => ({ text: `AI answer from ${model}` }));
  for (let i = 1; i <= 5; i++) r = await api('POST', '/api/coach', { question: 'calories left?' });
  check('Plus: 5th AI answer, 0 AI left', r.body.engine === 'ai' && r.body.answer === 'AI answer from gemini-2.5-flash-lite' && r.body.ai.remaining === 0, r.body);
  r = await api('POST', '/api/coach', { question: 'calories left?' });
  check('Plus: after the AI limit -> rule-based answer (not blocked), upsell Pro', r.status === 200 && r.body.engine === 'rule_based'
    && r.body.topic === 'calories_left' && r.body.ai.limit_reached === true && r.body.ai.upgrade_to === 'pro' && /Pro gives you 15/.test(r.body.ai.message), r.body);
  r = await api('POST', '/api/coach', { question: 'I feel very low and hopeless' });
  check('mood / distress questions never go to AI', r.body.engine === 'rule_based' && r.body.topic === 'mood_support', r.body);
  aiCoach.setAiProvider(async () => { throw new Error('model down'); });
  await api('POST', '/api/subscription/dev-activate', { plan: 'elite', period: 'monthly-prepaid' });
  r = await api('POST', '/api/coach', { question: 'calories left?' });
  check('Elite (prepaid via dev-activate): AI failure -> rule-based, failed call not counted (5 used earlier today stay)', r.body.plan === 'elite' && r.body.engine === 'rule_based'
    && r.body.ai.limit === 25 && r.body.ai.used === 5 && r.body.ai.remaining === 20, r.body);
  aiCoach.setAiProvider(null);
  r = await api('POST', '/api/subscription/dev-activate', { plan: 'gold', period: 'monthly' });
  check('dev-activate unknown plan -> 400', r.status === 400, r.body);
}

// ---------------------------------------------------------------------
// Privacy: consent at sign-up, consent records, security logs,
// last_active_at, purge of old records, public /delete-account page.
// ---------------------------------------------------------------------
const { purgeOldRecords } = require('../src/services/securityLog');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function privacyTests(raviId) {
  console.log('\nPrivacy: consent at sign-up');
  const saved = token; token = null;
  let r = await api('POST', '/api/auth/register', { name: 'No Terms', email: 'noterms@example.com', password: 'secret123' });
  check('register without accepted_terms -> 400', r.status === 400 && /Terms and Privacy Policy/.test(r.body.error || r.body.message || JSON.stringify(r.body)), r.body);
  r = await api('POST', '/api/auth/register', { name: 'No Terms', email: 'noterms@example.com', password: 'secret123', accepted_terms: 'true' });
  check('register with accepted_terms "true" (text) -> 400 (must be exactly true)', r.status === 400, r.body);
  r = await api('POST', '/api/auth/register', { name: 'No Terms', email: 'noterms@example.com', password: 'secret123', accepted_terms: false });
  check('register with accepted_terms false -> 400', r.status === 400, r.body);
  check('no account was created without consent', !(await db.get("SELECT id FROM users WHERE email = 'noterms@example.com'")));
  r = await api('GET', '/api/consents');
  check('GET /api/consents needs login -> 401', r.status === 401, r.body);
  token = saved;

  console.log('\nPrivacy: consent records');
  r = await api('GET', '/api/consents');
  check('sign-up stored terms_privacy consent, version 2026-10-08', r.status === 200 && r.body.consents.terms_privacy
    && r.body.consents.terms_privacy.granted === true && r.body.consents.terms_privacy.version === '2026-10-08' && r.body.terms_version === '2026-10-08', r.body);
  r = await api('POST', '/api/consents', { type: 'ads_personalised', version: '2026-10-08', granted: true });
  check('POST consent ads_personalised yes -> 201', r.status === 201 && r.body.consent.type === 'ads_personalised' && r.body.consent.granted === true, r.body);
  r = await api('POST', '/api/consents', { type: 'ads_personalised', version: '2026-10-08', granted: false });
  check('POST consent ads_personalised no -> 201', r.status === 201 && r.body.consent.granted === false, r.body);
  r = await api('POST', '/api/consents', { type: 'gemini', version: '2026-10-08', granted: false });
  check('POST consent gemini no -> 201', r.status === 201, r.body);
  r = await api('POST', '/api/consents', { type: 'selling_data', version: '1', granted: true });
  check('unknown consent type -> 400', r.status === 400, r.body);
  r = await api('POST', '/api/consents', { type: 'health_connect', version: '1' });
  check('consent without granted -> 400', r.status === 400, r.body);
  r = await api('POST', '/api/consents', { type: 'health_connect', version: '1', granted: 'yes' });
  check('consent with granted "yes" -> 400', r.status === 400, r.body);
  r = await api('POST', '/api/consents', { type: 'health_connect', granted: true });
  check('consent without version -> 400', r.status === 400, r.body);
  r = await api('GET', '/api/consents');
  check('current ads_personalised = latest (no), history keeps every change',
    r.body.consents.ads_personalised.granted === false && r.body.history.filter((c) => c.type === 'ads_personalised').length === 2
    && r.body.history.length === 4 && r.body.consents.gemini.granted === false, r.body);

  console.log('\nPrivacy: security logs');
  const savedLogin = token; token = null;
  await api('POST', '/api/auth/login', { email: 'ravi@example.com', password: 'wrong-again' }, { 'User-Agent': 'SmokeTest/1.0' });
  await api('POST', '/api/auth/login', { email: 'nobody@example.com', password: 'whatever1' });
  await api('POST', '/api/auth/login', { email: 'ravi@example.com', password: 'secret123' }, { 'User-Agent': 'SmokeTest/1.0' });
  token = savedLogin;
  const fail = await db.get("SELECT * FROM security_logs WHERE user_id = $1 AND event = 'login_failed' AND user_agent = 'SmokeTest/1.0'", [raviId]);
  check('login_failed logged with user id, IP and user agent', fail && fail.ip && fail.created_at, fail);
  const unknown = await db.get("SELECT * FROM security_logs WHERE user_id IS NULL AND event = 'login_failed'");
  check('login_failed for an unknown email logged with no user id', Boolean(unknown), unknown);
  const okLog = await db.get("SELECT * FROM security_logs WHERE user_id = $1 AND event = 'login_success' AND user_agent = 'SmokeTest/1.0'", [raviId]);
  check('login_success logged', Boolean(okLog), okLog);
  check('security logs never store passwords', !(await db.get("SELECT 1 FROM security_logs WHERE user_agent LIKE '%secret123%' OR ip LIKE '%secret%'")));

  console.log('\nPrivacy: purge of old records');
  await db.run("INSERT INTO security_logs (user_id, event, ip, created_at) VALUES (NULL, 'login_failed', '10.0.0.1', now() - interval '400 days')");
  await db.run("INSERT INTO security_logs (user_id, event, ip, created_at) VALUES (NULL, 'login_failed', '10.0.0.2', now() - interval '300 days')");
  await db.run("INSERT INTO consents (user_id, type, version, granted, account_deleted_at) VALUES (999901, 'terms_privacy', 'old', true, now() - interval '400 days')");
  await db.run("INSERT INTO consents (user_id, type, version, granted, account_deleted_at) VALUES (999902, 'terms_privacy', 'old', true, now() - interval '100 days')");
  const purged = await purgeOldRecords();
  check('purge removes security logs older than 1 year', purged.security_logs === 1
    && !(await db.get("SELECT 1 FROM security_logs WHERE ip = '10.0.0.1'")) && Boolean(await db.get("SELECT 1 FROM security_logs WHERE ip = '10.0.0.2'")), purged);
  check('purge removes consent records 1 year after account deletion only', purged.consents === 1
    && !(await db.get('SELECT 1 FROM consents WHERE user_id = 999901')) && Boolean(await db.get('SELECT 1 FROM consents WHERE user_id = 999902'))
    && Boolean(await db.get('SELECT 1 FROM consents WHERE user_id = $1', [raviId])), purged);

  console.log('\nPrivacy: last_active_at');
  const u = await newUser('Asha', 'asha@example.com'); // register only, no logged-in request yet
  let row = await db.get('SELECT last_active_at FROM users WHERE id = $1', [u.id]);
  check('register sets last_active_at', Boolean(row.last_active_at), row);
  await db.run('UPDATE users SET last_active_at = NULL WHERE id = $1', [u.id]);
  await api('GET', '/api/auth/me');
  for (let i = 0; i < 20 && !(row = await db.get('SELECT last_active_at FROM users WHERE id = $1', [u.id])).last_active_at; i++) await wait(50);
  check('a logged-in request updates last_active_at', Boolean(row.last_active_at), row);
  await db.run("UPDATE users SET last_active_at = now() - interval '2 days' WHERE id = $1", [u.id]);
  await api('GET', '/api/auth/me');
  await api('GET', '/api/profile');
  await wait(150);
  row = await db.get("SELECT last_active_at < now() - interval '1 day' AS still_old FROM users WHERE id = $1", [u.id]);
  check('throttled: at most one update per user per day', row.still_old === true, row);
  token = saved;
}

async function deleteAccountWebTests() {
  console.log('\nPublic /delete-account page');
  const { resetRateLimit } = require('../src/routes/deleteAccount');
  resetRateLimit();
  let res = await fetch(base + '/delete-account');
  let html = await res.text();
  check('GET /delete-account -> 200 html, no login', res.status === 200 && /^text\/html/.test(res.headers.get('content-type') || ''), res.status);
  check('page explains deleted + kept data and has a POST form', html.includes('What gets deleted') && html.includes('What we keep')
    && /<form method="post" action="\/delete-account"/.test(html) && html.includes('type="password"'), html.slice(0, 200));
  check('page says deleting does not cancel Google Play + links subscriptions', html.includes('does not cancel a Google Play subscription')
    && html.includes('href="https://play.google.com/store/account/subscriptions"'));
  check('page matches policy: Mumbai logs 1 year, 7-day backups', html.includes('Mumbai (India) database for <strong>1 year</strong>')
    && html.includes('backups are kept for up to 7 days where our database plan provides them'));
  check('page cannot be framed, not cached', res.headers.get('x-frame-options') === 'DENY' && res.headers.get('cache-control') === 'no-store');

  token = (await api('POST', '/api/auth/register', { name: 'Webby', email: 'webby@example.com', password: 'secret123', accepted_terms: true })).body.token;
  const webby = (await api('GET', '/api/auth/me')).body.user;
  await api('POST', '/api/health/water', { ml: 250 });
  token = null;
  const form = (o) => fetch(base + '/delete-account', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(o).toString() });

  res = await form({ email: 'webby@example.com', password: 'wrongpass' });
  const wrongHtml = await res.text();
  res = await fetch(base + '/delete-account?email=webby@example.com&password=secret123', { method: 'GET' });
  check('GET with credentials in the URL never deletes', res.status === 200 && Boolean(await db.get('SELECT 1 FROM users WHERE id = $1', [webby.id])));
  const res2 = await form({ email: 'nobody-here@example.com', password: 'secret123' });
  const unknownHtml = await res2.text();
  const generic = 'We could not delete an account with those details.';
  check('wrong password -> 401 generic message', wrongHtml.includes(generic) && Boolean(await db.get('SELECT 1 FROM users WHERE id = $1', [webby.id])));
  check('unknown email -> same 401 generic message', res2.status === 401 && unknownHtml.includes(generic));
  res = await form({ email: 'WEBBY@example.com', password: 'secret123' });
  html = await res.text();
  check('right email + password -> 200 deleted', res.status === 200 && html.includes('have been deleted') && html.includes('https://play.google.com/store/account/subscriptions'), html.slice(0, 300));
  check('web delete removed the user and their data', !(await db.get('SELECT 1 FROM users WHERE id = $1', [webby.id]))
    && !(await db.get('SELECT 1 FROM water_logs WHERE user_id = $1', [webby.id])) && !(await db.get('SELECT 1 FROM profiles WHERE user_id = $1', [webby.id])));
  check('web delete: same logic as in-app (consents kept + marked, security log written)',
    Boolean(await db.get('SELECT 1 FROM consents WHERE user_id = $1 AND account_deleted_at IS NOT NULL', [webby.id]))
    && Boolean(await db.get("SELECT 1 FROM security_logs WHERE user_id = $1 AND event = 'account_deleted'", [webby.id])));
  let r = await api('POST', '/api/auth/login', { email: 'webby@example.com', password: 'secret123' });
  check('web-deleted account cannot log in', r.status === 401, r.body);
  res = await form({ email: 'webby@example.com', password: 'secret123' }); // 4th attempt
  check('deleting again -> generic 401', res.status === 401);
  res = await form({ email: 'x@example.com', password: 'y' }); // 5th
  check('5th attempt this hour still answered', res.status === 401);
  res = await form({ email: 'x@example.com', password: 'y' }); // 6th
  html = await res.text();
  check('6th attempt from the same IP in an hour -> 429', res.status === 429 && html.includes('Too many attempts'), res.status);
  resetRateLimit();
}

// Set up the database, start the app on a random free port (0), run the tests, stop.
async function main() {
  let ok = true;
  let server;
  try {
    await db.init();
    // Running init a second time must be harmless (it runs on every start)
    await db.init();
    server = await new Promise((resolve) => { const s = createApp().listen(0, () => resolve(s)); });
    base = `http://127.0.0.1:${server.address().port}`;
    await run();
  } catch (err) {
    ok = false;
    // check() already printed its own message; anything else is a crash
    if (!err.fromCheck) console.error(err);
  }
  if (server) server.close();
  // Remove the test schema and everything in it
  try { await db.query(`DROP SCHEMA IF EXISTS ${testSchema} CASCADE`); } catch (e) { console.error('Could not drop test schema:', e.message); }
  await db.close();
  console.log(ok ? `\nSMOKE TEST PASSED (${passed} checks)\n` : `\nSMOKE TEST FAILED after ${passed} passing checks\n`);
  process.exit(ok ? 0 : 1);
}
main();
