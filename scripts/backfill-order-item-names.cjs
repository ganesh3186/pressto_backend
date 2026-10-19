require('dotenv').config();

const {Client} = require('pg');

// Backfills order_item.servicename/itemname (added alongside the display-
// snapshot fields on the OrderItem model) for rows created before those
// columns existed. Joins against the CURRENT service/item tables, so this
// must run on each environment BEFORE that environment's catalog is changed
// (e.g. before a staging->production catalog reconciliation) — afterward,
// the names it would resolve may no longer match what the order actually
// had at the time.
const CANDIDATES = `
  SELECT oi.id AS orderitemid, s.name AS servicename, i.name AS itemname
  FROM public.order_item oi
  JOIN public.service s ON s.id = oi.serviceid
  JOIN public.item i ON i.id = oi.itemid
  WHERE oi.servicename IS NULL OR oi.itemname IS NULL
`;

async function backfill() {
  const apply = process.argv.includes('--apply');
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
    const {rows} = await client.query(`${CANDIDATES} FOR UPDATE OF oi`);
    if (apply) {
      for (const row of rows) {
        await client.query(
          'UPDATE public.order_item SET servicename = $1, itemname = $2 WHERE id = $3',
          [row.servicename, row.itemname, row.orderitemid],
        );
      }
    }
    await client.query(apply ? 'COMMIT' : 'ROLLBACK');
    console.log(`${rows.length} order item(s) ${apply ? 'backfilled' : 'eligible for backfill (dry run)'}.`);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    await client.end();
  }
}

backfill().catch(error => {
  console.error('Could not backfill order item names:', error.message);
  process.exit(1);
});
