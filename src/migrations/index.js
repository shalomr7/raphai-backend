// migrations/index.js
// ------------------------------------------------------------
// Versioned, forward-only, backward-compatible migrations.
//
// How they run: db.init() (called by server.js on EVERY start, before the
// server listens) takes a Postgres advisory lock, creates the
// schema_migrations table if needed, and applies every migration below whose
// id is not in schema_migrations yet, in order, inside ONE transaction.
// If any migration fails, everything rolls back and the server refuses to
// start (on Render the previous deploy keeps serving).
//
// Rules for adding a migration:
//   1. Never edit or reorder a migration that has been deployed.
//   2. Only backward-compatible changes: add columns/tables/indexes/policies.
//      Never drop or rename something the currently deployed code still uses.
//   3. Make each statement idempotent where Postgres allows it
//      (IF NOT EXISTS, or a DO block that checks pg_catalog first).
// ------------------------------------------------------------

const baseline = require('./001_baseline');

// Tables that hold rows belonging to ONE user via a user_id column.
const USER_TABLES = [
  'profiles', 'food_logs', 'step_logs', 'workouts', 'water_logs', 'sleep_logs',
  'mood_logs', 'weight_logs', 'reminder_settings', 'expenses', 'budgets',
  'savings_goals', 'bills', 'subscriptions', 'payments', 'food_favourites',
  'google_play_purchases', 'activity_daily', 'raphscore_daily', 'feature_usage',
  'consents', 'security_logs',
];

// The current request's user, as set by a (future) non-owner DB role with
//   SET LOCAL app.user_id = '<id>'
// Unset -> NULL -> no rows match.
const CURRENT_USER = "nullif(current_setting('app.user_id', true), '')::int";

const migrations = [
  baseline,

  {
    id: '002_auth_token_revocation',
    // Tokens issued before this moment are rejected (logout everywhere).
    sql: 'ALTER TABLE users ADD COLUMN IF NOT EXISTS tokens_valid_after TIMESTAMPTZ;',
  },

  {
    id: '003_indexes_user_paths',
    sql: `
      CREATE INDEX IF NOT EXISTS savings_goals_user ON savings_goals (user_id);
      CREATE INDEX IF NOT EXISTS bills_user ON bills (user_id);
      CREATE INDEX IF NOT EXISTS budgets_user_month ON budgets (user_id, month);
      CREATE INDEX IF NOT EXISTS payments_user ON payments (user_id);
      CREATE INDEX IF NOT EXISTS foods_created_by ON foods (created_by) WHERE created_by IS NOT NULL;
      CREATE INDEX IF NOT EXISTS security_logs_user ON security_logs (user_id, created_at);
      CREATE INDEX IF NOT EXISTS raphscore_daily_user_date ON raphscore_daily (user_id, date);
      CREATE INDEX IF NOT EXISTS feature_usage_user_date ON feature_usage (user_id, date);
    `,
  },

  {
    // Money was stored as DOUBLE PRECISION rupees. These integer paise columns
    // are GENERATED from the rupee columns, so they are backfilled for every
    // existing row and stay in sync on every write without code changes.
    // The old rupee columns stay readable (API unchanged).
    // Phase 2: switch reads to *_paise, then
    //   ALTER TABLE ... ALTER COLUMN amount_paise DROP EXPRESSION
    // and make paise the source of truth.
    id: '004_money_minor_units',
    sql: `
      ALTER TABLE expenses      ADD COLUMN IF NOT EXISTS amount_paise BIGINT GENERATED ALWAYS AS (round(amount * 100)::bigint) STORED;
      ALTER TABLE budgets       ADD COLUMN IF NOT EXISTS amount_paise BIGINT GENERATED ALWAYS AS (round(amount * 100)::bigint) STORED;
      ALTER TABLE bills         ADD COLUMN IF NOT EXISTS amount_paise BIGINT GENERATED ALWAYS AS (round(amount * 100)::bigint) STORED;
      ALTER TABLE savings_goals ADD COLUMN IF NOT EXISTS target_paise BIGINT GENERATED ALWAYS AS (round(target * 100)::bigint) STORED;
      ALTER TABLE savings_goals ADD COLUMN IF NOT EXISTS saved_paise  BIGINT GENERATED ALWAYS AS (round(saved * 100)::bigint) STORED;
      ALTER TABLE profiles      ADD COLUMN IF NOT EXISTS income_paise BIGINT GENERATED ALWAYS AS (round(income * 100)::bigint) STORED;
    `,
  },

  {
    // One row per confirmed AI proposal, so a confirmation token works once.
    id: '005_ai_proposals',
    sql: `
      CREATE TABLE IF NOT EXISTS ai_proposals_used (
        jti        TEXT PRIMARY KEY,
        user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        kind       TEXT NOT NULL,
        used_at    TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS ai_proposals_used_user ON ai_proposals_used (user_id, used_at);
    `,
  },

  {
    // Row Level Security as DEFENCE IN DEPTH.
    // The API server connects as the role that OWNS these tables (raphai_app on
    // Supabase, verified 2026-10-09: not superuser, not BYPASSRLS, owner of
    // every table). Table owners are not subject to RLS unless FORCE is set,
    // and we deliberately do NOT force it, so the server keeps working.
    // Effect: any OTHER role (Supabase anon / authenticated via the Data API,
    // or a future least-privilege runtime role) sees nothing unless a policy
    // lets it, and the owner policies only match rows of app.user_id.
    id: '006_rls_owner_policies',
    sql: `
      DO $rls$
      DECLARE
        t text;
        user_tables text[] := ARRAY['${USER_TABLES.concat(['ai_proposals_used']).join("','")}'];
        all_tables  text[] := user_tables || ARRAY['users','foods','bill_payments','schema_migrations'];
      BEGIN
        FOREACH t IN ARRAY all_tables LOOP
          EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
        END LOOP;

        FOREACH t IN ARRAY user_tables LOOP
          IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = current_schema() AND tablename = t AND policyname = 'owner_rows') THEN
            EXECUTE format($f$CREATE POLICY owner_rows ON %I FOR ALL USING (user_id = ${CURRENT_USER}) WITH CHECK (user_id = ${CURRENT_USER})$f$, t);
          END IF;
        END LOOP;

        IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = current_schema() AND tablename = 'users' AND policyname = 'owner_rows') THEN
          CREATE POLICY owner_rows ON users FOR ALL USING (id = ${CURRENT_USER}) WITH CHECK (id = ${CURRENT_USER});
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = current_schema() AND tablename = 'bill_payments' AND policyname = 'owner_rows') THEN
          CREATE POLICY owner_rows ON bill_payments FOR ALL
            USING (EXISTS (SELECT 1 FROM bills b WHERE b.id = bill_id AND b.user_id = ${CURRENT_USER}))
            WITH CHECK (EXISTS (SELECT 1 FROM bills b WHERE b.id = bill_id AND b.user_id = ${CURRENT_USER}));
        END IF;
        -- Shared food library: verified foods + your own custom foods are readable; no writes.
        IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = current_schema() AND tablename = 'foods' AND policyname = 'read_library') THEN
          CREATE POLICY read_library ON foods FOR SELECT USING (verified = 1 OR created_by = ${CURRENT_USER});
        END IF;
        -- schema_migrations: RLS on, no policy = owner only.
      END
      $rls$;
    `,
  },

  {
    // Password reset codes: only an HMAC of the 6-digit code is stored.
    id: '007_password_resets',
    sql: `
      CREATE TABLE IF NOT EXISTS password_resets (
        id         BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
        user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        code_hash  TEXT NOT NULL,
        attempts   INTEGER NOT NULL DEFAULT 0,
        expires_at TIMESTAMPTZ NOT NULL,
        used_at    TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS password_resets_user ON password_resets (user_id, created_at);
      ALTER TABLE password_resets ENABLE ROW LEVEL SECURITY;
      DO $p$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = current_schema() AND tablename = 'password_resets' AND policyname = 'owner_rows') THEN
          CREATE POLICY owner_rows ON password_resets FOR ALL USING (user_id = ${CURRENT_USER}) WITH CHECK (user_id = ${CURRENT_USER});
        END IF;
      END $p$;
    `,
  },

  {
    // Admin dashboard audit trail: who (actor_id = the admin's user id) did
    // what to whom (user_id = the customer it concerns, if any), plus small
    // non-sensitive details (section viewed, search length, reason given).
    id: '008_admin_audit',
    sql: `
      ALTER TABLE security_logs ADD COLUMN IF NOT EXISTS actor_id INTEGER;
      ALTER TABLE security_logs ADD COLUMN IF NOT EXISTS detail JSONB;
      CREATE INDEX IF NOT EXISTS security_logs_event_created ON security_logs (event, created_at);
    `,
  },

  {
    // Google sign-in (Android). One row per external login linked to a user.
    // password_hash becomes nullable so a Google-only account needs no password.
    // Old code keeps working: every existing row still has a hash.
    // Reversible with `down` (scripts/migrate-down.js 009_user_identities),
    // which keeps all data: the table is renamed, not dropped, and
    // password-less accounts get an unusable marker hash ('!no-password').
    id: '009_user_identities',
    sql: `
      ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;
      -- Re-applying after a rollback restores the kept rows and markers
      DO $r$ BEGIN
        IF to_regclass('user_identities') IS NULL AND to_regclass('user_identities_rolled_back_009') IS NOT NULL THEN
          ALTER TABLE user_identities_rolled_back_009 RENAME TO user_identities;
        END IF;
      END $r$;
      UPDATE users SET password_hash = NULL WHERE password_hash = '!no-password';
      CREATE TABLE IF NOT EXISTS user_identities (
        id             BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
        user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        provider       TEXT NOT NULL CHECK (provider IN ('google')),
        provider_sub   TEXT NOT NULL,
        email          TEXT,
        email_verified BOOLEAN NOT NULL DEFAULT false,
        created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
        last_used_at   TIMESTAMPTZ,
        CONSTRAINT user_identities_provider_sub UNIQUE (provider, provider_sub),
        CONSTRAINT user_identities_user_provider UNIQUE (user_id, provider)
      );
      CREATE INDEX IF NOT EXISTS user_identities_user ON user_identities (user_id);
      ALTER TABLE user_identities ENABLE ROW LEVEL SECURITY;
      DO $p$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = current_schema() AND tablename = 'user_identities' AND policyname = 'owner_rows') THEN
          CREATE POLICY owner_rows ON user_identities FOR ALL USING (user_id = ${CURRENT_USER}) WITH CHECK (user_id = ${CURRENT_USER});
        END IF;
      END $p$;
    `,
    down: `
      ALTER TABLE IF EXISTS user_identities RENAME TO user_identities_rolled_back_009;
      UPDATE users SET password_hash = '!no-password' WHERE password_hash IS NULL;
      ALTER TABLE users ALTER COLUMN password_hash SET NOT NULL;
      DELETE FROM schema_migrations WHERE id = '009_user_identities';
    `,
  },

  {
    // Stage 2: food photo AI nutrition.
    //  - food_photo_jobs: one row per analysis request (metadata + the model's
    //    JSON result only; the image itself is NEVER stored, not even a hash).
    //  - food_logs: entries without a library food (food_id NULL) carry their
    //    own name + nutrition (custom_*), an is_estimate flag and a source.
    //    Old code keeps working: every existing row still has a food_id, and
    //    the new columns are optional.
    // Reversible with `down` (scripts/migrate-down.js 010_food_photo), which
    // keeps data: photo entries are moved to a side table and the jobs table
    // is renamed; re-applying 010 restores both.
    id: '010_food_photo',
    sql: `
      DO $r$ BEGIN
        IF to_regclass('food_photo_jobs') IS NULL AND to_regclass('food_photo_jobs_rolled_back_010') IS NOT NULL THEN
          ALTER TABLE food_photo_jobs_rolled_back_010 RENAME TO food_photo_jobs;
        END IF;
      END $r$;
      CREATE TABLE IF NOT EXISTS food_photo_jobs (
        id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        idempotency_key TEXT NOT NULL,
        status          TEXT NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending','done','failed','timeout','blocked')),
        model           TEXT,
        result          JSONB,
        confidence      REAL,
        error           TEXT,
        latency_ms      INTEGER,
        confirmed_at    TIMESTAMPTZ,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT food_photo_jobs_user_key UNIQUE (user_id, idempotency_key)
      );
      CREATE INDEX IF NOT EXISTS food_photo_jobs_user_created ON food_photo_jobs (user_id, created_at);

      ALTER TABLE food_logs ALTER COLUMN food_id DROP NOT NULL;
      ALTER TABLE food_logs ADD COLUMN IF NOT EXISTS custom_name      TEXT;
      ALTER TABLE food_logs ADD COLUMN IF NOT EXISTS custom_kcal      DOUBLE PRECISION;
      ALTER TABLE food_logs ADD COLUMN IF NOT EXISTS custom_protein_g DOUBLE PRECISION;
      ALTER TABLE food_logs ADD COLUMN IF NOT EXISTS custom_carbs_g   DOUBLE PRECISION;
      ALTER TABLE food_logs ADD COLUMN IF NOT EXISTS custom_fat_g     DOUBLE PRECISION;
      ALTER TABLE food_logs ADD COLUMN IF NOT EXISTS custom_grams     DOUBLE PRECISION;
      ALTER TABLE food_logs ADD COLUMN IF NOT EXISTS is_estimate      BOOLEAN NOT NULL DEFAULT false;
      ALTER TABLE food_logs ADD COLUMN IF NOT EXISTS source           TEXT NOT NULL DEFAULT 'manual';
      ALTER TABLE food_logs ADD COLUMN IF NOT EXISTS photo_job_id     UUID;
      CREATE INDEX IF NOT EXISTS food_logs_photo_job ON food_logs (photo_job_id) WHERE photo_job_id IS NOT NULL;
      DO $c$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'food_logs_food_or_custom' AND conrelid = 'food_logs'::regclass) THEN
          ALTER TABLE food_logs ADD CONSTRAINT food_logs_food_or_custom
            CHECK (food_id IS NOT NULL OR (custom_name IS NOT NULL AND custom_kcal IS NOT NULL));
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'food_logs_source_check' AND conrelid = 'food_logs'::regclass) THEN
          ALTER TABLE food_logs ADD CONSTRAINT food_logs_source_check
            CHECK (source IN ('manual','photo','parse','repeat'));
        END IF;
      END $c$;
      -- Re-applying after a rollback puts the kept photo entries back
      DO $b$ BEGIN
        IF to_regclass('food_logs_photo_rolled_back_010') IS NOT NULL THEN
          INSERT INTO food_logs SELECT * FROM food_logs_photo_rolled_back_010 ON CONFLICT (id) DO NOTHING;
          DROP TABLE food_logs_photo_rolled_back_010;
        END IF;
      END $b$;

      ALTER TABLE food_photo_jobs ENABLE ROW LEVEL SECURITY;
      DO $p$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = current_schema() AND tablename = 'food_photo_jobs' AND policyname = 'owner_rows') THEN
          CREATE POLICY owner_rows ON food_photo_jobs FOR ALL USING (user_id = ${CURRENT_USER}) WITH CHECK (user_id = ${CURRENT_USER});
        END IF;
      END $p$;
    `,
    down: `
      CREATE TABLE IF NOT EXISTS food_logs_photo_rolled_back_010 AS SELECT * FROM food_logs WHERE false;
      INSERT INTO food_logs_photo_rolled_back_010 SELECT * FROM food_logs WHERE food_id IS NULL;
      DELETE FROM food_logs WHERE food_id IS NULL;
      ALTER TABLE food_logs DROP CONSTRAINT IF EXISTS food_logs_food_or_custom;
      ALTER TABLE food_logs ALTER COLUMN food_id SET NOT NULL;
      ALTER TABLE IF EXISTS food_photo_jobs RENAME TO food_photo_jobs_rolled_back_010;
      DELETE FROM schema_migrations WHERE id = '010_food_photo';
    `,
  },

  {
    // Stage 2 (usage part of the planned 015): AI metering and a spend cap.
    //  - ai_usage: one row per AI request (coach question, food photo), with
    //    tokens from Gemini usageMetadata and an estimated cost in rupees.
    //    user_id is SET NULL on account deletion so spend totals stay right.
    //  - model_prices: list prices per model, seeded ONLY from Google's
    //    pricing page (https://ai.google.dev/gemini-api/docs/pricing, fetched
    //    2026-10-11, page "Last updated 2026-10-09 UTC"). Unverified -> NULL.
    //  - app_config: key/value settings (monthly AI budget in rupees, food
    //    photo quotas per plan, feature flags, USD->INR rate).
    // Reversible with `down`: tables are renamed (data kept), not dropped.
    id: '015_ai_usage',
    sql: `
      DO $r$ DECLARE t text; BEGIN
        FOREACH t IN ARRAY ARRAY['ai_usage','model_prices','app_config'] LOOP
          IF to_regclass(t) IS NULL AND to_regclass(t || '_rolled_back_015') IS NOT NULL THEN
            EXECUTE format('ALTER TABLE %I RENAME TO %I', t || '_rolled_back_015', t);
          END IF;
        END LOOP;
      END $r$;
      CREATE TABLE IF NOT EXISTS ai_usage (
        id            BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
        user_id       INTEGER REFERENCES users(id) ON DELETE SET NULL,
        feature       TEXT NOT NULL CHECK (feature IN ('coach','food_photo','food_parse_ai')),
        model         TEXT,
        input_tokens  INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        images        INTEGER NOT NULL DEFAULT 0,
        est_cost_inr  NUMERIC(12,4) NOT NULL DEFAULT 0,
        status        TEXT NOT NULL CHECK (status IN ('ok','fallback','error','timeout','blocked_quota','blocked_budget')),
        latency_ms    INTEGER,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS ai_usage_created ON ai_usage (created_at);
      CREATE INDEX IF NOT EXISTS ai_usage_user_created ON ai_usage (user_id, created_at);

      CREATE TABLE IF NOT EXISTS model_prices (
        id                    BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
        model                 TEXT NOT NULL,
        input_per_1m          NUMERIC(12,4),
        output_per_1m         NUMERIC(12,4),
        per_image             NUMERIC(12,6),
        currency              TEXT NOT NULL DEFAULT 'USD',
        effective_from        DATE,
        effective_to          DATE,
        source_url            TEXT,
        verified              BOOLEAN NOT NULL DEFAULT false,
        verified_at           DATE,
        notes                 TEXT,
        CONSTRAINT model_prices_model_from UNIQUE (model, effective_from)
      );
      INSERT INTO model_prices (model, input_per_1m, output_per_1m, per_image, currency, effective_from, effective_to, source_url, verified, verified_at, notes) VALUES
        ('gemini-3.5-flash-lite', 0.30, 2.50, NULL, 'USD', '2026-01-01', NULL, 'https://ai.google.dev/gemini-api/docs/pricing', true, '2026-10-11',
         'Paid tier, Standard. Input $0.30 covers text/image/video/audio; images are billed as input tokens (no per-image price published, so per_image is NULL). Free tier: free of charge, content used to improve Google products.'),
        ('gemini-3.8-flash', 0.75, 3.75, NULL, 'USD', '2026-01-01', '2026-12-31', 'https://ai.google.dev/gemini-api/docs/pricing', true, '2026-10-11',
         'Paid tier, Standard, through 2026-12-31. Output includes thinking tokens. No per-image price published (images billed as input tokens).'),
        ('gemini-3.8-flash', 1.50, 7.50, NULL, 'USD', '2027-01-01', NULL, 'https://ai.google.dev/gemini-api/docs/pricing', true, '2026-10-11',
         'Paid tier, Standard, from 2027-01-01 (announced on the pricing page).')
      ON CONFLICT (model, effective_from) DO NOTHING;

      CREATE TABLE IF NOT EXISTS app_config (
        key        TEXT PRIMARY KEY,
        value      JSONB NOT NULL,
        note       TEXT,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      INSERT INTO app_config (key, value, note) VALUES
        ('ai_monthly_budget_inr', '1000', 'Global monthly AI spend cap in rupees (estimated at paid-tier list prices). Over it, AI calls are blocked (photo: 429 ai_budget_reached; coach: rule-based answer).'),
        ('food_photo_daily_quota', '{"free":0,"plus":0,"pro":5,"elite":6,"admin":10}', 'Food photo scans per user per day, by plan. "admin" applies to ADMIN_EMAILS accounts (owner testing).'),
        ('food_photo_enabled', 'true', 'Feature flag: false turns food photo off for everyone (503 food_photo_unavailable).'),
        ('food_photo_public', 'false', 'Rollout flag: false = only ADMIN_EMAILS accounts can use food photo; true = every user (subject to plan quota).'),
        ('usd_inr_rate', '96.83', 'USD->INR rate for cost estimates. Source: open.er-api.com, 2026-10-11 (not an official rate; update as needed).')
      ON CONFLICT (key) DO NOTHING;

      ALTER TABLE ai_usage ENABLE ROW LEVEL SECURITY;
      ALTER TABLE model_prices ENABLE ROW LEVEL SECURITY;  -- no policy = server (owner) only
      ALTER TABLE app_config ENABLE ROW LEVEL SECURITY;    -- no policy = server (owner) only
      DO $p$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = current_schema() AND tablename = 'ai_usage' AND policyname = 'owner_rows') THEN
          CREATE POLICY owner_rows ON ai_usage FOR SELECT USING (user_id = ${CURRENT_USER});
        END IF;
      END $p$;
    `,
    down: `
      ALTER TABLE IF EXISTS ai_usage RENAME TO ai_usage_rolled_back_015;
      ALTER TABLE IF EXISTS model_prices RENAME TO model_prices_rolled_back_015;
      ALTER TABLE IF EXISTS app_config RENAME TO app_config_rolled_back_015;
      DELETE FROM schema_migrations WHERE id = '015_ai_usage';
    `,
  },
];

// Sanity: ids must be unique and sorted
const ids = migrations.map((m) => m.id);
if (new Set(ids).size !== ids.length) throw new Error('Duplicate migration id');
if ([...ids].sort().join() !== ids.join()) throw new Error('Migrations must be listed in id order');

module.exports = migrations;
module.exports.USER_TABLES = USER_TABLES;
