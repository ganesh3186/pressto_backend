require('dotenv').config();

const {Client} = require('pg');

// Order pricing (OrderService.preparePricing) reads coupon_price_override by
// (serviceId, itemId) across every coupon; the only index leads with couponId,
// so that lookup scans the table, which grows to tens of thousands of rows
// with regional price coupons. The name MUST match the `indexes` entry on the
// CouponPriceOverride model: `npm run migrate` drops any index a model does
// not declare.
async function addCouponPriceOverrideIndex() {
  const client = new Client({
    host: process.env.PG_HOST,
    port: Number(process.env.PG_PORT),
    user: process.env.PG_USER,
    password: process.env.PG_PASSWORD,
    database: process.env.PG_DATABASE,
  });

  await client.connect();
  try {
    // CONCURRENTLY keeps the table writable while the index builds; it cannot
    // run inside a transaction, which this script never opens.
    await client.query(
      'CREATE INDEX CONCURRENTLY IF NOT EXISTS "couponPriceOverrideByPair" ' +
        'ON public.coupon_price_override USING btree (serviceid, itemid)',
    );
    console.log('coupon_price_override.couponPriceOverrideByPair is available.');
  } finally {
    await client.end();
  }
}

addCouponPriceOverrideIndex().catch(error => {
  console.error('Could not add coupon_price_override index:', error.message);
  process.exit(1);
});
