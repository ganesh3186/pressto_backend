require('dotenv').config();

const {Client} = require('pg');

const candidates = `
  WITH RECURSIVE children AS (
    SELECT child.id
    FROM public.orders child
    JOIN public.orders parent ON child.parentorderid = parent.id
    WHERE parent.isonaccount IS TRUE
    UNION
    SELECT child.id
    FROM public.orders child
    JOIN children parent ON child.parentorderid = parent.id
  )
  SELECT o.id
  FROM public.orders o
  JOIN children c ON c.id = o.id
  WHERE o.isonaccount IS NOT TRUE
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
    const result = await client.query(candidates);
    if (apply && result.rowCount) {
      const updated = await client.query(
        'UPDATE public.orders SET isonaccount = TRUE WHERE id = ANY($1::uuid[])',
        [result.rows.map(row => row.id)],
      );
      if (updated.rowCount !== result.rowCount) {
        throw new Error('Split order count changed during backfill.');
      }
    }
    await client.query(apply ? 'COMMIT' : 'ROLLBACK');
    console.log(`${result.rowCount} split order(s) ${apply ? 'updated' : 'eligible for update (dry run)'}.`);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    await client.end();
  }
}

backfill().catch(error => {
  console.error('Could not backfill split On Account orders:', error.message);
  process.exit(1);
});
