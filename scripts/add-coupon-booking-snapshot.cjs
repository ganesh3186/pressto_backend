require('dotenv').config();

const {Client} = require('pg');

async function addCouponBookingSnapshot() {
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
    await client.query('ALTER TABLE public.coupon_redemption ADD COLUMN IF NOT EXISTS bookingsnapshot JSONB');
    await client.query('ALTER TABLE public.coupon_redemption ADD COLUMN IF NOT EXISTS isprovisional BOOLEAN NOT NULL DEFAULT FALSE');
    // Existing redemptions have no booked coupon rules. Preserve their rupees without inventing rules from today's coupon.
    await client.query(`UPDATE public.coupon_redemption
      SET bookingsnapshot = jsonb_build_object('bookedDiscountAmount', discountamount)
      WHERE bookingsnapshot IS NULL`);
    await client.query(`WITH moved AS (
      UPDATE public.coupon_redemption redemption
      SET isprovisional = TRUE
      FROM public.orders ticket
      WHERE ticket.id::text = redemption.orderid::text AND ticket.status = 'draft'
        AND redemption.isreversed = FALSE AND redemption.isprovisional = FALSE
      RETURNING redemption.couponid
    ), counts AS (
      SELECT couponid, COUNT(*) AS uses FROM moved GROUP BY couponid
    )
    UPDATE public.coupon coupon
    SET totalusescount = GREATEST(0, COALESCE(coupon.totalusescount, 0) - counts.uses)
    FROM counts WHERE coupon.id::text = counts.couponid::text`);
    await client.query('COMMIT');
    console.log('Coupon booking snapshots are available.');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    await client.end();
  }
}

module.exports = {addCouponBookingSnapshot};

if (require.main === module)
  addCouponBookingSnapshot().catch(error => {
    console.error('Could not add coupon booking snapshots:', error.message);
    process.exit(1);
  });
