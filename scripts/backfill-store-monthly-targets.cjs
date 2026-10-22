// One-off backfill: Store used to carry a single itemTarget/serviceTarget/
// revenueTarget per store. Those 3 columns are being replaced by
// StoreMonthlyTarget (one row per store+year+month), so this copies
// whatever a store already had into every month of the CURRENT year —
// a starting point the user can then edit per month going forward,
// rather than silently losing a value someone already set.
//
// Run this AFTER `npm run migrate` has created the store_monthly_target
// table (it reads from it to check it exists first).
//
// Idempotent / safe to run more than once: ON CONFLICT (storeid, year,
// month) DO NOTHING, so re-running never overwrites a row a user has
// since edited by hand.
//
// Usage:
//   node scripts/backfill-store-monthly-targets.cjs              (writes changes)
//   node scripts/backfill-store-monthly-targets.cjs --dry-run    (preview only)
//
// Does NOT drop the old Store columns — see drop-store-target-columns.cjs,
// a separate, deliberately later step so there's a manual checkpoint
// between "backfilled" and "old columns gone for good".

require('dotenv').config();

const {Client} = require('pg');
const {randomUUID} = require('crypto');

const isDryRun = process.argv.includes('--dry-run');

async function main() {
  const client = new Client({
    host: process.env.PG_HOST,
    port: Number(process.env.PG_PORT),
    user: process.env.PG_USER,
    password: process.env.PG_PASSWORD,
    database: process.env.PG_DATABASE,
  });

  await client.connect();
  try {
    const {rows: tableCheck} = await client.query(
      "SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'store_monthly_target'",
    );
    if (!tableCheck.length) {
      throw new Error(
        "store_monthly_target table doesn't exist yet — run `npm run migrate` first.",
      );
    }

    const {rows: stores} = await client.query(
      'SELECT id, name, code, itemtarget, servicetarget, revenuetarget FROM public.store WHERE isdeleted = false',
    );
    if (!stores.length) {
      console.log('No stores found — nothing to backfill.');
      return;
    }

    const year = new Date().getFullYear();
    console.log(
      `${isDryRun ? '[DRY RUN] Would backfill' : 'Backfilling'} ${stores.length} store(s) x 12 months for ${year}:`,
    );

    let inserted = 0;
    for (const store of stores) {
      console.log(
        `  ${store.name} (${store.code}) -> item=${store.itemtarget ?? 'null'}, service=${store.servicetarget ?? 'null'}, revenue=${store.revenuetarget ?? 'null'}`,
      );
      if (isDryRun) continue;

      for (let month = 1; month <= 12; month += 1) {
        const result = await client.query(
          `INSERT INTO public.store_monthly_target
             (id, storeid, year, month, itemtarget, servicetarget, revenuetarget, isactive, isdeleted, createdat, updatedat)
           VALUES ($1, $2, $3, $4, $5, $6, $7, true, false, now(), now())
           ON CONFLICT (storeid, year, month) DO NOTHING`,
          [randomUUID(), store.id, year, month, store.itemtarget, store.servicetarget, store.revenuetarget],
        );
        inserted += result.rowCount;
      }
    }

    console.log(
      isDryRun
        ? 'Dry run complete — nothing was written.'
        : `Done. ${inserted} row(s) inserted (existing rows for ${year} were left untouched).`,
    );
  } finally {
    await client.end();
  }
}

main().catch(error => {
  console.error('Could not backfill store monthly targets:', error.message);
  process.exit(1);
});
