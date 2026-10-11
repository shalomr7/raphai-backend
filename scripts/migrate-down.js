// scripts/migrate-down.js
// ------------------------------------------------------------
// Roll back ONE migration that has a `down` step, in one transaction.
//   CONFIRM_MIGRATE_DOWN=yes node scripts/migrate-down.js 009_user_identities
// Deploy the previous code FIRST (otherwise the server re-applies the
// migration on its next start). Down steps keep data (see each migration).
// ------------------------------------------------------------
require('dotenv').config();
const db = require('../src/db');
const migrations = require('../src/migrations');

async function main() {
  const id = process.argv[2];
  const m = migrations.find((x) => x.id === id);
  if (!m) throw new Error(`Unknown migration: ${id}`);
  if (!m.down) throw new Error(`${id} has no down step`);
  if (process.env.CONFIRM_MIGRATE_DOWN !== 'yes') throw new Error('Set CONFIRM_MIGRATE_DOWN=yes to run');
  await db.tx(async (t) => {
    await t.query('SELECT pg_advisory_xact_lock(4242001)');
    const done = await t.get('SELECT id FROM schema_migrations WHERE id = $1', [id]);
    if (!done) throw new Error(`${id} is not applied`);
    await t.query(m.down);
  });
  console.log(`Rolled back ${id}`);
}

main().then(() => db.close()).catch(async (e) => { console.error(e.message); await db.close(); process.exit(1); });
