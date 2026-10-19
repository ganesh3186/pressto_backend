require('dotenv').config();

const {randomUUID} = require('node:crypto');
const {Client} = require('pg');

const CANDIDATES = `
  SELECT g.id AS garmentid, a.id AS requestid, action.performedby
  FROM public.garment g
  JOIN LATERAL (
    SELECT id, type, status, createdat
    FROM public.approval_request
    WHERE entitytype = 'garment' AND entityid = g.id
    ORDER BY createdat DESC, id DESC
    LIMIT 1
  ) a ON true
  LEFT JOIN LATERAL (
    SELECT performedby
    FROM public.approval_action
    WHERE approvalrequestid = a.id AND action = 'approved'
    ORDER BY actiondate DESC, id DESC
    LIMIT 1
  ) action ON true
  WHERE g.status = 'on_hold'
    AND g.isdeleted IS NOT TRUE
    AND a.type = 'item_damaged'
    AND a.status = 'approved'
    AND NOT EXISTS (
      SELECT 1 FROM public.approval_request pending
      WHERE pending.entitytype = 'garment'
        AND pending.entityid = g.id
        AND pending.status = 'pending'
    )
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
    const {rows} = await client.query(`${CANDIDATES} FOR UPDATE OF g`);
    if (apply) {
      for (const row of rows) {
        // Keep the current status guard so repeating this command is safe.
        const updated = await client.query(
          "UPDATE public.garment SET status = 'damaged', updatedat = NOW() WHERE id = $1 AND status = 'on_hold' RETURNING id",
          [row.garmentid],
        );
        if (!updated.rowCount) continue;
        await client.query(
          `INSERT INTO public.garment_status_history
             (id, garmentid, status, changedat, changedby, remarks)
           VALUES ($1, $2, 'damaged', NOW(), $3, $4)`,
          [randomUUID(), row.garmentid, row.performedby, `Backfilled approved damage request ${row.requestid}`],
        );
      }
    }
    await client.query(apply ? 'COMMIT' : 'ROLLBACK');
    console.log(`${rows.length} approved damage garment(s) ${apply ? 'corrected' : 'eligible for correction (dry run)'}.`);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    await client.end();
  }
}

backfill().catch(error => {
  console.error('Could not backfill approved damaged garments:', error.message);
  process.exit(1);
});
