// routes/googlePlay.js
// ------------------------------------------------------------
// Google Play Billing (subscriptions).
//
//   POST /api/subscription/google/verify   (login needed)
//        The app sends { purchaseToken, productId, basePlanId } right after
//        (productId: raphai_plus | raphai_pro | raphai_elite;
//         basePlanId: monthly | quarterly | yearly | monthly-prepaid)
//        a purchase (or on "Restore purchases"). We ask Google whether it is
//        real, save it, and switch the plan on. The app must only
//        acknowledge/finish the purchase when we answer { valid: true }.
//
//   POST /api/subscription/google/rtdn?secret=...   (public; Google calls it)
//        Real-time Developer Notifications, sent by Google Cloud Pub/Sub
//        ("push" subscription). Renewals, cancellations, expiries, refunds,
//        revocations... For EVERY message we ask Google again for the
//        latest state (we never trust the message alone).
//
// Settings:
//   GOOGLE_PLAY_SERVICE_ACCOUNT_JSON   service-account key (raw JSON or base64)
//   GOOGLE_PLAY_PACKAGE_NAME           com.raphai.app
//   GOOGLE_RTDN_SECRET                 long random text; must match ?secret= in the push URL
//   GOOGLE_RTDN_AUDIENCE               optional: turn on Pub/Sub JWT checking (the
//                                      "audience" you set on the push subscription)
//   GOOGLE_RTDN_SERVICE_ACCOUNT_EMAIL  optional: the service account Pub/Sub signs as
// ------------------------------------------------------------

const express = require('express');
const crypto = require('crypto');
const { OAuth2Client } = require('google-auth-library');
const db = require('../db');
const play = require('../services/googlePlay');
const { GOOGLE_PRODUCTS, GOOGLE_BASE_PLANS } = require('../utils/plans');
const { validate, asyncHandler, HttpError } = require('../utils/http');

// Shared with routes/subscription.js (set there to avoid a require loop)
let subscriptionStatus = null;
function setStatusFn(fn) { subscriptionStatus = fn; }

// Turn an error from the Google call into a clean HTTP error for the app
function googleError(e) {
  if (e instanceof HttpError) return e;
  const s = Number(e.googleStatus) || 0;
  if (s === 400 || s === 404 || s === 410) return new HttpError(400, 'Google Play says this purchase token is not valid.');
  if (s === 401 || s === 403) {
    console.error('Google Play API permission problem:', e.message);
    return new HttpError(503, 'Google Play billing is not configured correctly (the service account has no access to this app yet).');
  }
  console.error('Google Play API error:', e.message);
  return new HttpError(502, 'Could not reach Google Play to check the purchase. Please try again.');
}

// ------------------------------------------------------------
// POST /verify  (mounted behind requireAuth)
// ------------------------------------------------------------
const googleSubRouter = express.Router();

googleSubRouter.post('/verify', asyncHandler(async (req, res) => {
  play.assertConfigured(); // 503 "billing not configured" if env vars are missing

  const b = validate(req.body, {
    purchaseToken: { type: 'string', required: true, maxLength: 4096 },
    productId: { type: 'string', required: true, oneOf: Object.keys(GOOGLE_PRODUCTS) },
    basePlanId: { type: 'string', oneOf: Object.keys(GOOGLE_BASE_PLANS) },
  });
  const userId = req.user.id;

  // Quick check before calling Google: is this token someone else's?
  const existing = await db.get('SELECT user_id FROM google_play_purchases WHERE purchase_token = $1', [b.purchaseToken]);
  if (existing && existing.user_id && Number(existing.user_id) !== Number(userId)) {
    throw new HttpError(409, 'This Google Play purchase is already linked to another HeartPurse account.');
  }

  let raw;
  try {
    raw = await play.fetchSubscription(b.purchaseToken);
  } catch (e) {
    throw googleError(e);
  }

  const m = play.mapSubscription(raw, b.productId);
  if (!m || m.productId !== b.productId) {
    throw new HttpError(400, 'This purchase is not for the product the app said.');
  }
  if (b.basePlanId && m.basePlanId && b.basePlanId !== m.basePlanId) {
    // Not fatal (e.g. the user switched plan in the Play Store); Google is the truth.
    console.warn(`Google Play verify: app said base plan ${b.basePlanId}, Google says ${m.basePlanId}`);
  }
  // The app passes a hashed account id when buying. If Google returns one,
  // it must be THIS user's (stops one person's purchase unlocking another account).
  if (m.accountId && m.accountId !== play.playAccountId(userId)) {
    throw new HttpError(409, 'This Google Play purchase was made from a different HeartPurse account.');
  }

  await play.storeAndRecompute(b.purchaseToken, m, raw, userId);
  // A token that was refunded/revoked never gives access again
  const rev = await db.get('SELECT revoked_at FROM google_play_purchases WHERE purchase_token = $1', [b.purchaseToken]);
  if (rev && rev.revoked_at) m.entitled = false;

  const pending = m.state === 'SUBSCRIPTION_STATE_PENDING';
  res.json({
    valid: m.entitled,
    pending,
    reason: m.entitled ? null : (pending ? 'payment_pending' : 'not_active'),
    google: {
      product_id: m.productId,
      base_plan_id: m.basePlanId,
      offer_id: m.offerId,
      plan: m.plan,
      period: m.period,
      state: m.state,
      expires_at: m.expiresAt,
      auto_renew: m.autoRenew,
      prepaid: m.prepaid,
      in_trial: m.inTrial,
      acknowledged: m.acknowledged,
      test_purchase: m.testPurchase,
    },
    subscription: await subscriptionStatus(userId),
  });
}));

// ------------------------------------------------------------
// POST /rtdn  (public; Google Cloud Pub/Sub push)
// ------------------------------------------------------------
const googleRtdnRouter = express.Router();

// Names of the subscription notification types (for the logs)
const NOTIFICATION_TYPES = {
  1: 'RECOVERED', 2: 'RENEWED', 3: 'CANCELED', 4: 'PURCHASED', 5: 'ON_HOLD',
  6: 'IN_GRACE_PERIOD', 7: 'RESTARTED', 8: 'PRICE_CHANGE_CONFIRMED', 9: 'DEFERRED',
  10: 'PAUSED', 11: 'PAUSE_SCHEDULE_CHANGED', 12: 'REVOKED', 13: 'EXPIRED',
  17: 'ITEMS_CHANGED', 18: 'CANCELLATION_SCHEDULED', 19: 'PRICE_CHANGE_UPDATED',
  20: 'PENDING_PURCHASE_CANCELED', 22: 'PRICE_STEP_UP_CONSENT_UPDATED',
};
const REVOKED = 12;

function safeEqual(a, b) {
  const x = Buffer.from(String(a || '')); const y = Buffer.from(String(b || ''));
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}

const oauthClient = new OAuth2Client();

// Optional second check: the signed JWT that Pub/Sub adds when the push
// subscription has "Enable authentication" turned on.
async function checkPubSubJwt(req) {
  const audience = process.env.GOOGLE_RTDN_AUDIENCE;
  if (!audience) return; // not turned on
  const [kind, token] = (req.headers.authorization || '').split(' ');
  if (kind !== 'Bearer' || !token) throw new HttpError(401, 'Missing Pub/Sub token');
  let payload;
  try {
    const ticket = await oauthClient.verifyIdToken({ idToken: token, audience });
    payload = ticket.getPayload();
  } catch {
    throw new HttpError(401, 'Invalid Pub/Sub token');
  }
  const email = process.env.GOOGLE_RTDN_SERVICE_ACCOUNT_EMAIL;
  if (email && (payload.email !== email || payload.email_verified !== true)) {
    throw new HttpError(401, 'Pub/Sub token is from the wrong service account');
  }
}

// Exposed for tests
let jwtChecker = checkPubSubJwt;
function setRtdnJwtChecker(fn) { jwtChecker = fn || checkPubSubJwt; }

googleRtdnRouter.post('/', asyncHandler(async (req, res) => {
  const secret = process.env.GOOGLE_RTDN_SECRET;
  if (!secret) throw new HttpError(503, 'GOOGLE_RTDN_SECRET is not set');
  if (!safeEqual(req.query.secret, secret)) throw new HttpError(401, 'Bad secret');
  await jwtChecker(req);
  play.assertConfigured();

  // Pub/Sub push body: { message: { data: "<base64 JSON>", messageId, ... }, subscription }
  let note;
  try {
    const data = req.body && req.body.message && req.body.message.data;
    note = JSON.parse(Buffer.from(String(data || ''), 'base64').toString('utf8'));
  } catch {
    // Broken message: answer 200 so Pub/Sub does not retry it forever
    return res.json({ ok: true, ignored: 'bad message' });
  }

  if (note.packageName && note.packageName !== play.packageName()) {
    return res.json({ ok: true, ignored: 'other package' });
  }
  if (note.testNotification) {
    console.log('Google Play RTDN: test notification received');
    return res.json({ ok: true, test: true });
  }

  let token = null; let type = null;
  if (note.subscriptionNotification) {
    token = note.subscriptionNotification.purchaseToken;
    type = Number(note.subscriptionNotification.notificationType);
  } else if (note.voidedPurchaseNotification && Number(note.voidedPurchaseNotification.productType) === 1) {
    // 1 = subscription refunded / charged back
    token = note.voidedPurchaseNotification.purchaseToken;
    type = REVOKED;
  }
  if (!token) return res.json({ ok: true, ignored: 'not a subscription notification' });

  let raw;
  try {
    raw = await play.fetchSubscription(token);
  } catch (e) {
    const s = Number(e.googleStatus) || 0;
    if (s === 400 || s === 404 || s === 410) return res.json({ ok: true, ignored: 'token no longer valid' });
    console.error('Google Play RTDN: could not fetch state, Pub/Sub will retry:', e.message);
    throw new HttpError(500, 'Could not fetch subscription state'); // non-2xx -> Pub/Sub retries
  }
  let m = play.mapSubscription(raw);
  if (!m) return res.json({ ok: true, ignored: 'not our product' });

  // Revoked or refunded: access ends now, whatever the expiry said.
  if (type === REVOKED && m.entitled) {
    const nowIso = new Date().toISOString();
    m = { ...m, state: 'SUBSCRIPTION_STATE_EXPIRED', expiresAt: nowIso, autoRenew: false, entitled: false };
  }

  await play.storeAndRecompute(token, m, raw, null, { revoke: type === REVOKED });
  console.log(`Google Play RTDN: ${NOTIFICATION_TYPES[type] || type} -> ${m.state} (${m.productId}/${m.basePlanId})`);
  res.json({ ok: true, type: NOTIFICATION_TYPES[type] || type, state: m.state });
}));

module.exports = { googleSubRouter, googleRtdnRouter, setStatusFn, setRtdnJwtChecker };
