require('dotenv').config();

const {Client} = require('pg');

async function addStorePrefixLock() {
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
    await client.query('ALTER TABLE public.store ADD COLUMN IF NOT EXISTS isprefixlocked BOOLEAN NOT NULL DEFAULT FALSE');
    await client.query(`
      UPDATE public.store s SET isprefixlocked = TRUE
      WHERE EXISTS (SELECT 1 FROM public.orders o WHERE o.storeid = s.id)
    `);
    await client.query('COMMIT');
    console.log('Store prefix locks are available and existing orders are backfilled.');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    await client.end();
  }
}

addStorePrefixLock().catch(error => {
  console.error('Could not add store prefix locks:', error.message);
  process.exit(1);
});
