// test/google.js — Google sign-in tests (stage 1).
// Run: TEST_DATABASE_URL=postgres://postgres@127.0.0.1:5433/raphai_test node test/google.js
// Real google-auth-library verification (signature, issuer, expiry, audience)
// against a locally generated RSA key standing in for Google's certs.
require('dotenv').config();
if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
if (!process.env.DATABASE_URL) { console.error('Set TEST_DATABASE_URL'); process.exit(1); }
const schema = `raphai_google_${Date.now()}_${process.pid}`;
process.env.DB_SCHEMA = schema;
process.env.JWT_SECRET = 'google-test-secret-0123456789abcdef';
process.env.NODE_ENV = 'test';
const WEB = 'web-client-1.apps.googleusercontent.com';
const WEB2 = 'web-client-2.apps.googleusercontent.com';
process.env.GOOGLE_WEB_CLIENT_ID = ` ${WEB} , ${WEB2} `;

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const db = require('../src/db');
const { createApp } = require('../src/app');
const { resetAll } = require('../src/middleware/rateLimit');
const googleSvc = require('../src/services/googleIdentity');
const customers = require('../src/admin/customers');
const migrations = require('../src/migrations');

const key = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const KID = 'test-kid-1';
googleSvc.setTestCerts({ [KID]: key.publicKey.export({ type: 'spki', format: 'pem' }) });

let base; let passed = 0;
function check(name, ok, extra) {
  if (!ok) { console.error(`FAIL: ${name}`, extra === undefined ? '' : JSON.stringify(extra).slice(0, 800)); const e = new Error(name); e.fromCheck = true; throw e; }
  passed++; console.log(`  ok  ${name}`);
}
let keepLimits = false; // the rate-limit section turns this on
async function api(method, url, body, token) {
  if (!keepLimits) resetAll();
  const h = { 'Content-Type': 'application/json' };
  if (token) h.Authorization = `Bearer ${token}`;
  const res = await fetch(base + url, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text(); let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json };
}
// A Google-like ID token. Override any claim; opts.key / opts.kid for bad signatures.
function gtoken(claims = {}, opts = {}) {
  const now = Math.floor(Date.now() / 1000);
  const payload = { iss: 'https://accounts.google.com', aud: WEB, azp: 'android-client.apps.googleusercontent.com', sub: '1000001',
    email: 'new@gmail.com', email_verified: true, name: 'New Person', iat: now, exp: now + 3600, ...claims };
  return jwt.sign(payload, (opts.key || key).privateKey, { algorithm: 'RS256', keyid: opts.kid || KID });
}
const count = async (sql, p) => (await db.get(`SELECT count(*)::int AS n FROM (${sql}) z`, p)).n;
const logs = (event, userId) => count('SELECT 1 FROM security_logs WHERE event = $1 AND user_id = $2', [event, userId]);

async function run() {
  console.log('\nNot configured');
  const saved = process.env.GOOGLE_WEB_CLIENT_ID;
  delete process.env.GOOGLE_WEB_CLIENT_ID;
  let r = await api('POST', '/api/auth/google', { idToken: gtoken() });
  check('missing GOOGLE_WEB_CLIENT_ID -> 503 "Google sign-in not configured"', r.status === 503 && r.body.error === 'Google sign-in not configured' && r.body.code === 'google_not_configured', r);
  process.env.GOOGLE_WEB_CLIENT_ID = '  ,  ';
  r = await api('POST', '/api/auth/google', { idToken: gtoken() });
  check('blank GOOGLE_WEB_CLIENT_ID -> 503', r.status === 503, r);
  process.env.GOOGLE_WEB_CLIENT_ID = saved;

  console.log('\nInput and token checks');
  r = await api('POST', '/api/auth/google', {});
  check('missing idToken -> 400', r.status === 400, r);
  r = await api('POST', '/api/auth/google', { idToken: 'abc.def.ghi' });
  check('garbage token -> 401 google_token_invalid', r.status === 401 && r.body.code === 'google_token_invalid', r);
  r = await api('POST', '/api/auth/google', { idToken: gtoken({ aud: 'someone-else.apps.googleusercontent.com' }) });
  check('wrong audience -> 401', r.status === 401 && r.body.code === 'google_token_invalid', r);
  const past = Math.floor(Date.now() / 1000) - 7200;
  r = await api('POST', '/api/auth/google', { idToken: gtoken({ iat: past, exp: past + 600 }) });
  check('expired token -> 401', r.status === 401, r);
  r = await api('POST', '/api/auth/google', { idToken: gtoken({ iss: 'https://evil.example.com' }) });
  check('wrong issuer -> 401', r.status === 401, r);
  r = await api('POST', '/api/auth/google', { idToken: gtoken({}, { key: other }) });
  check('token signed by another key -> 401', r.status === 401, r);
  r = await api('POST', '/api/auth/google', { idToken: gtoken({}, { kid: 'unknown-kid' }) });
  check('unknown key id -> 401', r.status === 401, r);
  check('nothing created by rejected tokens', (await count('SELECT 1 FROM users')) === 0 && (await count('SELECT 1 FROM user_identities')) === 0);

  console.log('\nNew user + consent');
  r = await api('POST', '/api/auth/google', { idToken: gtoken() });
  check('new Google user without consent -> needs_consent, no token', r.status === 200 && r.body.needs_consent === true && !r.body.token && r.body.email === 'new@gmail.com' && r.body.terms_version, r);
  check('needs_consent created nothing', (await count('SELECT 1 FROM users')) === 0);
  r = await api('POST', '/api/auth/google', { idToken: gtoken(), accepted_terms: 'yes' });
  check('accepted_terms must be exactly true', r.status === 200 && r.body.needs_consent === true, r);
  r = await api('POST', '/api/auth/google', { idToken: gtoken(), accepted_terms: true });
  check('new Google user with consent -> 201 token + user (login shape)', r.status === 201 && r.body.token && r.body.user && r.body.user.email === 'new@gmail.com' && r.body.user.name === 'New Person' && r.body.created === true, r);
  const N = { id: r.body.user.id, token: r.body.token };
  let me = await api('GET', '/api/auth/me', undefined, N.token);
  check('session works on /api/auth/me', me.status === 200 && me.body.user.id === N.id);
  const nrow = await db.get('SELECT password_hash FROM users WHERE id = $1', [N.id]);
  check('Google-only account has no password hash', nrow.password_hash === null);
  check('consent recorded like sign-up', (await count("SELECT 1 FROM consents WHERE user_id = $1 AND type = 'terms_privacy' AND granted", [N.id])) === 1);
  check('profile, free plan, reminders created', (await count('SELECT 1 FROM profiles WHERE user_id = $1', [N.id])) === 1
    && (await count("SELECT 1 FROM subscriptions WHERE user_id = $1 AND plan = 'free'", [N.id])) === 1 && (await count('SELECT 1 FROM reminder_settings WHERE user_id = $1', [N.id])) === 1);
  check('identity stored (provider, sub, email, verified)', (await count("SELECT 1 FROM user_identities WHERE user_id = $1 AND provider = 'google' AND provider_sub = '1000001' AND email_verified", [N.id])) === 1);
  check('google_signup audited', (await logs('google_signup', N.id)) === 1);

  console.log('\nExisting link');
  r = await api('POST', '/api/auth/google', { idToken: gtoken({ email: 'renamed@gmail.com' }) });
  check('linked sub signs in the same user (even if Google email changed)', r.status === 200 && r.body.user.id === N.id && r.body.created === false && r.body.token, r);
  check('no duplicate user', (await count('SELECT 1 FROM users')) === 1);
  r = await api('POST', '/api/auth/google', { idToken: gtoken({ aud: WEB2 }) });
  check('second audience in the comma list accepted', r.status === 200 && r.body.user.id === N.id, r);
  r = await api('POST', '/api/auth/login', { email: 'new@gmail.com', password: 'anything123' });
  check('password login on a Google-only account -> 401 (no crash)', r.status === 401 && r.body.error === 'Wrong email or password', r);
  r = await api('POST', '/delete-account', { email: 'new@gmail.com', password: 'anything123' });
  check('web delete-account with a password on a Google-only account -> refused (no crash)', r.status >= 400 && r.status < 500, r.status);

  console.log('\nVerified-email auto-link');
  r = await api('POST', '/api/auth/register', { name: 'Priya', email: 'priya@gmail.com', password: 'secret123', accepted_terms: true });
  const P = { id: r.body.user.id, token: r.body.token };
  r = await api('POST', '/api/auth/google', { idToken: gtoken({ sub: '2000002', email: 'Priya@gmail.com', name: 'Priya G' }) });
  check('same verified email -> auto-linked to the existing account', r.status === 200 && r.body.user.id === P.id && r.body.linked === true && r.body.created === false, r);
  check('auto-link audited (google_auto_linked)', (await logs('google_auto_linked', P.id)) === 1);
  r = await api('POST', '/api/auth/login', { email: 'priya@gmail.com', password: 'secret123' });
  check('password login still works after auto-link', r.status === 200 && r.body.user.id === P.id);
  r = await api('POST', '/api/auth/google', { idToken: gtoken({ sub: '2999999', email: 'priya@gmail.com' }) });
  check('a different Google account with the same email cannot take over -> 409', r.status === 409 && r.body.code === 'google_other_linked', r);

  console.log('\nUnverified email');
  r = await api('POST', '/api/auth/register', { name: 'Ravi', email: 'ravi@example.com', password: 'secret123', accepted_terms: true });
  const R = { id: r.body.user.id, token: r.body.token };
  r = await api('POST', '/api/auth/google', { idToken: gtoken({ sub: '3000003', email: 'ravi@example.com', email_verified: false }), accepted_terms: true });
  check('unverified email matching an account -> 403, not linked', r.status === 403 && r.body.code === 'google_email_unverified' && (await count('SELECT 1 FROM user_identities WHERE user_id = $1', [R.id])) === 0, r);
  r = await api('POST', '/api/auth/google', { idToken: gtoken({ sub: '3000004', email: 'fresh@example.com', email_verified: 'false' }), accepted_terms: true });
  check('unverified email for a new account -> 403, nothing created', r.status === 403 && (await count("SELECT 1 FROM users WHERE email = 'fresh@example.com'")) === 0, r);

  console.log('\nLink / unlink / identities');
  r = await api('GET', '/api/auth/identities', undefined, R.token);
  check('identities: password yes, Google not linked', r.status === 200 && r.body.password === true && r.body.google.linked === false && r.body.google.available === true, r);
  r = await api('POST', '/api/auth/google/link', { idToken: gtoken({ sub: '4000004', email: 'ravi.other@gmail.com' }) });
  check('link without login -> 401', r.status === 401);
  r = await api('POST', '/api/auth/google/link', { idToken: gtoken({ sub: '4000004', email: 'ravi.other@gmail.com' }) }, R.token);
  check('link a Google account -> 201', r.status === 201 && r.body.linked === true, r);
  r = await api('POST', '/api/auth/google/link', { idToken: gtoken({ sub: '4000004', email: 'ravi.other@gmail.com' }) }, R.token);
  check('linking it again is a no-op 200', r.status === 200 && r.body.linked === true, r);
  r = await api('POST', '/api/auth/google/link', { idToken: gtoken({ sub: '4000005', email: 'ravi.third@gmail.com' }) }, R.token);
  check('a second, different Google account -> 409', r.status === 409 && r.body.code === 'google_other_linked', r);
  r = await api('POST', '/api/auth/google/link', { idToken: gtoken({ sub: '1000001' }) }, R.token);
  check("someone else's Google account -> 409 google_in_use", r.status === 409 && r.body.code === 'google_in_use', r);
  r = await api('POST', '/api/auth/google/link', { idToken: gtoken({ sub: '4000006', aud: 'wrong-aud' }) }, P.token);
  check('link with wrong audience -> 401', r.status === 401, r);
  r = await api('GET', '/api/auth/identities', undefined, R.token);
  check('identities shows Google linked', r.body.google.linked === true && r.body.google.email === 'ravi.other@gmail.com', r);
  r = await api('POST', '/api/auth/google', { idToken: gtoken({ sub: '4000004', email: 'ravi.other@gmail.com' }) });
  check('linked Google account signs in to that user', r.status === 200 && r.body.user.id === R.id, r);
  r = await api('DELETE', '/api/auth/google/unlink', undefined, R.token);
  check('unlink when a password exists -> 200', r.status === 200 && r.body.linked === false && (await count('SELECT 1 FROM user_identities WHERE user_id = $1', [R.id])) === 0, r);
  check('link + unlink audited', (await logs('google_linked', R.id)) === 1 && (await logs('google_unlinked', R.id)) === 1);

  r = await api('DELETE', '/api/auth/google/unlink', undefined, N.token);
  check('unlink guard: Google-only account cannot unlink its only login -> 409', r.status === 409 && r.body.code === 'last_login_method', r);
  check('identity still there after refused unlink', (await count('SELECT 1 FROM user_identities WHERE user_id = $1', [N.id])) === 1);

  console.log('\nGoogle-only user sets a password (existing reset flow), then can unlink');
  const code = '123456';
  const hmac = crypto.createHmac('sha256', process.env.JWT_SECRET).update(`${N.id}:${code}`).digest('hex');
  await db.run("INSERT INTO password_resets (user_id, code_hash, expires_at) VALUES ($1, $2, now() + interval '15 minutes')", [N.id, hmac]);
  r = await api('POST', '/api/auth/reset', { email: 'new@gmail.com', code, new_password: 'brandnew123' });
  check('reset sets a password on a Google-only account', r.status === 200 && r.body.reset === true, r);
  r = await api('POST', '/api/auth/login', { email: 'new@gmail.com', password: 'brandnew123' });
  check('email login works after setting a password', r.status === 200 && r.body.user.id === N.id, r);
  N.token = r.body.token;
  r = await api('GET', '/api/auth/identities', undefined, N.token);
  check('identities: password + Google', r.body.password === true && r.body.google.linked === true, r);

  console.log('\nDelete account (Google-only confirms with a Google token)');
  r = await api('POST', '/api/auth/google', { idToken: gtoken({ sub: '5000005', email: 'gonly@gmail.com', name: 'G Only' }), accepted_terms: true });
  const G = { id: r.body.user.id, token: r.body.token };
  r = await api('DELETE', '/api/auth/me', { password: 'whatever1' }, G.token);
  check('Google-only delete without google_id_token -> 400', r.status === 400, r);
  r = await api('DELETE', '/api/auth/me', { google_id_token: gtoken({ sub: '1000001' }) }, G.token);
  check("Google-only delete with another user's Google token -> 401", r.status === 401, r);
  r = await api('DELETE', '/api/auth/me', { google_id_token: gtoken({ sub: '5000005', email: 'gonly@gmail.com' }) }, G.token);
  check('Google-only delete with its own Google token -> deleted', r.status === 200 && r.body.deleted === true, r);
  check('identity removed with the account (cascade)', (await count("SELECT 1 FROM user_identities WHERE provider_sub = '5000005'")) === 0);
  r = await api('DELETE', '/api/auth/me', { password: 'secret123' }, R.token);
  check('password delete unchanged', r.status === 200 && r.body.deleted === true, r);

  console.log('\nAdmin + RLS');
  await api('POST', '/api/auth/google', { idToken: gtoken({ sub: '6000006', email: 'admin.view@gmail.com' }), accepted_terms: true });
  const list = await customers.all({});
  const by = Object.fromEntries(list.map((c) => [c.email, c.sign_in_method]));
  check('admin sign_in_method shows providers', by['priya@gmail.com'] === 'Email + password, Google' && by['admin.view@gmail.com'] === 'Google' && by['new@gmail.com'] === 'Email + password, Google', by);
  const rls = await db.get(`SELECT c.relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relname = 'user_identities'`, [schema]);
  check('RLS enabled on user_identities', rls && rls.relrowsecurity === true);
  check('owner_rows policy on user_identities', (await count("SELECT 1 FROM pg_policies WHERE schemaname = $1 AND tablename = 'user_identities' AND policyname = 'owner_rows'", [schema])) === 1);

  console.log('\nMigration 009 is reversible and keeps data');
  const before = await count('SELECT 1 FROM user_identities');
  const gOnly = await db.get("SELECT id FROM users WHERE email = 'admin.view@gmail.com'");
  const m = migrations.find((x) => x.id === '009_user_identities');
  await db.tx(async (t) => { await t.query(m.down); });
  const after = await db.get('SELECT password_hash FROM users WHERE id = $1', [gOnly.id]);
  const nn = await db.get(`SELECT is_nullable FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'users' AND column_name = 'password_hash'`, [schema]);
  check('down: password_hash NOT NULL again, Google-only rows get an unusable marker', nn.is_nullable === 'NO' && after.password_hash === '!no-password');
  check('down: identities kept (renamed), migration unrecorded', (await count('SELECT 1 FROM user_identities_rolled_back_009')) === before
    && (await count("SELECT 1 FROM schema_migrations WHERE id = '009_user_identities'")) === 0);
  check('marker hash never matches a password', !(await bcrypt.compare('!no-password', after.password_hash)));
  await db.init();
  check('re-apply restores identities and password-less rows', (await count('SELECT 1 FROM user_identities')) === before
    && (await db.get('SELECT password_hash FROM users WHERE id = $1', [gOnly.id])).password_hash === null);
  r = await api('POST', '/api/auth/google', { idToken: gtoken({ sub: '6000006', email: 'admin.view@gmail.com' }) });
  check('sign-in works after down + up', r.status === 200 && r.body.user.id === gOnly.id, r);

  console.log('\nRate limit');
  resetAll(); keepLimits = true;
  let limited = null;
  for (let i = 0; i < 32; i++) {
    const x = await api('POST', '/api/auth/google', { idToken: 'abc.def.ghi' });
    if (x.status === 429) { limited = i; break; }
  }
  check('POST /api/auth/google is rate limited per IP (30 / 15 min)', limited === 30, limited);
  resetAll();
}

async function main() {
  let ok = true; let server;
  try {
    await db.init(); await db.init();
    server = await new Promise((res) => { const s = createApp().listen(0, () => res(s)); });
    base = `http://127.0.0.1:${server.address().port}`;
    await run();
  } catch (e) { ok = false; if (!e.fromCheck) console.error(e); }
  if (server) server.close();
  try { await db.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); } catch (e) { console.error('drop schema:', e.message); }
  await db.close();
  console.log(ok ? `\nGOOGLE AUTH TEST PASSED (${passed} checks)\n` : `\nGOOGLE AUTH TEST FAILED after ${passed} passing checks\n`);
  process.exit(ok ? 0 : 1);
}
main();
