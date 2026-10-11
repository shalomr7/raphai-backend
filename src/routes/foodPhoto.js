// routes/foodPhoto.js
// ------------------------------------------------------------
// Food photo AI nutrition (stage 2). Mounted at /api/food/photo behind
// requireAuth, BEFORE the app-wide 100 kb JSON parser, so only this route
// accepts large bodies.
//
// POST /api/food/photo/analyze      header Idempotency-Key (required)
//   body: JSON { image_base64, mime_type }  (max ~6 MB of JSON)
//      or raw bytes with Content-Type image/jpeg | image/png | image/webp (max 4.5 MB)
//   200 { job_id, items[{ name, est_grams, kcal, protein_g, carbs_g, fat_g, confidence }],
//         totals, confidence, low_confidence, is_food, estimate: true, model, usage }
//   Same Idempotency-Key again -> the same job/result (no new AI call, no quota).
//   Errors (JSON { error, code }):
//     503 food_photo_unavailable  no GEMINI_API_KEY, FOOD_PHOTO_ENABLED=false,
//                                 app_config food_photo_enabled=false, or not
//                                 rolled out to this account yet (ADMIN_EMAILS only
//                                 until app_config food_photo_public=true)
//     400 idempotency_key_required | image_* (type, magic bytes, unreadable)
//     413 image_too_large
//     403 ai_consent_required     the user has not agreed to Gemini processing
//     409 food_photo_in_progress  same key still running
//     402 food_photo_not_in_plan  plan quota is 0 (upgrade_to says which plan)
//     429 food_photo_quota_reached | ai_budget_reached (global monthly cap)
//     504 food_photo_timeout      20 s deadline passed (no result is invented)
//     502 food_photo_failed       AI error or malformed reply
//   A failed/timed-out/blocked call gives the day's quota unit back.
//
// POST /api/food/photo/confirm  { job_id, items[], meal, date? }
//   Saves the (edited) items as food log entries: food_id NULL, custom_*,
//   is_estimate = true, source = 'photo'. Idempotent per job: a second
//   confirm returns the same entries (200, replay: true). Only the job's
//   owner can confirm it (others get 404).
//
// The photo is never stored: only the JSON result is kept in food_photo_jobs.
// ------------------------------------------------------------

const express = require('express');
const db = require('../db');
const { HttpError, asyncHandler, validate } = require('../utils/http');
const { today } = require('../utils/dates');
const { currentPlan, upgradeError } = require('../middleware/requirePlan');
const { PLANS } = require('../utils/plans');
const { isAdminEmail } = require('../admin/auth');
const { hasGeminiConsent } = require('../ai');
const appConfig = require('../services/appConfig');
const aiUsage = require('../services/aiUsage');
const photo = require('../services/foodPhoto');
const { MEALS } = require('./foods');

const router = express.Router();
const FEATURE = 'food_photo';
const KEY_RE = /^[A-Za-z0-9_\-:.]{8,100}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFAULT_QUOTA = { free: 0, plus: 0, pro: 5, elite: 6, admin: 10 };

// Gemini fetch (tests replace it with a fake)
let fetchImpl = (...a) => fetch(...a);
function setFetchForTests(fn) { fetchImpl = fn || ((...a) => fetch(...a)); }

function coded(status, message, code, extra = {}) {
  const e = new HttpError(status, message);
  e.extra = { code, ...extra };
  return e;
}

const off = (v) => ['false', '0', 'off', 'no'].includes(String(v || '').trim().toLowerCase());

// Is the feature available to this user? -> null or a reason
async function unavailableReason(user) {
  if (!String(process.env.GEMINI_API_KEY || '').trim()) return 'not_configured';
  if (off(process.env.FOOD_PHOTO_ENABLED)) return 'disabled';
  if ((await appConfig.get('food_photo_enabled', true)) === false) return 'disabled';
  const isPublic = (await appConfig.get('food_photo_public', false)) === true;
  if (!isPublic && !isAdminEmail(user.email)) return 'not_rolled_out';
  return null;
}

async function userEmail(userId) {
  const r = await db.get('SELECT email FROM users WHERE id = $1', [userId]);
  return r ? r.email : null;
}

// --- body parsing for /analyze only -------------------------------------
const jsonBig = express.json({ limit: '6mb' });
const rawImage = express.raw({ type: ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'], limit: photo.MAX_IMAGE_BYTES });
function imageBody(req, res, next) {
  const type = String(req.headers['content-type'] || '').toLowerCase();
  const parser = type.startsWith('image/') ? rawImage : jsonBig;
  parser(req, res, (err) => {
    if (!err) return next();
    if (err.type === 'entity.too.large') return next(coded(413, 'The photo is too large (max 4.5 MB). Please try again with a smaller photo.', 'image_too_large'));
    if (err.type === 'entity.parse.failed') return next(coded(400, 'Body is not valid JSON', 'bad_json'));
    return next(err);
  });
}

function readImage(req) {
  const type = String(req.headers['content-type'] || '').toLowerCase();
  if (type.startsWith('image/')) {
    return { buf: Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0), mime: type };
  }
  const b = req.body || {};
  if (typeof b.image_base64 !== 'string' || !b.image_base64) throw coded(400, 'image_base64 is required', 'image_missing');
  const clean = b.image_base64.replace(/^data:[^;,]+;base64,/, '').replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(clean)) throw coded(400, 'image_base64 is not valid base64', 'image_invalid');
  return { buf: Buffer.from(clean, 'base64'), mime: b.mime_type };
}

// --- quota ---------------------------------------------------------------
async function quotaFor(userId, email) {
  const plan = await currentPlan(userId);
  const q = { ...DEFAULT_QUOTA, ...((await appConfig.get('food_photo_daily_quota', DEFAULT_QUOTA)) || {}) };
  let limit = Number(q[plan]) || 0;
  if (isAdminEmail(email)) limit = Math.max(limit, Number(q.admin) || 0);
  const upgradeTo = ['plus', 'pro', 'elite'].find((p) => PLANS[p].rank > PLANS[plan].rank && (Number(q[p]) || 0) > limit) || null;
  return { plan, limit, upgradeTo, quotas: q };
}

async function takeOne(userId, limit) {
  const row = await db.get(`
    INSERT INTO feature_usage (user_id, date, feature, count) VALUES ($1, $2, $3, 1)
    ON CONFLICT (user_id, date, feature) DO UPDATE SET count = feature_usage.count + 1
      WHERE feature_usage.count < $4
    RETURNING count`, [userId, today(), FEATURE, limit]);
  return row ? Number(row.count) : null;
}
async function giveBack(userId) {
  await db.run(`UPDATE feature_usage SET count = GREATEST(0, count - 1) WHERE user_id = $1 AND date = $2 AND feature = $3`,
    [userId, today(), FEATURE]);
}

function jobBody(job, usage) {
  const r = job.result || {};
  return {
    job_id: job.id,
    items: r.items || [],
    totals: r.totals || { kcal: 0, protein_g: 0, carbs_g: 0, fat_g: 0 },
    confidence: r.confidence ?? null,
    low_confidence: Boolean(r.low_confidence),
    is_food: r.is_food !== false,
    estimate: true,
    model: job.model,
    ...(usage ? { usage } : {}),
  };
}

async function setJob(id, fields) {
  const cols = Object.keys(fields);
  await db.run(`UPDATE food_photo_jobs SET ${cols.map((c, i) => `${c} = $${i + 2}`).join(', ')} WHERE id = $1`,
    [id, ...cols.map((c) => (c === 'result' && fields[c] != null ? JSON.stringify(fields[c]) : fields[c]))]);
}

// --- POST /analyze ------------------------------------------------------------
router.post('/analyze', imageBody, asyncHandler(async (req, res) => {
  const userId = req.user.id;
  const email = await userEmail(userId);
  const reason = await unavailableReason({ email });
  if (reason) {
    throw coded(503, 'Photo logging is not available right now. You can still add food by search or by typing it.', 'food_photo_unavailable', { reason });
  }

  const key = String(req.headers['idempotency-key'] || '').trim();
  if (!KEY_RE.test(key)) throw coded(400, 'An Idempotency-Key header (8-100 letters, digits, - _ : .) is required', 'idempotency_key_required');

  // Same key again: replay a finished job without a new AI call
  let job = await db.get('SELECT * FROM food_photo_jobs WHERE user_id = $1 AND idempotency_key = $2', [userId, key]);
  if (job && job.status === 'done') return res.json({ ...jobBody(job), replay: true });
  if (job && job.status === 'pending') throw coded(409, 'This photo is still being analysed', 'food_photo_in_progress');

  const { buf, mime } = readImage(req);
  photo.checkImage(buf, mime);
  const jpeg = await photo.prepareImage(buf);

  if (!(await hasGeminiConsent(userId))) {
    throw coded(403, 'To analyse photos, HeartPurse sends the photo to Google Gemini. Please agree to AI processing first.', 'ai_consent_required');
  }

  const model = photo.modelFromEnv();
  if (job) {
    // Earlier attempt with this key failed / timed out / was blocked: try again on the same job
    const again = await db.get(`UPDATE food_photo_jobs SET status = 'pending', error = NULL, model = $3, created_at = now()
      WHERE id = $1 AND user_id = $2 AND status IN ('failed','timeout','blocked') RETURNING *`, [job.id, userId, model]);
    if (!again) throw coded(409, 'This photo is still being analysed', 'food_photo_in_progress');
    job = again;
  } else {
    job = await db.get(`INSERT INTO food_photo_jobs (user_id, idempotency_key, status, model) VALUES ($1, $2, 'pending', $3)
      ON CONFLICT (user_id, idempotency_key) DO NOTHING RETURNING *`, [userId, key, model]);
    if (!job) throw coded(409, 'This photo is still being analysed', 'food_photo_in_progress');
  }

  // Plan quota
  const q = await quotaFor(userId, email);
  if (q.limit <= 0) {
    await setJob(job.id, { status: 'blocked', error: 'not_in_plan' });
    await aiUsage.record({ userId, feature: FEATURE, model, status: 'blocked_quota' });
    const e = upgradeError(q.upgradeTo
      ? `Photo logging is part of ${PLANS[q.upgradeTo].name}. You can still add food by search or by typing it.`
      : 'Photo logging is not part of your plan. You can still add food by search or by typing it.', { plan: q.plan, upgradeTo: q.upgradeTo, limit: 0 });
    e.extra.code = 'food_photo_not_in_plan';
    throw e;
  }
  const used = await takeOne(userId, q.limit);
  if (used == null) {
    await setJob(job.id, { status: 'blocked', error: 'quota' });
    await aiUsage.record({ userId, feature: FEATURE, model, status: 'blocked_quota' });
    throw coded(429, `You've used your ${q.limit} photo scans for today. They reset tomorrow; you can still add food by search or by typing it.`,
      'food_photo_quota_reached', { limit: q.limit, upgrade_to: q.upgradeTo, upgrade_to_name: q.upgradeTo ? PLANS[q.upgradeTo].name : null });
  }

  // Global monthly AI budget
  const budget = await aiUsage.budgetStatus();
  if (!budget.ok) {
    await giveBack(userId);
    await setJob(job.id, { status: 'blocked', error: 'budget' });
    await aiUsage.record({ userId, feature: FEATURE, model, status: 'blocked_budget' });
    throw coded(429, 'Photo logging is paused for now because the monthly AI limit was reached. Please add food by search or by typing it.', 'ai_budget_reached');
  }

  const t0 = Date.now();
  try {
    const out = await photo.analyze({ jpeg, apiKey: String(process.env.GEMINI_API_KEY).trim(), model, fetchImpl,
      deadlineMs: Number(process.env.FOOD_PHOTO_DEADLINE_MS) || photo.DEADLINE_MS });
    const latency = Date.now() - t0;
    await setJob(job.id, { status: 'done', result: out.result, confidence: out.result.confidence, latency_ms: latency });
    await aiUsage.record({ userId, feature: FEATURE, model, usage: out.usage, images: 1, status: 'ok', latencyMs: latency });
    const done = await db.get('SELECT * FROM food_photo_jobs WHERE id = $1', [job.id]);
    return res.json(jobBody(done, { plan: q.plan, used, limit: q.limit, remaining: Math.max(0, q.limit - used) }));
  } catch (e) {
    const latency = Date.now() - t0;
    if (!(e instanceof photo.FoodPhotoError)) {
      await giveBack(userId);
      await setJob(job.id, { status: 'failed', error: 'internal', latency_ms: latency });
      throw e;
    }
    await giveBack(userId);
    const timeout = e.kind === 'timeout';
    await setJob(job.id, { status: timeout ? 'timeout' : 'failed', error: String(e.message).slice(0, 160), latency_ms: latency });
    await aiUsage.record({ userId, feature: FEATURE, model, usage: e.usage, images: 1, status: timeout ? 'timeout' : 'error', latencyMs: latency });
    if (timeout) throw coded(504, 'The photo took too long to analyse. Please try again, or add food by search.', 'food_photo_timeout');
    throw coded(502, 'We could not analyse this photo. Please try again, or add food by search.', 'food_photo_failed');
  }
}));

// --- POST /confirm ------------------------------------------------------------
const LOG_SELECT_BY_JOB = `
  SELECT l.id, l.date, l.meal, l.servings, l.food_id, l.custom_name AS name,
         CASE WHEN l.custom_grams IS NOT NULL THEN '~' || round(l.custom_grams::numeric)::text || ' g' ELSE '1 portion' END AS serving,
         ROUND((l.custom_kcal * l.servings)::numeric) AS kcal,
         ROUND((l.custom_protein_g * l.servings)::numeric, 1) AS protein_g,
         ROUND((l.custom_carbs_g * l.servings)::numeric, 1) AS carbs_g,
         ROUND((l.custom_fat_g * l.servings)::numeric, 1) AS fat_g,
         l.is_estimate, l.source
  FROM food_logs l WHERE l.photo_job_id = $1 AND l.user_id = $2 ORDER BY l.id`;

function cleanItems(items) {
  if (!Array.isArray(items) || items.length < 1 || items.length > 15) throw new HttpError(400, 'Invalid input', ['items must be a list of 1 to 15 foods']);
  return items.map((it, i) => {
    if (!it || typeof it !== 'object' || Array.isArray(it)) throw new HttpError(400, 'Invalid input', [`items[${i}] must be an object`]);
    const v = validate(it, {
      name: { type: 'string', required: true, maxLength: 80 },
      est_grams: { type: 'number', min: 0, max: 3000 },
      kcal: { type: 'number', required: true, min: 0, max: 5000 },
      protein_g: { type: 'number', min: 0, max: 500 },
      carbs_g: { type: 'number', min: 0, max: 1000 },
      fat_g: { type: 'number', min: 0, max: 500 },
    });
    const name = v.name.replace(/[\u0000-\u001f<>]/g, '').trim();
    if (!name) throw new HttpError(400, 'Invalid input', [`items[${i}].name is required`]);
    return { ...v, name };
  });
}

router.post('/confirm', express.json({ limit: '100kb' }), asyncHandler(async (req, res) => {
  const userId = req.user.id;
  const b = req.body || {};
  const v = validate(b, { job_id: { type: 'string', required: true, maxLength: 36 }, meal: { type: 'string', required: true, oneOf: MEALS }, date: { type: 'date' } });
  if (!UUID_RE.test(v.job_id)) throw new HttpError(404, 'Photo not found');
  const items = cleanItems(b.items);

  const out = await db.tx(async (t) => {
    const job = await t.get('SELECT id, status, confirmed_at FROM food_photo_jobs WHERE id = $1 AND user_id = $2 FOR UPDATE', [v.job_id, userId]);
    if (!job) throw new HttpError(404, 'Photo not found');
    if (job.confirmed_at) return { replay: true, entries: await t.all(LOG_SELECT_BY_JOB, [job.id, userId]) };
    if (job.status !== 'done') throw coded(409, 'This photo has no result to save', 'food_photo_not_ready');
    const date = v.date || today();
    for (const it of items) {
      await t.run(`INSERT INTO food_logs (user_id, food_id, date, meal, servings, custom_name, custom_kcal, custom_protein_g, custom_carbs_g, custom_fat_g,
          custom_grams, is_estimate, source, photo_job_id)
        VALUES ($1, NULL, $2, $3, 1, $4, $5, $6, $7, $8, $9, true, 'photo', $10)`,
      [userId, date, v.meal, it.name, it.kcal, it.protein_g || 0, it.carbs_g || 0, it.fat_g || 0, it.est_grams ?? null, job.id]);
    }
    await t.run('UPDATE food_photo_jobs SET confirmed_at = now() WHERE id = $1', [job.id]);
    return { replay: false, entries: await t.all(LOG_SELECT_BY_JOB, [job.id, userId]) };
  });
  res.status(out.replay ? 200 : 201).json({ job_id: v.job_id, meal: v.meal, entries: out.entries, replay: out.replay });
}));

// Quick availability probe for the app (no AI call, no quota)
router.get('/status', asyncHandler(async (req, res) => {
  const email = await userEmail(req.user.id);
  const reason = await unavailableReason({ email });
  if (reason) return res.json({ available: false, reason });
  const q = await quotaFor(req.user.id, email);
  const row = await db.get('SELECT count FROM feature_usage WHERE user_id = $1 AND date = $2 AND feature = $3', [req.user.id, today(), FEATURE]);
  const used = row ? Number(row.count) : 0;
  res.json({ available: true, plan: q.plan, limit: q.limit, used, remaining: Math.max(0, q.limit - used), upgrade_to: q.upgradeTo });
}));

module.exports = router;
module.exports.setFetchForTests = setFetchForTests;
