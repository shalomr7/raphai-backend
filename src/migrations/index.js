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
];

// Sanity: ids must be unique and sorted
const ids = migrations.map((m) => m.id);
if (new Set(ids).size !== ids.length) throw new Error('Duplicate migration id');
if ([...ids].sort().join() !== ids.join()) throw new Error('Migrations must be listed in id order');

module.exports = migrations;
module.exports.USER_TABLES = USER_TABLES;
