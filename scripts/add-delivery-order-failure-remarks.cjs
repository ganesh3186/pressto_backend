require('dotenv').config();

const {Client} = require('pg');

async function addDeliveryOrderFailureRemarks() {
  const client = new Client({
    host: process.env.PG_HOST,
    port: Number(process.env.PG_PORT),
    user: process.env.PG_USER,
    password: process.env.PG_PASSWORD,
    database: process.env.PG_DATABASE,
  });

  await client.connect();
  try {
    await client.query(
      'ALTER TABLE public.delivery_order ADD COLUMN IF NOT EXISTS failureremarks TEXT',
    );
    console.log('delivery_order.failureremarks column is available.');
  } finally {
    await client.end();
  }
}

addDeliveryOrderFailureRemarks().catch(error => {
  console.error('Could not add delivery_order.failureremarks:', error.message);
  process.exit(1);
});
