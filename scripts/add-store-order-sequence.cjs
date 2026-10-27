require('dotenv').config();

const {Client} = require('pg');

async function addStoreOrderSequence() {
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
    await client.query('ALTER TABLE public.store ADD COLUMN IF NOT EXISTS ordernumbersequence BIGINT NOT NULL DEFAULT 0');
    await client.query(`
      UPDATE public.store s SET ordernumbersequence = GREATEST(s.ordernumbersequence,
        COALESCE((SELECT MAX(substring(o.ordernumber from '-([0-9]+)$')::bigint)
          FROM public.orders o WHERE o.storeid = s.id AND o.ordernumber ~ '-[0-9]+$'), 0))
    `);
    await client.query('COMMIT');
    console.log('Store order sequences are available and backfilled.');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    await client.end();
  }
}

addStoreOrderSequence().catch(error => {
  console.error('Could not add store order sequences:', error.message);
  process.exit(1);
});
