require('dotenv').config();

const {Client} = require('pg');

// Backfills order_item.servicename/itemname (added alongside the display-
// snapshot fields on the OrderItem model) for rows created before those
// columns existed. Joins against the CURRENT service/item tables, so this
// must run on each environment BEFORE that environment's catalog is changed
// (e.g. before a staging->production catalog reconciliation) — afterward,
// the names it would resolve may no longer match what the order actually
// had at the time.
//
// One bulk UPDATE...FROM rather than a per-row loop — some environments
// (e.g. migration, with ~4.8M order_item rows from the legacy import) are
// far too large for a round trip per row.
const COUNT_CANDIDATES = `
  SELECT count(*) AS n
  FROM public.order_item oi
  JOIN public.service s ON s.id = oi.serviceid
  JOIN public.item i ON i.id = oi.itemid
  WHERE oi.servicename IS NULL OR oi.itemname IS NULL
`;

const APPLY_UPDATE = `
  UPDATE public.order_item oi
  SET servicename = s.name, itemname = i.name
  FROM public.service s, public.item i
  WHERE s.id = oi.serviceid
    AND i.id = oi.itemid
    AND (oi.servicename IS NULL OR oi.itemname IS NULL)
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
    if (!apply) {
      const {rows} = await client.query(COUNT_CANDIDATES);
      console.log(`${rows[0].n} order item(s) eligible for backfill (dry run).`);
      return;
    }
    await client.query('BEGIN');
    const result = await client.query(APPLY_UPDATE);
    await client.query('COMMIT');
    console.log(`${result.rowCount} order item(s) backfilled.`);
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
