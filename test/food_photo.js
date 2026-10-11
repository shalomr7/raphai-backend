// test/food_photo.js — Food photo AI nutrition + AI usage metering (stage 2).
// Run: TEST_DATABASE_URL=postgres://postgres@127.0.0.1:5433/raphai_test node test/food_photo.js
// Gemini is mocked (no network). Images are generated with sharp.
require('dotenv').config();
if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
if (!process.env.DATABASE_URL) { console.error('Set TEST_DATABASE_URL'); process.exit(1); }
const schema = `raphai_photo_${Date.now()}_${process.pid}`;
process.env.DB_SCHEMA = schema;
process.env.JWT_SECRET = 'photo-test-secret-0123456789abcdef';
process.env.NODE_ENV = 'test';
process.env.ADMIN_EMAILS = 'owner@test.dev';
process.env.GEMINI_API_KEY = 'test-key';
process.env.APP_CONFIG_TTL_MS = '0';
delete process.env.FOOD_PHOTO_ENABLED;
delete process.env.FOOD_PHOTO_MODEL;

const sharp = require('sharp');
const db = require('../src/db');
const { createApp } = require('../src/app');
const { resetAll } = require('../src/middleware/rateLimit');
const migrations = require('../src/migrations');
const photoRoute = require('../src/routes/foodPhoto');
const appConfig = require('../src/services/appConfig');
const aiCoach = require('../src/services/aiCoach');
const { createGeminiProvider } = require('../src/ai');

let base; let passed = 0;
function check(name, ok, extra) {
  if (!ok) { console.error(`FAIL: ${name}`, extra === undefined ? '' : JSON.stringify(extra).slice(0, 900)); const e = new Error(name); e.fromCheck = true; throw e; }
  passed++; console.log(`  ok  ${name}`);
}
async function api(method, url, body, token, headers = {}) {
  resetAll();
  const h = { ...headers };
  let payload;
  if (Buffer.isBuffer(body)) { payload = body; } else if (body !== undefined) { h['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  if (token) h.Authorization = `Bearer ${token}`;
  const res = await fetch(base + url, { method, headers: h, body: payload });
  const text = await res.text(); let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json };
}
const n = async (sql, p) => Number((await db.get(`SELECT count(*)::int AS n FROM (${sql}) z`, p)).n);

// --- fake Gemini -------------------------------------------------------------
const sent = [];
let script = [];
const USAGE = { promptTokenCount: 1300, candidatesTokenCount: 220, thoughtsTokenCount: 80, totalTokenCount: 1600 };
const GOOD = { is_food: true, overall_confidence: 0.82, items: [
  { name: 'Rice', est_grams: 200, kcal: 260, protein_g: 5, carbs_g: 56, fat_g: 0.6, confidence: 0.85 },
  { name: 'Dal tadka', est_grams: 150, kcal: 180, protein_g: 9, carbs_g: 22, fat_g: 6, confidence: 0.8 },
] };
function reply(obj, usage = USAGE) {
  return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { role: 'model', parts: [{ text: typeof obj === 'string' ? obj : JSON.stringify(obj) }] }, finishReason: 'STOP' }], usageMetadata: usage }) };
}
const fakeFetch = async (url, opts) => {
  sent.push({ url, body: JSON.parse(opts.body), key: opts.headers['x-goog-api-key'] });
  const next = script.length ? script.shift() : GOOD;
  if (next === 'hang') return new Promise((_, rej) => opts.signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
  if (next && next.httpStatus) return { ok: false, status: next.httpStatus, json: async () => ({ error: { status: 'UNAVAILABLE' } }) };
  if (next && next.coachParts) return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { role: 'model', parts: next.coachParts } }], usageMetadata: USAGE }) };
  return reply(next);
};
photoRoute.setFetchForTests(fakeFetch);

async function register(name, email) {
  const r = await api('POST', '/api/auth/register', { name, email, password: 'secret123', accepted_terms: true });
  if (r.status !== 201 && r.status !== 200) throw new Error(`register ${email}: ${JSON.stringify(r.body)}`);
  return { token: r.body.token, id: r.body.user.id };
}

async function run() {
  const big = await sharp({ create: { width: 2000, height: 1500, channels: 3, background: { r: 200, g: 150, b: 60 } } }).jpeg({ quality: 90 }).toBuffer();
  const png = await sharp({ create: { width: 600, height: 400, channels: 3, background: { r: 10, g: 200, b: 60 } } }).png().toBuffer();
  const webp = await sharp({ create: { width: 300, height: 300, channels: 3, background: { r: 90, g: 20, b: 60 } } }).webp().toBuffer();
  const b64 = (buf) => buf.toString('base64');
  let k = 0; const key = () => `test-key-${Date.now()}-${++k}`;
  const analyze = (token, body, idem = key(), headers = {}) => api('POST', '/api/food/photo/analyze', body, token, { 'Idempotency-Key': idem, ...headers });

  console.log('\nAuth');
  let r = await api('POST', '/api/food/photo/analyze', { image_base64: b64(big), mime_type: 'image/jpeg' });
  check('analyze without login -> 401', r.status === 401, r);
  r = await api('POST', '/api/food/photo/confirm', { job_id: '00000000-0000-0000-0000-000000000000', items: [], meal: 'lunch' });
  check('confirm without login -> 401', r.status === 401, r);

  const owner = await register('Owner', 'owner@test.dev');
  const bob = await register('Bob', 'bob@test.dev');
  const carol = await register('Carol', 'carol@test.dev');

  console.log('\nAvailability (flags, key, rollout)');
  r = await analyze(bob.token, { image_base64: b64(big), mime_type: 'image/jpeg' });
  check('non-admin while not public -> 503 food_photo_unavailable (not_rolled_out)', r.status === 503 && r.body.code === 'food_photo_unavailable' && r.body.reason === 'not_rolled_out', r);
  delete process.env.GEMINI_API_KEY;
  r = await analyze(owner.token, { image_base64: b64(big), mime_type: 'image/jpeg' });
  check('no GEMINI_API_KEY -> 503 food_photo_unavailable (not_configured)', r.status === 503 && r.body.code === 'food_photo_unavailable' && r.body.reason === 'not_configured', r);
  process.env.GEMINI_API_KEY = 'test-key';
  process.env.FOOD_PHOTO_ENABLED = 'false';
  r = await analyze(owner.token, { image_base64: b64(big), mime_type: 'image/jpeg' });
  check('FOOD_PHOTO_ENABLED=false -> 503 (disabled)', r.status === 503 && r.body.code === 'food_photo_unavailable' && r.body.reason === 'disabled', r);
  delete process.env.FOOD_PHOTO_ENABLED;
  await appConfig.set('food_photo_enabled', false);
  r = await analyze(owner.token, { image_base64: b64(big), mime_type: 'image/jpeg' });
  check('app_config food_photo_enabled=false -> 503 (disabled)', r.status === 503 && r.body.reason === 'disabled', r);
  await appConfig.set('food_photo_enabled', true);
  r = await api('GET', '/api/food/photo/status', undefined, owner.token);
  check('status: owner (admin) available with admin quota 10', r.status === 200 && r.body.available === true && r.body.limit === 10, r);
  r = await api('GET', '/api/food/photo/status', undefined, bob.token);
  check('status: bob not available (not_rolled_out)', r.status === 200 && r.body.available === false && r.body.reason === 'not_rolled_out', r);
  check('no Gemini call made so far', sent.length === 0, sent.length);

  console.log('\nValidation');
  r = await api('POST', '/api/food/photo/analyze', { image_base64: b64(big), mime_type: 'image/jpeg' }, owner.token);
  check('missing Idempotency-Key -> 400 idempotency_key_required', r.status === 400 && r.body.code === 'idempotency_key_required', r);
  r = await analyze(owner.token, { image_base64: b64(big), mime_type: 'image/jpeg' }, 'short');
  check('too-short Idempotency-Key -> 400', r.status === 400 && r.body.code === 'idempotency_key_required', r);
  r = await analyze(owner.token, { mime_type: 'image/jpeg' });
  check('no image -> 400 image_missing', r.status === 400 && r.body.code === 'image_missing', r);
  r = await analyze(owner.token, { image_base64: b64(big), mime_type: 'image/gif' });
  check('gif declared -> 400 image_type_unsupported', r.status === 400 && r.body.code === 'image_type_unsupported', r);
  r = await analyze(owner.token, { image_base64: b64(big), mime_type: 'image/png' });
  check('declared png but JPEG bytes -> 400 image_type_mismatch', r.status === 400 && r.body.code === 'image_type_mismatch', r);
  r = await analyze(owner.token, { image_base64: b64(Buffer.from('GIF89a not really an image at all')), mime_type: 'image/jpeg' });
  check('wrong magic bytes -> 400 image_invalid', r.status === 400 && r.body.code === 'image_invalid', r);
  r = await analyze(owner.token, { image_base64: b64(Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 7)])), mime_type: 'image/jpeg' });
  check('JPEG magic but corrupt body -> 400 image_invalid', r.status === 400 && r.body.code === 'image_invalid', r);
  r = await analyze(owner.token, { image_base64: '@@@not-base64@@@', mime_type: 'image/jpeg' });
  check('bad base64 -> 400 image_invalid', r.status === 400 && r.body.code === 'image_invalid', r);
  const huge = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(4.7 * 1024 * 1024, 1)]);
  r = await analyze(owner.token, { image_base64: b64(huge), mime_type: 'image/jpeg' });
  check('image over 4.5 MB (base64 JSON) -> 413 image_too_large', r.status === 413 && r.body.code === 'image_too_large', r);
  r = await analyze(owner.token, Buffer.alloc(7 * 1024 * 1024, 65), key(), { 'Content-Type': 'application/json' });
  check('JSON body over 6 MB -> 413 image_too_large', r.status === 413 && r.body.code === 'image_too_large', r);
  r = await analyze(owner.token, huge, key(), { 'Content-Type': 'image/jpeg' });
  check('raw image body over 4.5 MB -> 413', r.status === 413 && r.body.code === 'image_too_large', r);
  r = await api('POST', '/api/food-logs', { food_id: 1, meal: 'lunch', note: 'x'.repeat(200 * 1024) }, owner.token);
  check('other routes keep the 100 kb JSON limit', r.status === 413, r.status);
  check('still no Gemini call after validation failures', sent.length === 0, sent.length);

  console.log('\nConsent');
  r = await analyze(owner.token, { image_base64: b64(big), mime_type: 'image/jpeg' });
  check('no gemini consent -> 403 ai_consent_required, nothing sent', r.status === 403 && r.body.code === 'ai_consent_required' && sent.length === 0, r);
  for (const u of [owner, bob, carol]) await api('POST', '/api/consents', { type: 'gemini', version: 'v1', granted: true }, u.token);

  console.log('\nAnalyze');
  const k1 = key();
  r = await analyze(owner.token, { image_base64: `data:image/jpeg;base64,${b64(big)}`, mime_type: 'image/jpeg' }, k1);
  check('JPEG analyze -> 200 with items, totals, low_confidence=false, estimate', r.status === 200 && r.body.items.length === 2 && r.body.totals.kcal === 440
    && r.body.totals.protein_g === 14 && r.body.low_confidence === false && r.body.estimate === true && /^[0-9a-f-]{36}$/.test(r.body.job_id), r.body);
  check('item shape: name, est_grams, kcal, protein_g, carbs_g, fat_g, confidence', ['name', 'est_grams', 'kcal', 'protein_g', 'carbs_g', 'fat_g', 'confidence'].every((f) => f in r.body.items[0]), r.body.items[0]);
  check('usage returned: admin quota 10, used 1', r.body.usage && r.body.usage.limit === 10 && r.body.usage.used === 1, r.body.usage);
  const job1 = r.body.job_id;
  const req1 = sent[0];
  const img = req1.body.contents[0].parts.find((p) => p.inlineData);
  const meta = await sharp(Buffer.from(img.inlineData.data, 'base64')).metadata();
  check('image downscaled to <=1024 px JPEG before sending', img.inlineData.mimeType === 'image/jpeg' && meta.width <= 1024 && meta.height <= 1024 && meta.format === 'jpeg', meta);
  check('request: vision model, strict JSON schema, key in header only', /gemini-3\.5-flash-lite:generateContent/.test(req1.url) && req1.key === 'test-key' && !req1.url.includes('key=')
    && req1.body.generationConfig.responseMimeType === 'application/json' && req1.body.generationConfig.responseSchema.required.includes('items'), req1.url);
  const reqText = JSON.stringify({ ...req1.body, contents: req1.body.contents.map((c) => ({ ...c, parts: c.parts.filter((p) => !p.inlineData) })) });
  check('no other user data sent (no name, email, id)', req1.body.contents.length === 1 && req1.body.contents[0].parts.length === 2 && !/owner|Owner|test\.dev/.test(reqText) && !reqText.includes(String(owner.id) + '"'), reqText.slice(0, 300));
  const cols = (await db.all(`SELECT column_name, data_type FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'food_photo_jobs'`, [schema]));
  const jobRow = await db.get('SELECT * FROM food_photo_jobs WHERE id = $1', [job1]);
  check('no image stored: no bytea/image columns, job row has only the JSON result', !cols.some((c) => c.data_type === 'bytea' || /image/.test(c.column_name))
    && !JSON.stringify(jobRow).includes(img.inlineData.data.slice(0, 40)) && jobRow.status === 'done' && jobRow.result.items.length === 2, cols);

  console.log('\nIdempotency');
  const callsBefore = sent.length;
  r = await analyze(owner.token, { image_base64: b64(big), mime_type: 'image/jpeg' }, k1);
  check('same Idempotency-Key -> same job replayed, no new Gemini call, no quota', r.status === 200 && r.body.job_id === job1 && r.body.replay === true && sent.length === callsBefore, r.body);
  r = await api('GET', '/api/food/photo/status', undefined, owner.token);
  check('quota used is still 1 after replay', r.body.used === 1, r.body);
  r = await analyze(owner.token, png, key(), { 'Content-Type': 'image/png' });
  check('raw PNG body accepted', r.status === 200 && r.body.items.length === 2, r);
  r = await analyze(owner.token, { image_base64: b64(webp), mime_type: 'image/webp' });
  check('WebP accepted', r.status === 200, r);
  script = [{ is_food: true, overall_confidence: 0.35, items: [{ name: 'Curry (unclear)', est_grams: 250, kcal: 300, protein_g: 8, carbs_g: 20, fat_g: 18, confidence: 0.3 }] }];
  r = await analyze(owner.token, { image_base64: b64(big), mime_type: 'image/jpeg' });
  check('low confidence result -> low_confidence=true', r.status === 200 && r.body.low_confidence === true && r.body.items.length === 1, r.body);
  script = [{ is_food: false, overall_confidence: 0.9, items: [] }];
  r = await analyze(owner.token, { image_base64: b64(big), mime_type: 'image/jpeg' });
  check('not food -> 200, no items, is_food=false, low_confidence (nothing invented)', r.status === 200 && r.body.items.length === 0 && r.body.is_food === false && r.body.low_confidence === true, r.body);

  console.log('\nFailures (no fake result)');
  let used = (await api('GET', '/api/food/photo/status', undefined, owner.token)).body.used;
  script = ['this is { not json'];
  r = await analyze(owner.token, { image_base64: b64(big), mime_type: 'image/jpeg' });
  check('malformed AI JSON -> 502 food_photo_failed, no items', r.status === 502 && r.body.code === 'food_photo_failed' && !r.body.items, r);
  check('quota given back after failure', (await api('GET', '/api/food/photo/status', undefined, owner.token)).body.used === used);
  process.env.FOOD_PHOTO_DEADLINE_MS = '800';
  script = ['hang'];
  const kt = key();
  r = await analyze(owner.token, { image_base64: b64(big), mime_type: 'image/jpeg' }, kt);
  check('timeout -> 504 food_photo_timeout, no items (the hanging call was made and aborted)', r.status === 504 && r.body.code === 'food_photo_timeout' && !r.body.items && script.length === 0, r);
  delete process.env.FOOD_PHOTO_DEADLINE_MS;
  const tJob = await db.get('SELECT id, status, result FROM food_photo_jobs WHERE user_id = $1 AND idempotency_key = $2', [owner.id, kt]);
  check('timed-out job stored as timeout with no result; quota given back', tJob.status === 'timeout' && tJob.result === null
    && (await api('GET', '/api/food/photo/status', undefined, owner.token)).body.used === used, tJob);
  r = await api('POST', '/api/food/photo/confirm', { job_id: tJob.id, items: [{ name: 'X', kcal: 100 }], meal: 'lunch' }, owner.token);
  check('confirm of a timed-out job -> 409 food_photo_not_ready', r.status === 409 && r.body.code === 'food_photo_not_ready', r);
  r = await analyze(owner.token, { image_base64: b64(big), mime_type: 'image/jpeg' }, kt);
  check('same key after timeout can be retried -> 200 on the same job', r.status === 200 && r.body.job_id === tJob.id, r.body);
  let c0 = sent.length;
  script = [{ httpStatus: 503 }, GOOD];
  r = await analyze(owner.token, { image_base64: b64(big), mime_type: 'image/jpeg' });
  check('transient 503 -> one retry -> 200', r.status === 200 && sent.length - c0 === 2, { s: r.status, calls: sent.length - c0 });
  c0 = sent.length;
  script = [{ httpStatus: 500 }, { httpStatus: 500 }, GOOD];
  r = await analyze(owner.token, { image_base64: b64(big), mime_type: 'image/jpeg' });
  check('two server errors -> 502 after exactly one retry', r.status === 502 && sent.length - c0 === 2, { s: r.status, calls: sent.length - c0 });
  script = [];

  console.log('\nQuota and budget');
  used = (await api('GET', '/api/food/photo/status', undefined, owner.token)).body.used;
  await appConfig.set('food_photo_daily_quota', { free: 0, plus: 0, pro: 5, elite: 6, admin: used + 1 });
  r = await analyze(owner.token, { image_base64: b64(big), mime_type: 'image/jpeg' });
  check('last scan of the day still works', r.status === 200, r);
  c0 = sent.length;
  r = await analyze(owner.token, { image_base64: b64(big), mime_type: 'image/jpeg' });
  check('over daily quota -> 429 food_photo_quota_reached, no Gemini call', r.status === 429 && r.body.code === 'food_photo_quota_reached' && r.body.limit === used + 1 && sent.length === c0, r);
  await appConfig.set('food_photo_daily_quota', { free: 0, plus: 0, pro: 5, elite: 6, admin: 50 });
  await appConfig.set('food_photo_public', true);
  r = await analyze(bob.token, { image_base64: b64(big), mime_type: 'image/jpeg' });
  check('public rollout: free plan -> 402 food_photo_not_in_plan, upgrade_to pro', r.status === 402 && r.body.code === 'food_photo_not_in_plan' && r.body.upgrade_to === 'pro', r);
  await api('POST', '/api/subscription/dev-activate', { plan: 'pro', period: 'yearly' }, carol.token);
  r = await analyze(carol.token, { image_base64: b64(big), mime_type: 'image/jpeg' });
  check('public rollout: Pro user -> 200 with quota 5', r.status === 200 && r.body.usage.limit === 5, r.body.usage);
  const spent = Number((await db.get('SELECT SUM(est_cost_inr) AS s FROM ai_usage')).s);
  await appConfig.set('ai_monthly_budget_inr', spent / 2);
  const carolUsed = (await api('GET', '/api/food/photo/status', undefined, carol.token)).body.used;
  c0 = sent.length;
  r = await analyze(carol.token, { image_base64: b64(big), mime_type: 'image/jpeg' });
  check('monthly AI budget reached -> 429 ai_budget_reached, no Gemini call, quota given back', r.status === 429 && r.body.code === 'ai_budget_reached' && sent.length === c0
    && (await api('GET', '/api/food/photo/status', undefined, carol.token)).body.used === carolUsed, r);
  await appConfig.set('ai_monthly_budget_inr', 1000);
  await appConfig.set('food_photo_public', false);

  console.log('\nConfirm');
  const items = [{ name: 'Rice', est_grams: 180, kcal: 230, protein_g: 4.5, carbs_g: 50, fat_g: 0.5 }, { name: 'Dal', est_grams: 150, kcal: 180, protein_g: 9, carbs_g: 22, fat_g: 6 }, { name: 'Salad', kcal: 40 }];
  r = await api('POST', '/api/food/photo/confirm', { job_id: job1, items, meal: 'lunch' }, carol.token);
  check("someone else's job -> 404", r.status === 404, r);
  r = await api('POST', '/api/food/photo/confirm', { job_id: 'not-a-uuid', items, meal: 'lunch' }, owner.token);
  check('bad job id -> 404', r.status === 404, r);
  r = await api('POST', '/api/food/photo/confirm', { job_id: job1, items: [], meal: 'lunch' }, owner.token);
  check('no items -> 400', r.status === 400, r);
  r = await api('POST', '/api/food/photo/confirm', { job_id: job1, items: [{ name: 'Rice', kcal: -5 }], meal: 'lunch' }, owner.token);
  check('negative kcal -> 400', r.status === 400, r);
  r = await api('POST', '/api/food/photo/confirm', { job_id: job1, items, meal: 'brunch' }, owner.token);
  check('bad meal -> 400', r.status === 400, r);
  r = await api('POST', '/api/food/photo/confirm', { job_id: job1, items, meal: 'lunch' }, owner.token);
  check('confirm -> 201, 3 entries, is_estimate, source photo, no food_id', r.status === 201 && r.body.entries.length === 3 && r.body.entries.every((e) => e.is_estimate === true && e.source === 'photo' && e.food_id === null)
    && r.body.entries[0].kcal === 230 && r.body.entries[0].serving === '~180 g' && r.body.entries[2].serving === '1 portion', r.body);
  const ids = r.body.entries.map((e) => e.id).join();
  r = await api('POST', '/api/food/photo/confirm', { job_id: job1, items: items.slice(0, 1), meal: 'dinner' }, owner.token);
  check('second confirm -> 200 replay, same entries, no duplicates', r.status === 200 && r.body.replay === true && r.body.entries.map((e) => e.id).join() === ids
    && (await n('SELECT 1 FROM food_logs WHERE photo_job_id = $1', [job1])) === 3, r.body);
  const [a, b2] = await Promise.all([1, 2].map(async () => {
    const j = await db.get("SELECT id FROM food_photo_jobs WHERE user_id = $1 AND status = 'done' AND confirmed_at IS NULL AND id <> $2 LIMIT 1", [owner.id, job1]);
    return j.id;
  }));
  const both = await Promise.all([a, b2].map(() => api('POST', '/api/food/photo/confirm', { job_id: a, items, meal: 'snack' }, owner.token)));
  check('two confirms at once -> entries saved once', both.every((x) => x.status === 200 || x.status === 201) && (await n('SELECT 1 FROM food_logs WHERE photo_job_id = $1', [a])) === 3, both.map((x) => x.status));
  // A normal library entry next to the photo entries
  const lib = await api('GET', '/api/foods?q=roti', undefined, owner.token);
  r = await api('POST', '/api/food-logs', { food_id: lib.body.foods[0].id, meal: 'lunch', servings: 2 }, owner.token);
  check('library food logging unchanged', r.status === 201 && r.body.entry.source === 'manual' && r.body.entry.is_estimate === false && r.body.entry.food_id === lib.body.foods[0].id, r.body);
  r = await api('GET', '/api/food-logs', undefined, owner.token);
  const lunch = r.body.meals.lunch;
  check('day view: photo entries read like normal ones, totals include them', r.status === 200 && lunch.entries.length === 4 && lunch.entries.filter((e) => e.source === 'photo').length === 3
    && lunch.kcal >= 450 && r.body.totals.kcal >= 450 + 450, { lunch: lunch.kcal, totals: r.body.totals });
  const pe = lunch.entries.find((e) => e.source === 'photo');
  r = await api('PUT', `/api/food-logs/${pe.id}`, { servings: 2 }, owner.token);
  check('edit a photo entry (servings x2 scales its kcal)', r.status === 200 && r.body.entry.kcal === pe.kcal * 2, r.body);
  const { today, addDays } = require('../src/utils/dates');
  r = await api('POST', '/api/food-logs/repeat', { meal: 'lunch', from_date: today(), to_date: addDays(today(), 1) }, owner.token);
  check('repeat meal copies photo entries with their nutrition', r.status === 201 && r.body.entries.length === 4 && r.body.entries.filter((e) => e.source === 'photo' && e.is_estimate).length === 3, r.body);
  r = await api('GET', '/api/dashboard', undefined, owner.token);
  check('dashboard still works with photo entries', r.status === 200, r.status);

  console.log('\nUsage metering');
  const okRow = await db.get("SELECT * FROM ai_usage WHERE feature = 'food_photo' AND status = 'ok' AND user_id = $1 ORDER BY id LIMIT 1", [owner.id]);
  check('food_photo ok row: tokens from usageMetadata (output incl. thinking), 1 image, cost > 0', okRow && okRow.input_tokens === 1300 && okRow.output_tokens === 300 && okRow.images === 1
    && Number(okRow.est_cost_inr) > 0 && okRow.model === 'gemini-3.5-flash-lite', okRow);
  // 1300 * 0.30/1e6 + 300 * 2.50/1e6 = 0.00114 USD * 96.83 = 0.1104 INR
  check('cost estimated from verified price x usd_inr_rate', Math.abs(Number(okRow.est_cost_inr) - 0.1104) < 0.001, okRow.est_cost_inr);
  for (const st of ['error', 'timeout', 'blocked_quota', 'blocked_budget']) {
    check(`food_photo usage row with status ${st}`, (await n("SELECT 1 FROM ai_usage WHERE feature = 'food_photo' AND status = $1", [st])) >= 1);
  }
  const prices = await db.all('SELECT model, input_per_1m, output_per_1m, verified, source_url FROM model_prices ORDER BY model, effective_from');
  check('model_prices seeded from the official page, verified', prices.length === 3 && prices.every((p) => p.verified && p.source_url === 'https://ai.google.dev/gemini-api/docs/pricing'), prices);

  // Coach usage (coach API unchanged)
  aiCoach.setAiProvider(createGeminiProvider({ apiKey: 'test-key', fetchImpl: fakeFetch, perCallTimeoutMs: 500, totalBudgetMs: 3000 }));
  script = [{ coachParts: [{ text: 'You are doing well. Keep going with your walks this week.' }] }];
  r = await api('POST', '/api/coach', { question: 'how is my week going?' }, carol.token);
  check('coach answers with AI (response shape unchanged)', r.status === 200 && r.body.engine === 'ai' && typeof r.body.answer === 'string', r.body);
  const coachRow = await db.get("SELECT * FROM ai_usage WHERE feature = 'coach' AND user_id = $1 ORDER BY id DESC LIMIT 1", [carol.id]);
  check('coach usage row written from usageMetadata (gemini-3.8-flash on Pro)', coachRow && coachRow.status === 'ok' && coachRow.input_tokens === 1300 && coachRow.output_tokens === 300
    && coachRow.model === 'gemini-3.8-flash' && Number(coachRow.est_cost_inr) > 0, coachRow);
  script = ['hang', 'hang'];
  r = await api('POST', '/api/coach', { question: 'how much water today?' }, carol.token);
  check('coach timeout -> rule-based answer + usage row (timeout/error)', r.status === 200 && r.body.engine === 'rule_based'
    && (await n("SELECT 1 FROM ai_usage WHERE feature = 'coach' AND status IN ('timeout','error')")) >= 1, r.body.ai);
  script = [];
  await appConfig.set('ai_monthly_budget_inr', 0.0001);
  const c1 = sent.length;
  r = await api('POST', '/api/coach', { question: 'how is my week going?' }, carol.token);
  check('coach over AI budget -> rule-based, no Gemini call, blocked_budget row', r.status === 200 && r.body.engine === 'rule_based' && sent.length === c1
    && (await n("SELECT 1 FROM ai_usage WHERE feature = 'coach' AND status = 'blocked_budget'")) === 1, r.body.ai);
  await appConfig.set('ai_monthly_budget_inr', 1000);
  aiCoach.setAiProvider(null);

  console.log('\nMigrations down then up');
  const photoRows = await n('SELECT 1 FROM food_logs WHERE food_id IS NULL');
  const jobs = await n('SELECT 1 FROM food_photo_jobs');
  const usageRows = await n('SELECT 1 FROM ai_usage');
  for (const id of ['015_ai_usage', '010_food_photo']) {
    const m = migrations.find((x) => x.id === id);
    await db.tx(async (t) => { await t.query(m.down); });
  }
  const nullable = await db.get(`SELECT is_nullable FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'food_logs' AND column_name = 'food_id'`, [schema]);
  check('after down: food_id NOT NULL again, new tables gone, migrations unrecorded', nullable.is_nullable === 'NO'
    && !(await db.get("SELECT to_regclass('food_photo_jobs') AS t")).t && !(await db.get("SELECT to_regclass('ai_usage') AS t")).t
    && (await n("SELECT 1 FROM schema_migrations WHERE id IN ('010_food_photo','015_ai_usage')")) === 0);
  appConfig.clearCache();
  r = await api('GET', '/api/food-logs', undefined, owner.token);
  check('after down: old food log reads still work (library entries)', r.status === 200 && r.body.meals.lunch.entries.length === 1, r.body.meals && r.body.meals.lunch);
  r = await api('POST', '/api/food-logs', { food_id: lib.body.foods[0].id, meal: 'dinner' }, owner.token);
  check('after down: logging a library food still works', r.status === 201, r);
  await db.init();
  check('after up: photo entries, jobs and usage rows restored', (await n('SELECT 1 FROM food_logs WHERE food_id IS NULL')) === photoRows
    && (await n('SELECT 1 FROM food_photo_jobs')) === jobs && (await n('SELECT 1 FROM ai_usage')) === usageRows
    && (await n("SELECT 1 FROM schema_migrations WHERE id IN ('010_food_photo','015_ai_usage')")) === 2);
  r = await api('GET', '/api/food-logs', undefined, owner.token);
  check('after up: day view shows photo entries again', r.status === 200 && r.body.meals.lunch.entries.filter((e) => e.source === 'photo').length === 3, r.body.meals.lunch);
  r = await analyze(owner.token, { image_base64: b64(big), mime_type: 'image/jpeg' });
  check('after up: analyze works again', r.status === 200, r);
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
  console.log(ok ? `\nFOOD PHOTO TEST PASSED (${passed} checks)\n` : `\nFOOD PHOTO TEST FAILED after ${passed} passing checks\n`);
  process.exit(ok ? 0 : 1);
}
main();
