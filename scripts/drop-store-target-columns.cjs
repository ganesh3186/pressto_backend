// Drops Store.itemTarget/serviceTarget/revenueTarget once their values are
// safely copied into StoreMonthlyTarget — run backfill-store-monthly-
// targets.cjs FIRST and confirm it, then run this. Deliberately a separate
// script (not folded into the backfill) so dropping the old columns is a
// conscious, later step rather than automatic.

require('dotenv').config();

const {Client} = require('pg');

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
    await client.query(`
      ALTER TABLE public.store
        DROP COLUMN IF EXISTS itemtarget,
        DROP COLUMN IF EXISTS servicetarget,
        DROP COLUMN IF EXISTS revenuetarget
    `);
    console.log('Dropped itemTarget/serviceTarget/revenueTarget from store.');
  } finally {
    await client.end();
  }
}

main().catch(error => {
  console.error('Could not drop store target columns:', error.message);
  process.exit(1);
});
