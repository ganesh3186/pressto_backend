require('dotenv').config();

const {Client} = require('pg');

// Rider delivery-count columns on public.transfer (PATCH
// /rider/transfers/{id}/status with status=delivered). Idempotent; safe to
// re-run. Column names are the lower-cased property names, matching the
// LoopBack postgres connector's default mapping.
const COLUMNS = [
  ['dispatcheditemcount', 'INTEGER'],
  ['deliveredat', 'TIMESTAMP WITH TIME ZONE'],
  ['deliveredbyriderid', 'UUID'],
  ['delivereditemcount', 'INTEGER'],
  ['deliverycountstatus', 'TEXT'],
  ['deliverydiscrepancyreason', 'TEXT'],
  ['deliverycountreviewrequired', 'BOOLEAN DEFAULT false'],
];

async function migrate() {
  const client = new Client({
    host: process.env.PG_HOST,
    port: Number(process.env.PG_PORT),
    user: process.env.PG_USER,
    password: process.env.PG_PASSWORD,
    database: process.env.PG_DATABASE,
  });
  await client.connect();
  try {
    await client.query('BEGIN');
    for (const [name, type] of COLUMNS) {
      await client.query(`ALTER TABLE public.transfer ADD COLUMN IF NOT EXISTS ${name} ${type}`);
    }
    await client.query('COMMIT');
    console.log('Transfer rider delivery-count columns are available.');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    await client.end();
  }
}

migrate().catch(error => {
  console.error('Could not add transfer rider delivery-count columns:', error.message);
  process.exit(1);
});
