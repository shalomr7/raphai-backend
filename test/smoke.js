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

const db = require('../src/db');
const { createApp } = require('../src/app');
const { today, thisMonth } = require('../src/utils/dates');

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
