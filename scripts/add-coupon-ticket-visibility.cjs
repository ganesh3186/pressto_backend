require('dotenv').config();

const {Client} = require('pg');

async function addCouponTicketVisibility() {
  const client = new Client({
    host: process.env.PG_HOST,
    port: Number(process.env.PG_PORT),
    user: process.env.PG_USER,
    password: process.env.PG_PASSWORD,
    database: process.env.PG_DATABASE,
  });
  await client.connect();
  try {
    const column = await client.query(
      "SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'coupon' AND column_name = 'hidefromticketlist'",
    );
    if (!column.rowCount)
      await client.query('ALTER TABLE public.coupon ADD COLUMN IF NOT EXISTS hidefromticketlist BOOLEAN NOT NULL DEFAULT FALSE');
    console.log('Coupon ticket visibility is available.');
  } finally {
    await client.end();
  }
}

module.exports = {addCouponTicketVisibility};

if (require.main === module)
  addCouponTicketVisibility().catch(error => {
    console.error('Could not add coupon ticket visibility:', error.message);
    process.exit(1);
  });
