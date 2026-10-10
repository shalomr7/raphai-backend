// routes/admin.js
// ------------------------------------------------------------
// Owner-only JSON API for the admin dashboard (page: routes/adminPage.js).
//   POST /api/admin/login          { email, password }   step 1 (normal login)
//   POST /api/admin/verify         { challenge, code }   step 2 -> { token }
//   GET  /api/admin/session        who is signed in
//   GET  /api/admin/growth | revenue | health | money | coach | app   (aggregates)
//   GET  /api/admin/customers?q=&plan=&page=&per_page=   directory (identity + subscription)
//   GET  /api/admin/customers/export.csv?q=&plan=        CSV of the same fields
//   GET  /api/admin/customers/:id                        detail + payment history
//   POST /api/admin/customers/:id/reveal-phone           unmask phone (logged)
//   POST /api/admin/customers/:id/export  { reason }     that user's data export (JSON file)
//   POST /api/admin/customers/:id/delete  { confirm_id, reason }  delete on request
// Access + privacy rules: admin/auth.js, admin/customers.js, admin/metrics.js.
// EVERY call (views, searches, reveals, exports, deletes, denials, sign-ins)
// writes a security_logs row: actor_id = the admin, user_id = the customer.
// ------------------------------------------------------------

const express = require('express');
const db = require('../db');
const { validate, HttpError, asyncHandler } = require('../utils/http');
const { rateLimit, hit, peek, clear, tooMany, byIp } = require('../middleware/rateLimit');
const { logSecurity } = require('../services/securityLog');
const { checkCredentials, deleteAccount } = require('../services/account');
const { buildExport } = require('../services/exportData');
const adminAuth = require('../admin/auth');
const metrics = require('../admin/metrics');
const customers = require('../admin/customers');

const router = express.Router();

// Nothing from here may be cached or indexed
router.use((req, res, next) => {
  res.set('Cache-Control', 'no-store');
  res.set('X-Robots-Tag', 'noindex, nofollow, noarchive');
  next();
});

// ---------------- Sign-in ----------------
const loginIp = rateLimit({ name: 'admin_login_ip', windowMs: 15 * 60 * 1000, max: 10, key: byIp,
  message: 'Too many admin sign-in attempts. Please wait 15 minutes.' });
const verifyIp = rateLimit({ name: 'admin_verify_ip', windowMs: 15 * 60 * 1000, max: 10, key: byIp,
  message: 'Too many tries. Please wait 15 minutes.' });
const LOGIN_FAIL = { windowMs: 15 * 60 * 1000, max: 5 };

router.post('/login', loginIp, asyncHandler(async (req, res) => {
  const body = validate(req.body, {
    email: { type: 'string', required: true, maxLength: 120 },
    password: { type: 'string', required: true, maxLength: 100 },
  });
  const email = body.email.trim().toLowerCase();
  const locked = peek('admin_login_fail', email, LOGIN_FAIL);
  if (locked.limited) throw tooMany(locked.resetMs, 'Too many wrong tries for this account. Please wait 15 minutes.');
  const user = await checkCredentials(email, body.password); // always runs bcrypt
  if (!user || !adminAuth.isAdminEmail(user.email)) {
    hit('admin_login_fail', email, LOGIN_FAIL);
    await logSecurity('admin_login_failed', { req, actorId: user ? user.id : null, detail: { step: 1, reason: user ? 'not_admin' : 'bad_credentials' } });
    throw new HttpError(401, 'Wrong email or password, or this account has no admin access.');
  }
  clear('admin_login_fail', email);
  const ch = await adminAuth.startChallenge(user);
  await logSecurity('admin_second_step_sent', { req, actorId: user.id, detail: { step: ch.step } });
  res.json(ch);
}));

router.post('/verify', verifyIp, asyncHandler(async (req, res) => {
  const body = validate(req.body, {
    challenge: { type: 'string', required: true, maxLength: 100 },
    code: { type: 'string', required: true, maxLength: 100 },
  });
  let userId;
  try {
    userId = await adminAuth.finishChallenge(body.challenge, body.code);
  } catch (err) {
    await logSecurity('admin_login_failed', { req, detail: { step: 2 } });
    throw err;
  }
  const row = await db.get('SELECT id, email FROM users WHERE id = $1', [userId]);
  if (!row || !adminAuth.isAdminEmail(row.email)) throw new HttpError(403, 'This area is for the HeartPurse owner only.');
  await logSecurity('admin_login_success', { req, actorId: row.id });
  res.json({ token: adminAuth.signAdminToken(row.id), expires_in_min: Number(process.env.ADMIN_SESSION_MINUTES) || 30 });
}));

// ---------------- Everything below: admin token only ----------------
const denied = (req, userId) => { logSecurity('admin_denied', { req, actorId: Number.isInteger(userId) ? userId : null, detail: { path: req.path.slice(0, 80) } }); };
router.use(adminAuth.requireAdmin(denied));
router.use(rateLimit({ name: 'admin_api', windowMs: 60 * 1000, max: Number(process.env.ADMIN_RATE_LIMIT_PER_MIN) || 120, key: (req) => `a${req.admin.id}` }));

const audit = (req, event, extra = {}) => logSecurity(event, { req, actorId: req.admin.id, ...extra });

router.get('/session', asyncHandler(async (req, res) => {
  const row = await db.get('SELECT email FROM users WHERE id = $1', [req.admin.id]);
  res.json({ admin: { email: row.email }, min_group_size: metrics.MIN_GROUP });
}));

for (const section of ['growth', 'revenue', 'health', 'money', 'coach', 'app']) {
  router.get(`/${section}`, asyncHandler(async (req, res) => {
    const data = await metrics[section]();
    await audit(req, 'admin_view', { detail: { section } });
    res.json({ section, generated_at: new Date().toISOString(), ...data });
  }));
}

// ---------------- Customers ----------------
const listQuery = (req) => validate(req.query, {
  q: { type: 'string', maxLength: 100 },
  plan: { type: 'string', oneOf: Object.keys(customers.PLAN_FILTERS) },
  page: { type: 'integer', min: 1, max: 100000 },
  per_page: { type: 'integer', min: 5, max: 100 },
});

router.get('/customers', asyncHandler(async (req, res) => {
  const f = listQuery(req);
  const out = await customers.list({ q: f.q, plan: f.plan, page: f.page, perPage: f.per_page });
  const searched = Boolean((f.q || '').trim()) || Boolean(f.plan);
  await audit(req, searched ? 'admin_customer_search' : 'admin_customer_list', {
    detail: { q: f.q ? String(f.q).slice(0, 100) : null, plan: f.plan || null, page: out.page, results: out.total },
  });
  res.json(out);
}));

router.get('/customers/export.csv', asyncHandler(async (req, res) => {
  const f = listQuery(req);
  const rows = await customers.all({ q: f.q, plan: f.plan });
  await audit(req, 'admin_customer_csv', { detail: { q: f.q ? String(f.q).slice(0, 100) : null, plan: f.plan || null, rows: rows.length } });
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="heartpurse-customers-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send(customers.toCsv(rows));
}));

function customerId(req) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0 || id > 2147483647) throw new HttpError(400, 'Invalid customer id');
  return id;
}

router.get('/customers/:id', asyncHandler(async (req, res) => {
  const id = customerId(req);
  const c = await customers.detail(id);
  if (!c) throw new HttpError(404, 'Customer not found');
  await audit(req, 'admin_customer_view', { userId: id });
  res.json({ customer: c });
}));

router.post('/customers/:id/reveal-phone', asyncHandler(async (req, res) => {
  const id = customerId(req);
  const exists = await db.get('SELECT id FROM users WHERE id = $1', [id]);
  if (!exists) throw new HttpError(404, 'Customer not found');
  await audit(req, 'admin_phone_reveal', { userId: id });
  // The app does not collect phone numbers today.
  res.json({ id, phone: null, status: customers.NOT_COLLECTED });
}));

router.post('/customers/:id/export', asyncHandler(async (req, res) => {
  const id = customerId(req);
  const { reason } = validate(req.body, { reason: { type: 'string', required: true, maxLength: 200 } });
  if (reason.trim().length < 3) throw new HttpError(400, 'Please give the reason (e.g. the support ticket).');
  const exists = await db.get('SELECT id FROM users WHERE id = $1', [id]);
  if (!exists) throw new HttpError(404, 'Customer not found');
  const data = await buildExport(id);
  await audit(req, 'admin_user_export', { userId: id, detail: { reason: reason.trim() } });
  res.set('Content-Disposition', `attachment; filename="heartpurse-export-${id}.json"`);
  res.json({ exported_by: 'HeartPurse support (on the user\'s request)', ...data });
}));

router.post('/customers/:id/delete', asyncHandler(async (req, res) => {
  const id = customerId(req);
  const b = validate(req.body, {
    confirm_id: { type: 'integer', required: true },
    reason: { type: 'string', required: true, maxLength: 200 },
  });
  if (b.confirm_id !== id) throw new HttpError(400, 'Type the customer id to confirm.');
  if (b.reason.trim().length < 3) throw new HttpError(400, 'Please give the reason (e.g. the deletion request reference).');
  const row = await db.get('SELECT id, email FROM users WHERE id = $1', [id]);
  if (!row) throw new HttpError(404, 'Customer not found');
  if (adminAuth.isAdminEmail(row.email)) throw new HttpError(409, 'An admin account cannot be deleted from the dashboard.');
  await audit(req, 'admin_user_delete', { userId: id, detail: { reason: b.reason.trim() } });
  await deleteAccount(id, { req });
  res.json({ deleted: true, id });
}));

module.exports = router;
