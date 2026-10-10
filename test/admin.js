// test/admin.js — admin dashboard smoke + security tests.
// Run: TEST_DATABASE_URL=postgres://postgres@127.0.0.1:5433/raphai_test node test/admin.js
// Covers: /admin page + CSP + noindex; owner-only access (no token 401, any app
// token 403, admin token useless on the app API); two-step sign-in (admin
// password and email code) + rate limits; every section returns aggregates
// with NO names/emails/per-user records and groups of 1-4 shown as "<5";
// customers directory/detail/CSV return identity + subscription fields only
// (no health or finance values); phone masking; every admin action is in the
// security log with actor + target; support export + delete.
require('dotenv').config();
if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
if (!process.env.DATABASE_URL) { console.error('Set TEST_DATABASE_URL'); process.exit(1); }
const schema = `raphai_adm_${Date.now()}_${process.pid}`;
process.env.DB_SCHEMA = schema;
process.env.JWT_SECRET = 'admin-test-secret-0123456789abcdefghij';
process.env.NODE_ENV = 'test';
process.env.ADMIN_EMAILS = 'owner@example.com';
delete process.env.ADMIN_SECOND_FACTOR;
delete process.env.RESEND_API_KEY; delete process.env.EMAIL_FROM;
delete process.env.CORS_ORIGIN;

const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
process.env.ADMIN_PASSWORD_HASH = bcrypt.hashSync('Admin-Second-Step-42', 4);

const db = require('../src/db');
const { createApp } = require('../src/app');
const { resetAll } = require('../src/middleware/rateLimit');
const emailSvc = require('../src/services/email');
const adminAuth = require('../src/admin/auth');
const { maskPhone } = require('../src/admin/customers');
const { today, addDays } = require('../src/utils/dates');

let base; let passed = 0;
function check(name, ok, extra) {
  if (!ok) { console.error(`FAIL: ${name}`, extra === undefined ? '' : JSON.stringify(extra).slice(0, 1200)); const e = new Error(name); e.fromCheck = true; throw e; }
  passed++; console.log(`  ok  ${name}`);
}
async function api(method, url, body, token, headers = {}) {
  const h = { 'Content-Type': 'application/json', ...headers };
  if (token) h.Authorization = `Bearer ${token}`;
  const res = await fetch(base + url, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text(); let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json, text, headers: res.headers };
}
async function register(name, email) {
  const r = await api('POST', '/api/auth/register', { name, email, password: 'secret123', accepted_terms: true });
  if (r.status !== 201) throw new Error(`register ${email}: ${r.status} ${r.text}`);
  return { token: r.body.token, id: r.body.user.id, name, email };
}
async function adminLogin(email = 'owner@example.com', password = 'secret123', code = 'Admin-Second-Step-42') {
  const s1 = await api('POST', '/api/admin/login', { email, password });
  if (s1.status !== 200) return { s1 };
  const s2 = await api('POST', '/api/admin/verify', { challenge: s1.body.challenge, code });
  return { s1, s2, token: s2.body && s2.body.token };
}
const logs = (event) => db.all('SELECT user_id, actor_id, detail, created_at FROM security_logs WHERE event = $1 ORDER BY id', [event]);

// Every number tied to a group of users in a bucket list must not be 1-4
function smallLeaks(v, path = '$', out = []) {
  if (Array.isArray(v)) v.forEach((x, i) => smallLeaks(x, `${path}[${i}]`, out));
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) {
    if (['value', 'users'].includes(k) && typeof x === 'number' && x >= 1 && x <= 4) out.push(`${path}.${k}=${x}`);
    smallLeaks(x, `${path}.${k}`, out);
  }
  return out;
}

// Seeded health/finance values, as standalone numbers (not parts of timestamps)
const LEAK = /(^|[^\d.])(12345|2222|97\.7|77\.7|76\.1|4321(\.5)?|432150|50000|5000000)([^\d.]|$)|SECRETNOTE/;
const HEALTH_FINANCE_KEYS = ['steps', 'weight_kg', 'height_cm', 'kcal', 'calories', 'ml', 'water', 'sleep', 'hours', 'mood', 'resting_hr',
  'income', 'income_paise', 'expenses', 'budgets', 'savings_goals', 'bills', 'category', 'note', 'amount', 'amount_paise', 'target', 'saved',
  'neck_cm', 'waist_cm', 'hip_cm', 'question', 'answer', 'chats', 'food_logs', 'password_hash'];
function keysIn(v, out = new Set()) {
  if (Array.isArray(v)) v.forEach((x) => keysIn(x, out));
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { out.add(k); keysIn(x, out); }
  return out;
}

async function run() {
  const D = today();
  console.log('\nPage, CSP, noindex');
  let r = await api('GET', '/admin');
  check('GET /admin -> 200 HTML login page', r.status === 200 && /Owner sign-in/.test(r.text) && /<script src="\/admin\/app.js">/.test(r.text));
  const csp = r.headers.get('content-security-policy') || '';
  check('/admin CSP allows only same-origin script/style/connect', /script-src 'self'/.test(csp) && /connect-src 'self'/.test(csp) && !/unsafe-inline|unsafe-eval|https?:/.test(csp));
  check('/admin noindex (header + meta) and no-store', /noindex/.test(r.headers.get('x-robots-tag') || '') && /<meta name="robots" content="noindex/.test(r.text) && /no-store/.test(r.headers.get('cache-control') || ''));
  r = await api('GET', '/admin/app.js');
  check('/admin/app.js served, no innerHTML', r.status === 200 && /application\/javascript/.test(r.headers.get('content-type')) && !/innerHTML/.test(r.text));
  r = await api('GET', '/privacy');
  check('other pages keep the strict CSP (no scripts)', !/script-src/.test(r.headers.get('content-security-policy') || ''));
  r = await api('GET', '/admin', undefined, null, {});
  check('the login page contains no customer data', !/@example\.com/.test(r.text));

  console.log('\nSeed users and data');
  const owner = await register('Owner Raj', 'owner@example.com');
  const users = [];
  for (let i = 0; i < 8; i++) users.push(await register(`Zed Person${i}`, `zed${i}@example.com`));
  const [u0, u1, u2] = users;
  // Steps for 6 users (>= 5: average shown), water for 2 users (< 5: suppressed)
  for (let i = 0; i < 6; i++) await db.run('INSERT INTO step_logs (user_id, date, steps) VALUES ($1, $2, $3)', [users[i].id, D, 12345]);
  await db.run('INSERT INTO water_logs (user_id, date, ml) VALUES ($1, $2, 2222), ($3, $2, 2222)', [u0.id, D, u1.id]);
  // BMI: 6 users "18.5-22.9", 2 users "30+"
  for (let i = 0; i < 8; i++) await db.run('UPDATE profiles SET height_cm = 170, weight_kg = $2, age = 30, sex = $3, income = 50000 WHERE user_id = $1', [users[i].id, i < 6 ? 60 : 97.7, i % 2 ? 'female' : 'male']);
  await db.run("INSERT INTO expenses (user_id, amount, category, mode, note, date) VALUES ($1, 4321.5, 'Food', 'UPI', 'SECRETNOTE', $2)", [u0.id, D]);
  await db.run("INSERT INTO weight_logs (user_id, date, weight_kg) VALUES ($1, $2, 77.7), ($1, $3, 76.1)", [u0.id, addDays(D, -5), D]);
  await db.run("INSERT INTO consents (user_id, type, version, granted) VALUES ($1, 'health_connect', '2026-10-08', true)", [u0.id]);
  // u1: paid Pro yearly via Play with an order id; u2: on the server trial
  const exp = new Date(Date.now() + 200 * 86400000).toISOString();
  await db.run("UPDATE subscriptions SET plan = 'pro', period = 'yearly', status = 'active', expires_at = $2, source = 'google_play', auto_renew = 1, google_purchase_token = 'tok-u1' WHERE user_id = $1", [u1.id, exp]);
  await db.run(`INSERT INTO google_play_purchases (purchase_token, user_id, product_id, base_plan_id, plan, period, subscription_state, expires_at, auto_renew, latest_order_id)
    VALUES ('tok-u1', $1, 'raphai_pro', 'yearly', 'pro', 'yearly', 'SUBSCRIPTION_STATE_ACTIVE', $2, 1, 'GPA.1234-5678-9012-34567')`, [u1.id, exp]);
  await db.run("UPDATE subscriptions SET plan = 'pro', period = 'trial', status = 'active', expires_at = $2, trial_used = 1 WHERE user_id = $1", [u2.id, new Date(Date.now() + 10 * 86400000).toISOString()]);
  check('seeded', true);

  console.log('\nAccess control');
  const SECTIONS = ['growth', 'revenue', 'health', 'money', 'coach', 'app', 'customers', 'customers/export.csv', `customers/${u0.id}`, 'session'];
  for (const s of SECTIONS) {
    r = await api('GET', `/api/admin/${s}`);
    check(`no token -> 401 on /api/admin/${s}`, r.status === 401);
    r = await api('GET', `/api/admin/${s}`, undefined, u0.token);
    check(`normal user token -> 403 on /api/admin/${s}`, r.status === 403 && !/zed|owner@/i.test(r.text));
  }
  r = await api('GET', '/api/admin/growth', undefined, owner.token);
  check("owner's normal app token (no second step) -> 403", r.status === 403);
  for (const [m, p] of [['POST', `/customers/${u0.id}/reveal-phone`], ['POST', `/customers/${u0.id}/export`], ['POST', `/customers/${u0.id}/delete`]]) {
    r = await api(m, `/api/admin${p}`, { reason: 'x', confirm_id: u0.id }, u0.token);
    check(`normal user -> 403 on ${m} ${p}`, r.status === 403);
  }
  const forged = jwt.sign({ sub: String(owner.id), adm: 1 }, process.env.JWT_SECRET, { algorithm: 'HS256', audience: adminAuth.AUDIENCE, expiresIn: '10m' });
  r = await api('GET', '/api/admin/growth', undefined, forged);
  check('admin token signed with the app key is rejected (403, not 200)', r.status === 403);
  check('denials are logged (admin_denied)', (await logs('admin_denied')).length >= SECTIONS.length);

  console.log('\nTwo-step sign-in');
  let a = await adminLogin('owner@example.com', 'wrong-password');
  check('owner wrong password -> 401', a.s1.status === 401);
  a = await adminLogin('zed0@example.com', 'secret123');
  check('non-admin with the right password -> 401 (no second step offered)', a.s1.status === 401 && !a.s1.body.challenge);
  const s1 = await api('POST', '/api/admin/login', { email: 'owner@example.com', password: 'secret123' });
  check('owner right password -> second step (admin password)', s1.status === 200 && s1.body.step === 'admin_password' && s1.body.challenge && !s1.body.token);
  r = await api('POST', '/api/admin/verify', { challenge: s1.body.challenge, code: 'nope' });
  check('wrong admin password -> 401', r.status === 401);
  r = await api('POST', '/api/admin/verify', { challenge: s1.body.challenge, code: 'Admin-Second-Step-42' });
  check('right admin password -> admin token', r.status === 200 && typeof r.body.token === 'string');
  const T = r.body.token;
  r = await api('POST', '/api/admin/verify', { challenge: s1.body.challenge, code: 'Admin-Second-Step-42' });
  check('a challenge works only once', r.status === 401);
  r = await api('GET', '/api/profile', undefined, T);
  check('admin token does not work on the app API (401)', r.status === 401);
  check('sign-in events logged', (await logs('admin_login_success')).length === 1 && (await logs('admin_login_failed')).length >= 3 && (await logs('admin_second_step_sent')).length >= 1);

  console.log('\nSections: aggregates only, small groups suppressed');
  const names = [owner, ...users].map((u) => u.name);
  for (const s of ['growth', 'revenue', 'health', 'money', 'coach', 'app']) {
    r = await api('GET', `/api/admin/${s}`, undefined, T);
    check(`GET /api/admin/${s} -> 200`, r.status === 200 && r.body.section === s, r.body);
    check(`${s}: no emails, names or user ids`, !/@/.test(r.text) && !names.some((n) => r.text.includes(n)) && !/"user_id"|"email"|"name"/.test(r.text));
    check(`${s}: no group of 1-4 shown as a number`, smallLeaks(r.body).length === 0, smallLeaks(r.body));
    check(`${s}: noindex + no-store`, /noindex/.test(r.headers.get('x-robots-tag') || '') && /no-store/.test(r.headers.get('cache-control') || ''));
    if (s === 'growth') {
      check('growth: total users exact, DAU/WAU/MAU numbers', r.body.total_users === 9 && r.body.signups_by_day.at(-1).value === 9 && r.body.mau === 9);
      check('growth: retention cohort too small -> null/"<5"', [null, '<5'].includes(r.body.retention.d1.pct));
    }
    if (s === 'health') {
      check('health: avg steps shown for 6 users', r.body.avg_daily_steps_7d === 12345 && r.body.step_goal_hit_pct_7d === 100);
      check('health: avg water for 2 users -> "<5"', r.body.avg_water_ml_7d === '<5');
      const bmi = Object.fromEntries(r.body.bmi_distribution.map((b) => [b.label, b.value]));
      check('health: BMI bucket of 6 shown, bucket of 2 -> "<5"', bmi['18.5-22.9'] === 6 && bmi['30+'] === '<5', bmi);
      check('health: Health Connect 1 of 9 -> "<5"', r.body.health_connect_connected_pct === '<5');
      check('health: weight trend of 1 user -> "<5"', r.body.weight_trend_30d.find((b) => b.label === 'Losing').value === '<5');
      check("health: no seeded raw values (avg steps of 6 users is allowed)", !LEAK.test(r.text.replace(/"avg_daily_steps_7d":12345/, "")), r.text.match(LEAK));
    }
    if (s === 'money') {
      check('money: 1 spender -> categories "<5", no amounts/notes', r.body.top_spending_categories_30d === '<5' && !LEAK.test(r.text));
      check('money: SIP/EMI history "Not tracked yet"', r.body.calculators.persistent.not_tracked === true);
    }
    if (s === 'revenue') {
      check('revenue: paid 1, trial 1 -> "<5"; MRR from list price', r.body.plans.paid === '<5' && r.body.plans.trial === '<5' && r.body.estimated_mrr_inr === Math.round(1499 / 12));
    }
    if (s === 'coach') check('coach: topics + guardrail blocks "Not tracked yet"', r.body.topics.not_tracked && r.body.guardrail_blocks.not_tracked);
  }
  const views = await logs('admin_view');
  check('every section view logged with the admin as actor', views.length === 6 && views.every((v) => v.actor_id === owner.id && v.detail && v.detail.section));

  console.log('\nCustomers directory');
  r = await api('GET', '/api/admin/customers?per_page=5', undefined, T);
  check('list: paginated (9 customers, 2 pages)', r.status === 200 && r.body.total === 9 && r.body.pages === 2 && r.body.customers.length === 5);
  const c0 = r.body.customers[0];
  for (const f of ['id', 'name', 'email', 'phone', 'gender', 'age', 'date_of_birth', 'sign_in_method', 'plan', 'subscription_status', 'renewal', 'signup_at', 'last_active_at', 'health_connect_connected', 'consents', 'account_status']) {
    check(`list row has ${f}`, f in c0, c0);
  }
  check('phone + DOB "Not collected"', c0.phone === 'Not collected' && c0.date_of_birth === 'Not collected');
  const listKeys = keysIn(r.body);
  check('list: no health or finance keys', HEALTH_FINANCE_KEYS.every((k) => !listKeys.has(k)), [...listKeys]);
  check('list: no health or finance values', !LEAK.test(r.text));
  check('list views logged', (await logs('admin_customer_list')).length === 1);

  r = await api('GET', '/api/admin/customers?q=zed1', undefined, T);
  check('search by email', r.status === 200 && r.body.total === 1 && r.body.customers[0].id === u1.id);
  check('paid customer: plan "Pro yearly", renews date', r.body.customers[0].plan === 'Pro yearly' && r.body.customers[0].renewal.kind === 'renews');
  r = await api('GET', `/api/admin/customers?q=${u2.id}`, undefined, T);
  check('search by id; trial label', r.body.customers.some((c) => c.id === u2.id && /^Trial/.test(c.plan)));
  r = await api('GET', '/api/admin/customers?plan=paid', undefined, T);
  check('filter by plan', r.body.total === 1 && r.body.customers[0].id === u1.id);
  r = await api('GET', '/api/admin/customers?q=%25', undefined, T);
  check('LIKE wildcards are escaped', r.status === 200 && r.body.total === 0);
  const searches = await logs('admin_customer_search');
  check('searches logged with the query and who', searches.length === 4 && searches[0].actor_id === owner.id && searches[0].detail.q === 'zed1');

  r = await api('GET', `/api/admin/customers/${u1.id}`, undefined, T);
  check('detail -> 200 with payment history (order id, amount, date)', r.status === 200 && r.body.customer.payments.length === 1
    && r.body.customer.payments[0].order_id === 'GPA.1234-5678-9012-34567' && r.body.customer.payments[0].amount_inr === 1499 && r.body.customer.payments[0].date);
  r = await api('GET', `/api/admin/customers/${u0.id}`, undefined, T);
  const dk = keysIn(r.body);
  check('detail: no health or finance keys', HEALTH_FINANCE_KEYS.every((k) => !dk.has(k)), [...dk]);
  check('detail: no health or finance values', !LEAK.test(r.text));
  check('detail: Health Connect yes, gender + age shown', r.body.customer.health_connect_connected === 'Yes' && r.body.customer.gender === 'Male' && r.body.customer.age === 30);
  const cv = await logs('admin_customer_view');
  check('detail views logged with target user + actor', cv.length === 2 && cv[1].user_id === u0.id && cv[1].actor_id === owner.id);
  r = await api('GET', '/api/admin/customers/999999', undefined, T);
  check('unknown customer -> 404', r.status === 404);

  r = await api('POST', `/api/admin/customers/${u0.id}/reveal-phone`, undefined, T);
  check('reveal phone -> "Not collected" (logged)', r.status === 200 && r.body.status === 'Not collected');
  const rv = await logs('admin_phone_reveal');
  check('phone reveal logged with target + actor', rv.length === 1 && rv[0].user_id === u0.id && rv[0].actor_id === owner.id);
  check('maskPhone 9812345621 -> 98xxxxxx21', maskPhone('9812345621') === '98xxxxxx21' && maskPhone('+91 98123 45621') === '98xxxxxx21');

  r = await api('GET', '/api/admin/customers/export.csv', undefined, T);
  const header = r.text.split('\r\n')[0];
  check('CSV: identity + subscription columns only', r.status === 200 && /text\/csv/.test(r.headers.get('content-type'))
    && header === 'id,name,email,phone,gender,age,date_of_birth,sign_in_method,plan,subscription_status,renews_or_expires,billing,signup_at,last_active_at,health_connect_connected,terms_privacy,account_status', header);
  check('CSV: 9 rows, no health/finance values', r.text.trim().split('\r\n').length === 10 && !LEAK.test(r.text));
  check('CSV export logged', (await logs('admin_customer_csv')).length === 1);
  await db.run("UPDATE users SET name = '=HYPERLINK(\"x\")' WHERE id = $1", [u2.id]);
  r = await api('GET', `/api/admin/customers/export.csv?q=${u2.id}`, undefined, T);
  check('CSV formula injection neutralised', r.text.includes(`"'=HYPERLINK(""x"")"`), r.text);

  console.log('\nSupport actions');
  r = await api('POST', `/api/admin/customers/${u0.id}/export`, {}, T);
  check('export needs a reason', r.status === 400);
  r = await api('POST', `/api/admin/customers/${u0.id}/export`, { reason: 'Ticket #12 data access request' }, T);
  check('export -> that user\'s data file', r.status === 200 && r.body.user.id === u0.id && /attachment/.test(r.headers.get('content-disposition') || ''));
  const ex = await logs('admin_user_export');
  check('export logged with reason, target, actor', ex.length === 1 && ex[0].user_id === u0.id && ex[0].actor_id === owner.id && /Ticket #12/.test(ex[0].detail.reason));
  r = await api('POST', `/api/admin/customers/${u3()}/delete`, { confirm_id: 1, reason: 'request' }, T);
  check('delete: wrong confirm id -> 400', r.status === 400);
  r = await api('POST', `/api/admin/customers/${owner.id}/delete`, { confirm_id: owner.id, reason: 'test' }, T);
  check('delete: admin account refused (409)', r.status === 409);
  r = await api('POST', `/api/admin/customers/${users[7].id}/delete`, { confirm_id: users[7].id, reason: 'Deletion request ref D-7' }, T);
  check('delete on request -> deleted', r.status === 200 && r.body.deleted === true && !(await db.get('SELECT id FROM users WHERE id = $1', [users[7].id])));
  const dl = await logs('admin_user_delete');
  check('delete logged (admin_user_delete + account_deleted)', dl.length === 1 && dl[0].actor_id === owner.id && dl[0].user_id === users[7].id && (await logs('account_deleted')).some((x) => x.user_id === users[7].id));
  r = await api('GET', '/api/admin/growth', undefined, T);
  check('deleted account counted (1 -> "<5")', r.body.deleted_accounts.last_30_days === '<5');

  console.log('\nRevocation, email code, rate limits');
  process.env.ADMIN_EMAILS = 'someone-else@example.com';
  r = await api('GET', '/api/admin/session', undefined, T);
  check('removing the email from ADMIN_EMAILS locks the token out (403)', r.status === 403);
  process.env.ADMIN_EMAILS = 'owner@example.com';
  r = await api('GET', '/api/admin/session', undefined, T);
  check('ADMIN_EMAILS back -> token works', r.status === 200 && r.body.admin.email === 'owner@example.com');
  delete process.env.ADMIN_EMAILS;
  check('ADMIN_EMAILS defaults to the owner', adminAuth.adminEmails().join() === 'rooppashalemraju@gmail.com');
  process.env.ADMIN_EMAILS = 'owner@example.com';

  resetAll();
  const outbox = [];
  emailSvc.setEmailProvider({ send: async (m) => { outbox.push(m); } });
  process.env.ADMIN_SECOND_FACTOR = 'email';
  const e1 = await api('POST', '/api/admin/login', { email: 'owner@example.com', password: 'secret123' });
  check('email mode -> step email_code, code emailed to the admin', e1.status === 200 && e1.body.step === 'email_code' && outbox.length === 1 && outbox[0].to === 'owner@example.com');
  const code = (outbox[0].text.match(/\b(\d{6})\b/) || [])[1];
  r = await api('POST', '/api/admin/verify', { challenge: e1.body.challenge, code: code === '000000' ? '111111' : '000000' });
  check('wrong email code -> 401', r.status === 401);
  r = await api('POST', '/api/admin/verify', { challenge: e1.body.challenge, code });
  check('right email code -> admin token', r.status === 200 && r.body.token);
  emailSvc.setEmailProvider(null);
  delete process.env.ADMIN_SECOND_FACTOR;
  const savedHash = process.env.ADMIN_PASSWORD_HASH; delete process.env.ADMIN_PASSWORD_HASH;
  r = await api('POST', '/api/admin/login', { email: 'owner@example.com', password: 'secret123' });
  check('no second step configured -> 503 (admin login off)', r.status === 503);
  process.env.ADMIN_PASSWORD_HASH = savedHash;

  resetAll();
  let last;
  for (let i = 0; i < 6; i++) last = await api('POST', '/api/admin/login', { email: 'owner@example.com', password: 'bad-guess' });
  check('6th wrong password for the admin email -> 429', last.status === 429);
  resetAll();
  for (let i = 0; i < 11; i++) last = await api('POST', '/api/admin/login', { email: `x${i}@example.com`, password: 'bad' });
  check('11th admin login from one IP in 15 min -> 429', last.status === 429);
  resetAll();
  const ch = await api('POST', '/api/admin/login', { email: 'owner@example.com', password: 'secret123' });
  for (let i = 0; i < 5; i++) await api('POST', '/api/admin/verify', { challenge: ch.body.challenge, code: 'wrong' });
  r = await api('POST', '/api/admin/verify', { challenge: ch.body.challenge, code: 'Admin-Second-Step-42' });
  check('challenge burned after 5 wrong codes', r.status === 401);
  resetAll();

  function u3() { return users[3].id; }
}

async function main() {
  let ok = true;
  await db.init();
  const app = createApp();
  const server = await new Promise((res) => { const s = app.listen(0, () => res(s)); });
  base = `http://127.0.0.1:${server.address().port}`;
  try { await run(); } catch (err) { ok = false; if (!err.fromCheck) console.error(err); }
  server.close();
  try { await db.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); } catch { /* ignore */ }
  await db.close();
  console.log(`\n${ok ? 'ALL ADMIN TESTS PASSED' : 'ADMIN TESTS FAILED'} (${passed} checks)`);
  process.exit(ok ? 0 : 1);
}
main();
