require('dotenv').config();

const {Client} = require('pg');

async function dropLegacyPickupDeliveryIndex() {
  const client = new Client({
    host: process.env.PG_HOST,
    port: Number(process.env.PG_PORT),
    user: process.env.PG_USER,
    password: process.env.PG_PASSWORD,
    database: process.env.PG_DATABASE,
  });

  await client.connect();
  try {
    // Actual order delivery types may repeat when distinct pickup tiers are confirmed at the same speed.
    await client.query('DROP INDEX CONCURRENTLY IF EXISTS public."uniquePickupDeliveryType"');
    const {rows} = await client.query(
      "SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'uniquePickupDeliveryType'",
    );
    if (rows.length) throw new Error('Legacy pickup delivery index still exists.');
    console.log('Pickup orders can now share an actual delivery type.');
  } finally {
    await client.end();
  }
}

dropLegacyPickupDeliveryIndex().catch(error => {
  console.error('Could not update pickup order indexes:', error.message);
  process.exit(1);
});
