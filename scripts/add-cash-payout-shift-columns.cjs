require('dotenv').config();

const {Client} = require('pg');

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
    await client.query('ALTER TABLE public.wallet_recharge_request ADD COLUMN IF NOT EXISTS storeid UUID, ADD COLUMN IF NOT EXISTS shiftid UUID');
    await client.query('ALTER TABLE public.sales_return ADD COLUMN IF NOT EXISTS cashshiftid UUID');
    await client.query('ALTER TABLE public.refund_due ADD COLUMN IF NOT EXISTS cashshiftid UUID');
    await client.query('ALTER TABLE public.payment_transaction ADD COLUMN IF NOT EXISTS cashshiftid UUID');
    await client.query('COMMIT');
    console.log('Cash payout shift columns are available.');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    await client.end();
  }
}

migrate().catch((error) => {
  console.error('Could not add cash payout shift columns:', error.message);
  process.exit(1);
});
