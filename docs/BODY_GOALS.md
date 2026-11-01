# Adaptive Body Goals — weekly weight forecast (model hp-forecast-1)

Endpoints: `GET /api/body/forecast`, `GET /api/body/progress`. Weigh-ins: `/api/health/weight` (now also `measured_at` HH:MM and `waist_cm`). Profile: `target_weight_kg`, `body_fat_pct`. Workouts: `intensity`, `distance_km`, `source` (`manual`/`suggested`), `client_id` (retry-safe). Coach tool: `getWeightForecast`.

All numbers come from `src/services/bodyEngine.js` (deterministic, no AI):
- Weight trend: exponential smoothing, alpha 0.1/day. Predictions are stored in `weight_forecasts`, never in `weight_logs`.
- Resting energy: Katch-McArdle with body-fat %, else Mifflin-St Jeor. Base use = resting × 1.2.
- Steps: net 0.5 kcal/kg/km, stride 0.414 × height, only steps above 3,000/day.
- Workouts: net (MET − 1) × kg × h. Walking/running/jogging/stairs are skipped on days that have step data (already counted in steps).
- Intake: only fully logged days (2+ meal types, ≥ 800 kcal). Needs 4 of the last 7 days, else `need_logs`.
- Range: ±1σ with food ±12 %, energy use ±10 %, workouts ±25 %, widened for missing days; 7,700 kcal ≈ 1 kg.
- Adaptive: 5+ weigh-ins over 14+ days and 10+ logged days in 28 → energy use seen in the trend blended 50/50 with the formula, clamped ±25 %.
- Track record: one forecast per 7 days is compared with the trend at its horizon (needs a weigh-in within 3 days); error saved in `weight_forecasts.error_kg`.
- Safety flags: low_intake (< 1,500 men / 1,200 women), fast_loss (> 1 % body weight/week), fast_gain (> 0.5 kg/week), underweight_loss (BMI < 18.5). App is 18+ only (profile age min 18).

Steps on the server: `activity_daily.steps` keeps the HIGHER of phone/Health Connect per day (never summed; retries are no-ops; `manual` replaces), provenance in `steps_source`.

Tests: `npm run test:body` (pure engine). `node test/body_pglite.js` runs every migration plus this SQL on PGlite (in-memory Postgres) — `npm i --no-save @electric-sql/pglite` first.
