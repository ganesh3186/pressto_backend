// One-off backfill: fills Store.storePrefix for any store that doesn't
// have one yet, using that store's existing `code` (already globally
// unique, already 2-10 uppercase alphanumeric chars, so it satisfies
// storePrefix's format + uniqueness constraints with zero collision risk).
// This is a placeholder so stores aren't blocked from creating orders —
// rename any of these later via Store Master's "Order Prefix" field.
//
// Only touches rows where storePrefix IS NULL — never overwrites a value
// someone already set. Safe to run more than once.
//
// Usage:
//   node scripts/backfill-store-prefix.js              (writes changes)
//   node scripts/backfill-store-prefix.js --dry-run     (preview only, no writes)
//
// Connection: uses DATABASE_URL if set, otherwise PG_HOST/PG_PORT/PG_USER/
// PG_PASSWORD/PG_DATABASE (same names this repo's own .env already uses).
// If a .env file is present next to this script's working directory and
// the `dotenv` package is installed, it's loaded automatically; if not,
// this still works as long as the PG_*/DATABASE_URL vars are already
// exported in the shell/process environment.

try {
  require('dotenv').config();
} catch (e) {
  // dotenv not installed on this box — fine, rely on real env vars instead.
}

const { Client } = require('pg');

const isDryRun = process.argv.includes('--dry-run');

function buildClient() {
  if (process.env.DATABASE_URL) {
    return new Client({ connectionString: process.env.DATABASE_URL });
  }
  return new Client({
    host: process.env.PG_HOST,
    port: process.env.PG_PORT,
    user: process.env.PG_USER,
    password: process.env.PG_PASSWORD,
    database: process.env.PG_DATABASE,
  });
}

async function main() {
  const client = buildClient();
  await client.connect();

  try {
    const { rows } = await client.query(
      `select id, name, code from store where storeprefix is null and isdeleted = false order by code`
    );

    if (!rows.length) {
      console.log('No stores need a prefix backfill.');
      return;
    }

    console.log(
      `${isDryRun ? '[DRY RUN] Would backfill' : 'Backfilling'} storePrefix for ${rows.length} store(s):`
    );
    for (const store of rows) {
      if (!isDryRun) {
        await client.query(`update store set storeprefix = $1 where id = $2`, [store.code, store.id]);
      }
      console.log(`  ${store.name} (${store.code}) -> storePrefix = ${store.code}`);
    }

    console.log(isDryRun ? 'Dry run complete — nothing was written.' : 'Done.');
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error('ERR', err.message);
  process.exit(1);
});
