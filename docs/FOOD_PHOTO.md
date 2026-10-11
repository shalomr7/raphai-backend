# Food photo AI nutrition + AI usage metering (stage 2)

## What it does
"Snap your meal" in the app sends ONE photo (resized on the phone to <=1024 px JPEG, and again on the server) to Google Gemini, which returns
estimated items (name, grams, kcal, protein, carbs, fat, confidence). The user edits the list and saves; entries are stored as
estimates (`is_estimate = true`, `source = 'photo'`, `food_id` NULL with `custom_*` nutrition). **The photo is never stored** (not the
bytes, not a hash): only the JSON result is kept in `food_photo_jobs`. EXIF/GPS is dropped by re-encoding.

## Endpoints
- `POST /api/food/photo/analyze` - header `Idempotency-Key` (required). Body `{ image_base64, mime_type }` (JSON, up to ~6 MB) or raw
  `image/jpeg|png|webp` bytes (up to 4.5 MB). The raised body limit applies to this route only; every other route keeps 100 kb.
  MIME type and magic bytes must agree. Error codes: see the header of `src/routes/foodPhoto.js`
  (503 food_photo_unavailable, 403 ai_consent_required, 402 food_photo_not_in_plan, 429 food_photo_quota_reached / ai_budget_reached,
  504 food_photo_timeout, 502 food_photo_failed, 413 image_too_large, 400 image_*).
- `POST /api/food/photo/confirm` `{ job_id, items[], meal, date? }` - idempotent per job, owner only.
- `GET /api/food/photo/status` - available? quota left? (no AI call).

Gemini gets only the image and a fixed prompt (no name, email, id or history). 20 s deadline, at most one retry (network/5xx/429 only).
A failed or timed-out call returns an error, never a made-up result, and gives the day's quota unit back.
The user's existing `gemini` consent is required (DPDP): the app asks for it on first use.

## Rollout and config (`app_config` table, migration 015)
| key | default | meaning |
|---|---|---|
| `food_photo_enabled` | `true` | kill switch (also env `FOOD_PHOTO_ENABLED=false`) |
| `food_photo_public` | `false` | `false` = only `ADMIN_EMAILS` accounts (owner testing); set `true` to open to every user |
| `food_photo_daily_quota` | `{"free":0,"plus":0,"pro":5,"elite":6,"admin":10}` | scans per user per day; `admin` applies to ADMIN_EMAILS accounts |
| `ai_monthly_budget_inr` | `1000` | global monthly AI cap (estimated). Over it: photo -> 429 ai_budget_reached, coach -> rule-based answer. `0` = all AI off |
| `usd_inr_rate` | `96.83` | for cost estimates (open.er-api.com, 2026-10-11; not an official rate - update as needed) |

Change a value (Supabase SQL editor): `UPDATE app_config SET value = 'true'::jsonb, updated_at = now() WHERE key = 'food_photo_public';`
(cached up to 30 s per server instance).

## Metering
`ai_usage` gets one row per AI request: coach questions (tokens summed over all tool rounds) and food photos, with status
`ok | fallback | error | timeout | blocked_quota | blocked_budget`. Tokens come from Gemini `usageMetadata`
(output = candidates + thinking tokens). `est_cost_inr` uses `model_prices` (paid-tier list price, seeded only from
https://ai.google.dev/gemini-api/docs/pricing on 2026-10-11) x `usd_inr_rate`. It is an **estimate**: while the key is on the free tier
Google charges nothing. Unverified prices are stored as NULL / `verified=false` and count as 0.

| model | input / 1M | output / 1M | per image | verified |
|---|---|---|---|---|
| gemini-3.5-flash-lite (food photo, Plus coach) | $0.30 (text/image) | $2.50 | none published (images billed as input tokens) | yes |
| gemini-3.8-flash (Pro/Elite coach), to 2026-12-31 | $0.75 | $3.75 | none published | yes |
| gemini-3.8-flash from 2027-01-01 | $1.50 | $7.50 | none published | yes |

## Privacy: free tier vs paid tier
The production `GEMINI_API_KEY` is currently a **free-tier** key. Google's pricing page states that on the free tier content is
"used to improve our products"; on the paid tier it is not. Meal photos are health-adjacent personal data, so **switch the Gemini
project to the paid tier before setting `food_photo_public = true`**, and make sure the Privacy Policy names AI photo analysis.
Free-tier rate limits apply per project and can throttle all users at once.

## Rollback
`CONFIRM_MIGRATE_DOWN=yes node scripts/migrate-down.js 015_ai_usage` then `... 010_food_photo` (deploy the previous code first).
Down steps keep data: photo log entries move to `food_logs_photo_rolled_back_010` and tables are renamed `*_rolled_back_0xx`;
re-applying restores them. Covered by `test/food_photo.js`.
