// One-off rename: report_consolidated_daily_sales:read -> report_daily_sales:read.
//
// "Consolidated Daily Sales" is being reserved for a different, not-yet-
// built report; this permission actually gates the report store managers/
// finance already use day to day, so it's renamed to just "Daily Sales".
//
// Safe: role_permissions links to permissions by id, not by the string
// value, so renaming the string on the existing row keeps every role's
// grant intact — nobody loses access. Idempotent (WHERE only matches the
// old string, so rerunning after it's already renamed is a no-op).
//
// Run this BEFORE (or instead of) re-running `npm run seed:new-permissions`
// for this permission — that script only inserts by string match, so if it
// runs first against the OLD name it will insert a second, redundant row
// rather than renaming this one.

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
    const result = await client.query(
      `UPDATE public.permissions
         SET permission = 'report_daily_sales:read',
             description = 'View the Daily Sales report'
       WHERE permission = 'report_consolidated_daily_sales:read'`,
    );
    console.log(
      result.rowCount
        ? 'Renamed report_consolidated_daily_sales:read -> report_daily_sales:read.'
        : 'Already renamed (or never existed) — nothing to do.',
    );
  } finally {
    await client.end();
  }
}

main().catch(error => {
  console.error('Could not rename the Daily Sales permission:', error.message);
  process.exit(1);
});
