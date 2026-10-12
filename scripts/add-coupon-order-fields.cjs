require('dotenv').config();

const {Client} = require('pg');

async function addCouponOrderFields() {
  const client = new Client({
    host: process.env.PG_HOST,
    port: Number(process.env.PG_PORT),
    user: process.env.PG_USER,
    password: process.env.PG_PASSWORD,
    database: process.env.PG_DATABASE,
  });

  await client.connect();
  try {
    // Order creation reads Coupon rows even when no coupon code was entered.
    // Older databases may lack fields added to the Coupon model since the
    // last schema migration, causing every checkout to fail with a 500.
    await client.query(`
      ALTER TABLE public.coupon
        ADD COLUMN IF NOT EXISTS minrequirementtype TEXT,
        ADD COLUMN IF NOT EXISTS minrequirementvalue NUMERIC,
        ADD COLUMN IF NOT EXISTS newcustomerorderlimit INTEGER
    `);
    console.log('Coupon order fields are available.');
  } finally {
    await client.end();
  }
}

addCouponOrderFields().catch(error => {
  console.error('Could not add coupon order fields:', error.message);
  process.exit(1);
});
