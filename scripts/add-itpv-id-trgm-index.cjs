require('dotenv').config();

const {Client} = require('pg');

async function addItpvIdTrgmIndex() {
  const client = new Client({
    host: process.env.PG_HOST,
    port: Number(process.env.PG_PORT),
    user: process.env.PG_USER,
    password: process.env.PG_PASSWORD,
    database: process.env.PG_DATABASE,
  });

  await client.connect();
  try {
    await client.query('CREATE EXTENSION IF NOT EXISTS pg_trgm');
    await client.query(
      'CREATE INDEX CONCURRENTLY IF NOT EXISTS "orderItpvIdTrgm" ' +
        'ON public.orders USING gin (itpvid gin_trgm_ops)',
    );
    console.log('orders.orderItpvIdTrgm is available.');
  } finally {
    await client.end();
  }
}

addItpvIdTrgmIndex().catch(error => {
  console.error('Could not add the QSST ticket ID search index:', error.message);
  process.exit(1);
});
