require('dotenv').config();

const {Client} = require('pg');

// PickupRequest now records why and by whom a pickup was cancelled. Without
// these columns every pickup_request query fails, so run this before the build.
const COLUMNS = [
  ['cancellationreason', 'TEXT'],
  ['cancellationotherreason', 'TEXT'],
  ['cancelledat', 'TIMESTAMP WITH TIME ZONE'],
  ['cancelledby', 'UUID'],
];

async function addPickupCancellationColumns() {
  const client = new Client({
    host: process.env.PG_HOST,
    port: Number(process.env.PG_PORT),
    user: process.env.PG_USER,
    password: process.env.PG_PASSWORD,
    database: process.env.PG_DATABASE,
  });

  await client.connect();
  try {
    for (const [column, type] of COLUMNS) {
      await client.query(`ALTER TABLE public.pickup_request ADD COLUMN IF NOT EXISTS ${column} ${type}`);
      console.log(`pickup_request.${column} column is available.`);
    }
  } finally {
    await client.end();
  }
}

addPickupCancellationColumns().catch(error => {
  console.error('Could not add pickup cancellation columns:', error.message);
  process.exit(1);
});
