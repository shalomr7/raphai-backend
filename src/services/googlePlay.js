// services/googlePlay.js
// ------------------------------------------------------------
// Google Play Billing (subscriptions) on the server.
//
// What it does:
//  1. Reads the settings:
//       GOOGLE_PLAY_SERVICE_ACCOUNT_JSON  the service-account key file
//                                         (paste the raw JSON, or the JSON as base64)
//       GOOGLE_PLAY_PACKAGE_NAME          com.raphai.app
//  2. Asks Google for the TRUE state of a purchase:
//       GET androidpublisher v3 purchases.subscriptionsv2.get
//     (we never trust what the phone says; we always ask Google)
//  3. Turns Google's answer into our words: plan, period, expiry,
//     auto-renew, free trial.
//  4. Saves it in the table google_play_purchases and updates the
//     user's row in "subscriptions" (that row is what requirePlan reads).
//
// The tests replace the Google call with a fake (setPlayApiFetcher), so
// they run without internet or a real Play Console.
// ------------------------------------------------------------

const crypto = require('crypto');
const { GoogleAuth } = require('google-auth-library');
const db = require('../db');
const { PLANS, GOOGLE_PRODUCTS, GOOGLE_BASE_PLANS, BASE_PLANS } = require('../utils/plans');
const { HttpError } = require('../utils/http');

const SCOPE = 'https://www.googleapis.com/auth/androidpublisher';

// States where the user should have the paid features.
//  ACTIVE           paid and renewing (or in a free trial)
//  CANCELED         user turned off renewal, but the paid time is not over yet
//  IN_GRACE_PERIOD  renewal payment failed, Google is retrying; keep access
// Everything else (PENDING, ON_HOLD, PAUSED, EXPIRED, PENDING_PURCHASE_CANCELED)
// means no access.
const ENTITLED_STATES = new Set([
  'SUBSCRIPTION_STATE_ACTIVE',
  'SUBSCRIPTION_STATE_CANCELED',
  'SUBSCRIPTION_STATE_IN_GRACE_PERIOD',
]);

// ------------------------------------------------------------
// Settings
// ------------------------------------------------------------

// Read the service-account JSON (raw JSON or base64). Returns null if not set.
function readServiceAccount() {
  const raw = (process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON || '').trim();
  if (!raw) return null;
  let text = raw;
  if (!raw.startsWith('{')) {
    try { text = Buffer.from(raw, 'base64').toString('utf8'); } catch { text = ''; }
  }
  try {
    const json = JSON.parse(text);
    if (!json.client_email || !json.private_key) throw new Error('missing client_email / private_key');
    return json;
  } catch (e) {
    const err = new Error(`GOOGLE_PLAY_SERVICE_ACCOUNT_JSON is not a valid service-account key (${e.message})`);
    err.badConfig = true;
    throw err;
  }
}

function packageName() {
  return (process.env.GOOGLE_PLAY_PACKAGE_NAME || '').trim();
}

// true when both settings are present (the JSON is checked when used)
function isConfigured() {
  return Boolean(packageName() && (process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON || '').trim());
}

// Throws the 503 "billing not configured" error if settings are missing/bad
function assertConfigured() {
  if (!isConfigured()) {
    throw new HttpError(503, 'Google Play billing is not configured on the server yet (set GOOGLE_PLAY_SERVICE_ACCOUNT_JSON and GOOGLE_PLAY_PACKAGE_NAME).');
  }
  try {
    readServiceAccount();
  } catch (e) {
    throw new HttpError(503, `Google Play billing is not configured correctly: ${e.message}`);
  }
}

// ------------------------------------------------------------
// The call to Google
// ------------------------------------------------------------

let authClientPromise = null;
let authKey = null;

async function getAuthClient() {
  const key = process.env.GOOGLE_PLAY_SERVICE_ACCOUNT_JSON;
  if (!authClientPromise || authKey !== key) {
    authKey = key;
    const credentials = readServiceAccount();
    const auth = new GoogleAuth({ credentials, scopes: [SCOPE] });
    authClientPromise = auth.getClient();
  }
  return authClientPromise;
}

// Real fetcher: purchases.subscriptionsv2.get
// Returns Google's SubscriptionPurchaseV2 JSON.
// Throws an Error with .googleStatus (HTTP code from Google) on failure.
async function realFetcher(purchaseToken) {
  const client = await getAuthClient();
  const url = `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${encodeURIComponent(packageName())}`
    + `/purchases/subscriptionsv2/tokens/${encodeURIComponent(purchaseToken)}`;
  try {
    const res = await client.request({ url, method: 'GET', retry: true });
    return res.data;
  } catch (e) {
    const err = new Error(`Google Play API error: ${e.message}`);
    err.googleStatus = (e.response && e.response.status) || e.status || e.code || 0;
    throw err;
  }
}

let fetcher = realFetcher;

// Tests use this to replace Google with a fake. Pass null to go back to real.
function setPlayApiFetcher(fn) {
  fetcher = fn || realFetcher;
}

async function fetchSubscription(purchaseToken) {
  return fetcher(purchaseToken);
}

// ------------------------------------------------------------
// Turn Google's answer into our own words
// ------------------------------------------------------------

// The id we give Google when the user buys (obfuscatedAccountId).
// Google gives it back to us, so we can check the purchase was made
// from THIS account. It is a hash, so it does not reveal the user id.
function playAccountId(userId) {
  const secret = process.env.JWT_SECRET || 'raphai';
  return crypto.createHmac('sha256', secret).update(`raphai-user:${userId}`).digest('hex').slice(0, 64);
}

// Pick the line item for one of our products (a purchase normally has one)
function pickLineItem(sub, preferredProductId) {
  const items = Array.isArray(sub && sub.lineItems) ? sub.lineItems : [];
  const ours = items.filter((li) => GOOGLE_PRODUCTS[li.productId]);
  if (!ours.length) return null;
  if (preferredProductId) {
    const exact = ours.find((li) => li.productId === preferredProductId);
    if (exact) return exact;
  }
  // otherwise the highest plan, then the latest expiry
  return ours.sort((a, b) => {
    const r = PLANS[GOOGLE_PRODUCTS[b.productId]].rank - PLANS[GOOGLE_PRODUCTS[a.productId]].rank;
    if (r) return r;
    return new Date(b.expiryTime || 0) - new Date(a.expiryTime || 0);
  })[0];
}

/**
 * mapSubscription(sub, productId?) -> plain object we store and return:
 *   { productId, basePlanId, offerId, plan, period, state, expiresAt,
 *     autoRenew, inTrial, acknowledged, linkedPurchaseToken, orderId,
 *     testPurchase, accountId, prepaid, entitled }
 *
 * Base plans: monthly, quarterly, yearly (auto-renewing) and
 * monthly-prepaid (PREPAID: paid once, never renews). A prepaid line item
 * has "prepaidPlan" instead of "autoRenewingPlan"; access simply ends at
 * the line item's expiryTime (we read it the same way for every plan).
 * An unknown base plan id (e.g. a future or legacy one) still gives access
 * to the product's plan; only its period is unknown (null).
 */
function mapSubscription(sub, preferredProductId) {
  const li = pickLineItem(sub, preferredProductId);
  if (!li) return null;
  const basePlanId = (li.offerDetails && li.offerDetails.basePlanId) || null;
  const offerId = (li.offerDetails && li.offerDetails.offerId) || null;
  const period = GOOGLE_BASE_PLANS[basePlanId] || null;
  const state = sub.subscriptionState || 'SUBSCRIPTION_STATE_UNSPECIFIED';
  const expiresAt = li.expiryTime ? new Date(li.expiryTime).toISOString() : null;
  const notExpired = Boolean(expiresAt && new Date(expiresAt) > new Date());
  const inTrial = Boolean(li.offerPhase && li.offerPhase.freeTrial)
    || (li.offerPhase && li.offerPhase.prorationPeriod && li.offerPhase.prorationPeriod.originalOfferPhaseType === 'FREE_TRIAL') || false;
  return {
    productId: li.productId,
    basePlanId,
    offerId,
    plan: GOOGLE_PRODUCTS[li.productId],
    period,
    state,
    expiresAt,
    autoRenew: Boolean(li.autoRenewingPlan && li.autoRenewingPlan.autoRenewEnabled),
    prepaid: Boolean(li.prepaidPlan) || (BASE_PLANS[basePlanId] ? !BASE_PLANS[basePlanId].auto_renew : false),
    inTrial: Boolean(inTrial),
    acknowledged: sub.acknowledgementState === 'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED',
    linkedPurchaseToken: sub.linkedPurchaseToken || null,
    orderId: li.latestSuccessfulOrderId || sub.latestOrderId || null,
    testPurchase: Boolean(sub.testPurchase),
    accountId: (sub.externalAccountIdentifiers && sub.externalAccountIdentifiers.obfuscatedExternalAccountId) || null,
    entitled: ENTITLED_STATES.has(state) && notExpired,
  };
}

// ------------------------------------------------------------
// Saving
// ------------------------------------------------------------

// Save (insert or update) one purchase token. "userId" may be null (an
// RTDN for a token the app has not sent us yet). An existing link to a
// user is never changed here (see linkTokenToUser for the checks).
async function savePurchase(q, purchaseToken, m, raw, userId) {
  await q.run(`
    INSERT INTO google_play_purchases
      (purchase_token, user_id, product_id, base_plan_id, offer_id, plan, period, subscription_state,
       expires_at, auto_renew, in_trial, acknowledged, linked_purchase_token, latest_order_id, test_purchase, raw, updated_at)
    VALUES (@token, @userId, @productId, @basePlanId, @offerId, @plan, @period, @state,
       @expiresAt, @autoRenew, @inTrial, @ack, @linked, @orderId, @test, @raw, now())
    ON CONFLICT (purchase_token) DO UPDATE SET
      user_id = COALESCE(google_play_purchases.user_id, excluded.user_id),
      product_id = excluded.product_id, base_plan_id = excluded.base_plan_id, offer_id = excluded.offer_id,
      plan = excluded.plan, period = excluded.period, subscription_state = excluded.subscription_state,
      expires_at = excluded.expires_at, auto_renew = excluded.auto_renew, in_trial = excluded.in_trial,
      acknowledged = excluded.acknowledged, linked_purchase_token = excluded.linked_purchase_token,
      latest_order_id = excluded.latest_order_id, test_purchase = excluded.test_purchase,
      raw = excluded.raw, updated_at = now()`,
  {
    token: purchaseToken,
    userId: userId || null,
    productId: m.productId,
    basePlanId: m.basePlanId,
    offerId: m.offerId,
    plan: m.plan,
    period: m.period,
    state: m.state,
    expiresAt: m.expiresAt,
    autoRenew: m.autoRenew ? 1 : 0,
    inTrial: m.inTrial ? 1 : 0,
    ack: m.acknowledged ? 1 : 0,
    linked: m.linkedPurchaseToken,
    orderId: m.orderId,
    test: m.testPurchase ? 1 : 0,
    raw: JSON.stringify(raw || {}),
  });

  // An upgrade/downgrade/re-subscribe makes a NEW token and Google tells us
  // the old one in linkedPurchaseToken. The old one no longer gives access.
  if (m.linkedPurchaseToken && m.linkedPurchaseToken !== purchaseToken) {
    const old = await q.get('SELECT user_id FROM google_play_purchases WHERE purchase_token = $1', [m.linkedPurchaseToken]);
    await q.run(`UPDATE google_play_purchases SET superseded_by = $1, updated_at = now()
      WHERE purchase_token = $2`, [purchaseToken, m.linkedPurchaseToken]);
    return old && old.user_id ? old.user_id : null; // that user's plan must be recalculated too
  }
  return null;
}

/**
 * recomputeEntitlement(userId, q): look at all of the user's Google Play
 * purchases and write the result into "subscriptions" (the row that
 * requirePlan and GET /api/subscription read).
 */
async function recomputeEntitlement(userId, q = db) {
  if (!userId) return;
  const rows = await q.all(`
    SELECT * FROM google_play_purchases
    WHERE user_id = $1 AND superseded_by IS NULL AND revoked_at IS NULL
      AND subscription_state = ANY($2) AND expires_at IS NOT NULL`,
  [userId, [...ENTITLED_STATES]]);
  const now = new Date();
  const live = rows.filter((r) => new Date(r.expires_at) > now)
    .sort((a, b) => (PLANS[b.plan].rank - PLANS[a.plan].rank) || (new Date(b.expires_at) - new Date(a.expires_at)));
  const best = live[0];
  const sub = await q.get('SELECT * FROM subscriptions WHERE user_id = $1', [userId]);

  if (best) {
    await q.run(`
      INSERT INTO subscriptions (user_id, plan, period, status, expires_at, source, auto_renew, google_purchase_token, trial_used)
      VALUES ($1, $2, $3, 'active', $4, 'google_play', $5, $6, $7)
      ON CONFLICT (user_id) DO UPDATE SET plan = excluded.plan, period = excluded.period, status = 'active',
        expires_at = excluded.expires_at, source = 'google_play', auto_renew = excluded.auto_renew,
        google_purchase_token = excluded.google_purchase_token,
        trial_used = GREATEST(subscriptions.trial_used, excluded.trial_used)`,
    [userId, best.plan, best.in_trial ? 'trial' : best.period, new Date(best.expires_at).toISOString(),
      best.auto_renew, best.purchase_token, best.in_trial ? 1 : 0]);
    return;
  }

  // No live Google subscription. If the current plan came from Google, it ends now.
  if (sub && sub.source === 'google_play') {
    // Keep the last known expiry so the app can say "expired on ..."
    const lastRow = await q.get(`SELECT expires_at FROM google_play_purchases WHERE purchase_token = $1`, [sub.google_purchase_token]);
    // source becomes 'google_play_ended' so we stop re-checking with Google
    // on every request (a later renewal still arrives by RTDN or "Restore").
    await q.run(`UPDATE subscriptions SET plan = 'free', period = NULL, status = 'expired', auto_renew = 0,
      source = 'google_play_ended', expires_at = $2 WHERE user_id = $1`,
    [userId, lastRow && lastRow.expires_at ? new Date(lastRow.expires_at).toISOString() : null]);
  }
}

/**
 * storeAndRecompute(purchaseToken, mapped, raw, userId):
 *  save Google's answer and recalculate the plan of every user it touches,
 *  all in ONE transaction. If userId is given and the token already belongs
 *  to a DIFFERENT user, nothing is saved and a 409 error is thrown
 *  (one purchase can only ever unlock one HeartPurse account).
 *  revoke: true marks the token as refunded/revoked for good.
 */
async function storeAndRecompute(purchaseToken, mapped, raw, userId = null, { revoke = false } = {}) {
  await db.tx(async (t) => {
    // Only one update per token at a time (verify + RTDN can arrive together)
    await t.query('SELECT pg_advisory_xact_lock(hashtext($1))', [purchaseToken]);
    const existing = await t.get('SELECT user_id FROM google_play_purchases WHERE purchase_token = $1', [purchaseToken]);
    if (userId && existing && existing.user_id && Number(existing.user_id) !== Number(userId)) {
      throw new HttpError(409, 'This Google Play purchase is already linked to another HeartPurse account.');
    }
    const affected = await savePurchase(t, purchaseToken, mapped, raw, userId);
    if (revoke) {
      await t.run('UPDATE google_play_purchases SET revoked_at = COALESCE(revoked_at, now()) WHERE purchase_token = $1', [purchaseToken]);
    }
    const row = await t.get('SELECT user_id FROM google_play_purchases WHERE purchase_token = $1', [purchaseToken]);
    if (row && row.user_id) await recomputeEntitlement(row.user_id, t);
    if (affected && (!row || Number(affected) !== Number(row.user_id))) await recomputeEntitlement(affected, t);
  });
}

/**
 * refreshToken(purchaseToken): ask Google for the latest state, save it,
 * and recalculate plans (used by RTDN and the "expired?" re-check).
 * Returns the mapped state, or null if the token is not one of our products.
 */
async function refreshToken(purchaseToken) {
  const raw = await fetchSubscription(purchaseToken);
  const mapped = mapSubscription(raw);
  if (!mapped) return null;
  await storeAndRecompute(purchaseToken, mapped, raw, null);
  return mapped;
}

module.exports = {
  ENTITLED_STATES,
  isConfigured,
  assertConfigured,
  fetchSubscription,
  setPlayApiFetcher,
  mapSubscription,
  savePurchase,
  recomputeEntitlement,
  storeAndRecompute,
  refreshToken,
  playAccountId,
  packageName,
};
