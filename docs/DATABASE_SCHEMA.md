# Database schema
Postgres 17 (Supabase Mumbai). Source of truth: `src/migrations/`. Dates are TEXT `YYYY-MM-DD`; 0/1 INTEGER flags.

| Table | Key columns | Owner scope |
|---|---|---|
| users | id, name, email (unique), password_hash, last_active_at, tokens_valid_after | id |
| profiles | user_id PK, sex, age, height/weight, goal, income (+income_paise), step_goal | user_id |
| foods | id, name (unique), macros, verified, created_by | shared library |
| food_logs, food_favourites | user_id, food_id, date, meal, servings | user_id |
| step_logs, activity_daily | user_id, date (unique per day) | user_id |
| workouts, water_logs, sleep_logs, mood_logs, weight_logs | user_id, date, values | user_id |
| reminder_settings | user_id PK | user_id |
| expenses | amount (+amount_paise), category, mode, date | user_id |
| budgets | month, category, amount (+amount_paise), unique(user,month,category) | user_id |
| savings_goals | target/saved (+_paise), deadline | user_id |
| bills / bill_payments | amount (+amount_paise), due_day / (bill_id, month) | user_id / via bill |
| subscriptions, google_play_purchases, payments (legacy) | plan, state, expiry | user_id |
| raphscore_daily, feature_usage | per user per day | user_id |
| consents, security_logs | no FK (kept 1 year after deletion) | user_id |
| ai_proposals_used | jti PK (single-use AI confirmations) | user_id |
| schema_migrations | id, applied_at | owner only |

## Migrations
| id | Change |
|---|---|
| 001_baseline | Schema as of e8b747d (all IF NOT EXISTS; no-op on live DB) |
| 002_auth_token_revocation | users.tokens_valid_after |
| 003_indexes_user_paths | user_id/date indexes on goals, bills, budgets, payments, foods.created_by, security_logs, raphscore, feature_usage |
| 004_money_minor_units | BIGINT *_paise GENERATED from rupee columns (auto backfill, always in sync; old columns unchanged) |
| 005_ai_proposals | ai_proposals_used |
| 006_rls_owner_policies | ENABLE RLS on every table; `owner_rows` policies on `nullif(current_setting('app.user_id', true),'')::int`; foods read policy |

Rules: forward-only, additive, never edit an applied migration. Phase 2: switch reads to paise, then `ALTER COLUMN ... DROP EXPRESSION`.
Upgrade path tested: DB created by e8b747d code + data -> new init applies 001–006, data intact, paise backfilled, RLS on, second init applies 0.
