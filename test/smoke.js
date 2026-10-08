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
const crypto = require('crypto');

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
process.env.RAZORPAY_KEY_ID = '';
process.env.RAZORPAY_KEY_SECRET = '';
process.env.RAZORPAY_WEBHOOK_SECRET = 'smoke_webhook_secret';
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
  autoRenew = true, trial = false, accountId = null, linked = null }) {
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
      autoRenewingPlan: { autoRenewEnabled: autoRenew },
      offerDetails: { basePlanId: basePlan, ...(trial ? { offerId: 'trial-14d' } : {}) },
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
  let r = await api('POST', '/api/auth/register', { name: 'Ravi', email: 'ravi@example.com', password: 'secret123' });
  check('register returns 201 + token', r.status === 201 && r.body.token, r.body);
  r = await api('POST', '/api/auth/register', { name: 'Ravi', email: 'ravi@example.com', password: 'secret123' });
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
  check('Free: 4th budget -> 402', r.status === 402, r.body);
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
  check('Free: 3rd goal -> 402', r.status === 402, r.body);
  r = await api('POST', '/api/wealth/bills', { name: 'Electricity', amount: 1200, due_day: 1 });
  check('add bill', r.status === 201, r.body);
  const billId = r.body.bill.id;
  r = await api('GET', `/api/wealth/bills?month=${M}`);
  // due_day 1 has passed (unless today is the 1st), unpaid -> overdue
  check('unpaid past bill is overdue', r.body.bills[0].overdue === (D > `${M}-01`), r.body);
  r = await api('POST', `/api/wealth/bills/${billId}/pay`, {});
  check('pay bill', r.body.bill.paid === true && r.body.bill.overdue === false, r.body);
  r = await api('GET', '/api/wealth/calculators/sip?monthly=5000&rate=12&years=10');
  check('Free: SIP calculator -> 402', r.status === 402, r.body);

  console.log('\nPlans + subscription');
  r = await api('GET', '/api/plans');
  const pro = r.body.plans.find((p) => p.id === 'pro');
  const elite = r.body.plans.find((p) => p.id === 'elite');
  check('plans: 14-day trial, yearly is best value', r.body.trial_days === 14 && r.body.best_value_period === 'yearly', r.body);
  check('plans prices', pro.price_monthly === 99 && pro.price_yearly === 799 && elite.price_monthly === 199 && elite.price_yearly === 1499, r.body);
  r = await api('GET', '/api/subscription');
  check('starts on free', r.body.subscription.active_plan === 'free', r.body);
  r = await api('POST', '/api/coach', { question: 'calories left?' });
  check('coach blocked on free -> 402', r.status === 402, r.body);
  r = await api('POST', '/api/subscription/order', { plan: 'pro', period: 'yearly' });
  check('create stub order (79900 paise)', r.status === 201 && r.body.stub === true && r.body.amount_paise === 79900, r.body);
  const orderId = r.body.order_id;

  // Pretend to be Razorpay calling our webhook
  const event = JSON.stringify({ event: 'payment.captured', payload: { payment: { entity: { id: 'pay_test_1', order_id: orderId } } } });
  r = await api('POST', '/api/webhooks/razorpay', event, { 'X-Razorpay-Signature': 'bad-signature' });
  check('webhook with bad signature -> 400', r.status === 400, r.body);
  const sig = crypto.createHmac('sha256', process.env.RAZORPAY_WEBHOOK_SECRET).update(event).digest('hex');
  r = await api('POST', '/api/webhooks/razorpay', event, { 'X-Razorpay-Signature': sig });
  check('webhook with good signature -> 200', r.status === 200, r.body);
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
  token = (await api('POST', '/api/auth/register', { name: 'Priya', email: 'priya@example.com', password: 'secret123' })).body.token;
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
  token = (await api('POST', '/api/auth/register', { name: 'Gita', email: 'gita@example.com', password: 'secret123' })).body.token;
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
  r = await api('POST', '/api/coach', { question: 'protein foods' });
  check('Play Pro unlocks coach (requirePlan)', r.status === 200, r.body);
  r = await api('POST', '/api/subscription/cancel');
  check('cancel a Play plan in-app -> 409 (use Play Store)', r.status === 409, r.body);

  token = (await api('POST', '/api/auth/register', { name: 'Hari', email: 'hari@example.com', password: 'secret123' })).body.token;
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
  r = await api('POST', '/api/coach', { question: 'protein foods' });
  check('expired Play plan does not unlock coach -> 402', r.status === 402, r.body);

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
  r = await api('POST', '/api/coach', { question: 'protein foods' });
  check('requirePlan respects expiry (no RTDN needed) -> 402', r.status === 402, r.body);
  r = await api('GET', '/api/subscription');
  check('status after expiry -> Free (status expired)', r.body.subscription.active_plan === 'free' && r.body.subscription.status === 'expired', r.body);

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
  r = await api('POST', '/api/coach', { question: 'protein foods' });
  check('after expiry RTDN: coach locked -> 402', r.status === 402, r.body);

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

  console.log('\nYour data: export + delete account');
  r = await api('GET', '/api/export');
  check('export has your data and no password', r.status === 200 && r.body.user.email === 'ravi@example.com' && r.body.expenses.length >= 2
    && r.body.food_logs.length >= 1 && r.body.custom_foods.length === 1 && !JSON.stringify(r.body).includes('password_hash'), Object.keys(r.body));
  r = await api('DELETE', '/api/auth/me', { password: 'wrongpass' });
  check('delete account needs the right password -> 401', r.status === 401, r.body);
  r = await api('DELETE', '/api/auth/me', { password: 'secret123' });
  check('delete account', r.status === 200 && r.body.deleted === true, r.body);
  token = null;
  r = await api('POST', '/api/auth/login', { email: 'ravi@example.com', password: 'secret123' });
  check('deleted account cannot log in', r.status === 401, r.body);
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
