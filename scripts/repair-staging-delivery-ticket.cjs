require('dotenv').config();

const {randomUUID} = require('node:crypto');
const {Client} = require('pg');

const ORDER_ID = '70e3b63f-88af-493d-9c40-881887b65eb7';
const ORDER_NUMBER = 'ST036-1026-0506';
const TAGS = ['GT00031432', 'GT00031433'];

async function repair() {
  const apply = process.argv.includes('--apply');
  if (apply && process.env.PG_DATABASE !== 'pressto') {
    throw new Error('Expected the staging database named pressto.');
  }
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
    const {rows: [order]} = await client.query(
      'SELECT ordernumber, status FROM public.orders WHERE id = $1 FOR UPDATE', [ORDER_ID]);
    if (order?.ordernumber !== ORDER_NUMBER || order.status !== 'delivered') {
      throw new Error('The expected delivered staging ticket was not found.');
    }
    const {rows: garments} = await client.query(`
      SELECT g.id, g.garmenttagnumber, g.status
      FROM public.garment g
      JOIN public.order_item oi ON oi.id = g.orderitemid
      WHERE oi.orderid = $1 AND g.isdeleted IS NOT TRUE
      ORDER BY g.garmenttagnumber
      FOR UPDATE OF g
    `, [ORDER_ID]);
    if (garments.length !== TAGS.length ||
        garments.some((g, index) => g.garmenttagnumber !== TAGS[index] ||
          !['ready', 'delivered'].includes(g.status))) {
      throw new Error('Garment tags or statuses changed; inspect the ticket before repairing it.');
    }
    const {rows: [delivery]} = await client.query(`
      SELECT changedby FROM public.order_status_history
      WHERE orderid = $1 AND status = 'delivered'
      ORDER BY changedat DESC LIMIT 1
    `, [ORDER_ID]);
    if (!delivery) throw new Error('Delivered status history is missing.');

    const pending = garments.filter(g => g.status === 'ready');
    if (apply) {
      for (const garment of pending) {
        await client.query("UPDATE public.garment SET status = 'delivered', updatedat = NOW() WHERE id = $1", [garment.id]);
        await client.query(`
          INSERT INTO public.garment_status_history
            (id, garmentid, status, changedat, changedby, remarks)
          VALUES ($1, $2, 'delivered', NOW(), $3, $4)
        `, [randomUUID(), garment.id, delivery.changedby,
          `Backfilled delivered status for ticket ${ORDER_NUMBER}`]);
      }
    }
    await client.query(apply ? 'COMMIT' : 'ROLLBACK');
    console.log(`${pending.length} garment(s) ${apply ? 'repaired' : 'ready for repair (dry run)'}.`);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    await client.end();
  }
}

repair().catch(error => {
  console.error('Could not repair staging delivery ticket:', error.message);
  process.exitCode = 1;
});
