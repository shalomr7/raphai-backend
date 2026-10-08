// routes/deleteAccount.js
// ------------------------------------------------------------
// Public "delete your account without the app" page (Google Play's
// account-deletion rule; Privacy Policy section 11).
//   GET  /delete-account  -> explains what is deleted and what is kept, plus a form
//   POST /delete-account  -> email + password; deletes the account with the SAME
//                            code as the in-app DELETE /api/auth/me
//                            (services/account.js)
// Safety:
//   - POST only for deleting (GET never changes anything)
//   - max 5 attempts per IP address per hour (simple in-memory limit)
//   - one generic error message, so the page never says whether an email exists
//   - no CSRF token: the form itself carries the credentials
// ------------------------------------------------------------

const express = require('express');
const { asyncHandler } = require('../utils/http');
const { page, escapeHtml } = require('../utils/htmlPage');
const { deleteAccount, checkCredentials } = require('../services/account');

const router = express.Router();

const PLAY_SUBSCRIPTIONS_URL = 'https://play.google.com/store/account/subscriptions';
const GENERIC_ERROR = 'We could not delete an account with those details. Check your email and password and try again.';

// ---------- rate limit: 5 POSTs per IP per hour (in memory) ----------
const WINDOW_MS = 60 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const attempts = new Map(); // ip -> [timestamps]
function rateLimited(ip) {
  const now = Date.now();
  const recent = (attempts.get(ip) || []).filter((t) => now - t < WINDOW_MS);
  if (recent.length >= MAX_ATTEMPTS) { attempts.set(ip, recent); return true; }
  recent.push(now);
  attempts.set(ip, recent);
  // Throw away old entries now and then so memory stays small
  if (attempts.size > 10000) {
    for (const [k, v] of attempts) if (!v.some((t) => now - t < WINDOW_MS)) attempts.delete(k);
  }
  return false;
}
function resetRateLimit() { attempts.clear(); } // for tests

// ---------- the page ----------
function body({ message = null, kind = null, email = '' } = {}) {
  const msg = message ? `<p class="${kind}" role="alert">${escapeHtml(message)}</p>` : '';
  if (kind === 'success') {
    return `<h1>Delete your RaphAi account</h1>
${msg}
<p class="notice"><strong>Remember:</strong> deleting your account does <strong>not</strong> cancel a Google Play subscription.
If you had one, cancel it at <a href="${PLAY_SUBSCRIPTIONS_URL}">${PLAY_SUBSCRIPTIONS_URL}</a>.</p>
<p>You can now uninstall the app. Thank you for using RaphAi.</p>`;
  }
  return `<h1>Delete your RaphAi account</h1>
<p>Use this page to delete your RaphAi account and its data if you no longer have the app.
If you still have the app, you can also do it there: <strong>You &rarr; Privacy Centre &rarr; Delete account</strong>.</p>

<p class="notice"><strong>Google Play subscriptions are not cancelled automatically.</strong>
Deleting your account does not cancel a Google Play subscription, and uninstalling the app does not either.
Cancel it first at <a href="${PLAY_SUBSCRIPTIONS_URL}">${PLAY_SUBSCRIPTIONS_URL}</a>
(Google Play &rarr; Profile &rarr; Payments &amp; subscriptions &rarr; Subscriptions).</p>

<h2>What gets deleted</h2>
<p>Straight away, from our live database:</p>
<ul>
  <li>Your account: name, email and password hash.</li>
  <li>Your profile: sex, age, height, weight, measurements, goals and monthly income.</li>
  <li>Your health and wellness logs: food, water, sleep, mood and notes, weight, workouts and steps.</li>
  <li>Activity and sleep synced from Health Connect or the phone pedometer.</li>
  <li>Your money data: expenses, budgets, savings goals, bills and bill payments.</li>
  <li>Your insights (RaphScore history), reminder settings, favourites, plan details and daily feature-use counts (including the Coach's daily question count).</li>
</ul>

<h2>What we keep, and for how long</h2>
<ul>
  <li><strong>Security logs</strong> (IP address, time and type of event, such as sign-ins and this deletion): kept in our Mumbai (India) database for <strong>1 year</strong>, then deleted.</li>
  <li><strong>Consent records</strong> (what you agreed to, which version, when): kept for <strong>1 year</strong> after deletion to prove consent, then deleted.</li>
  <li><strong>Google Play purchase records</strong> (purchase token, plan, status, expiry, order ID): kept for <strong>8 years</strong> because tax law requires it. They are no longer linked to your account.</li>
  <li><strong>Custom foods</strong> you added to the shared food library stay in the library, without your name.</li>
  <li><strong>Backups:</strong> backups are kept for up to 7 days where our database plan provides them, then roll off.</li>
</ul>
<p>Data kept only on your phone (such as bill splits) is removed when you uninstall the app.
See our <a href="/privacy">Privacy Policy</a> for full details.</p>

<h2>Delete my account</h2>
${msg}
<form method="post" action="/delete-account" autocomplete="on">
  <label for="email">Email</label>
  <input id="email" name="email" type="email" required maxlength="120" autocomplete="email" value="${escapeHtml(email)}">
  <label for="password">Password</label>
  <input id="password" name="password" type="password" required maxlength="100" autocomplete="current-password">
  <label><input type="checkbox" name="confirm" value="yes" required>I understand this permanently deletes my account and data.</label>
  <button type="submit">Permanently delete my account</button>
</form>
<p>Forgot your password, or can't sign in? Email [SUPPORT EMAIL] from your registered email with the subject
"Delete my RaphAi account". We will check it is you and then delete it.</p>`;
}

function send(res, status, opts) {
  res.status(status)
    .type('html')
    .set({
      'Cache-Control': 'no-store',
      'X-Frame-Options': 'DENY', // nobody can put this form inside their own page
      'Content-Security-Policy': "frame-ancestors 'none'; form-action 'self'",
      'Referrer-Policy': 'no-referrer',
    })
    .send(page('Delete your RaphAi account', body(opts)));
}

router.get('/delete-account', (req, res) => send(res, 200));

router.post('/delete-account', express.urlencoded({ extended: false, limit: '10kb' }), asyncHandler(async (req, res) => {
  if (rateLimited(req.ip || 'unknown')) {
    res.set('Retry-After', '3600');
    return send(res, 429, { kind: 'error', message: 'Too many attempts. Please wait an hour and try again.' });
  }
  const b = req.body || {};
  const email = typeof b.email === 'string' ? b.email.slice(0, 120) : '';
  const password = typeof b.password === 'string' ? b.password.slice(0, 100) : '';
  if (!email || !password) return send(res, 400, { kind: 'error', message: GENERIC_ERROR, email });

  const user = await checkCredentials(email, password);
  if (!user) return send(res, 401, { kind: 'error', message: GENERIC_ERROR, email });

  await deleteAccount(user.id, { req });
  return send(res, 200, { kind: 'success', message: 'Your RaphAi account and its data have been deleted.' });
}));

module.exports = { router, resetRateLimit, MAX_ATTEMPTS };
