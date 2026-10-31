require('dotenv').config();
const {Client} = require('pg');

async function addGarmentTagSequence() {
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
    // Allocators take the shared form of this lock, including inside order
    // transactions. Synchronization waits for them and cannot rewind an allocation.
    await client.query("SELECT pg_advisory_xact_lock(hashtext('pressto.garment-tag-sequence'))");
    await client.query(`CREATE SEQUENCE IF NOT EXISTS public.garment_tag_seq
      AS bigint INCREMENT BY 1 MINVALUE 1 START WITH 1 CACHE 1 NO CYCLE`);
    const {rows} = await client.query(`SELECT
      MAX(substring(garmenttagnumber FROM 3)::bigint)::text AS maximum
      FROM public.garment WHERE garmenttagnumber ~ '^GT[0-9]+$'`);
    const state = (await client.query('SELECT last_value::text AS value,is_called FROM public.garment_tag_seq')).rows[0];
    const maximum = BigInt(rows[0].maximum ?? '0');
    const current = BigInt(state.value);
    if (maximum > current || (maximum === current && !state.is_called)) {
      await client.query("SELECT setval('public.garment_tag_seq',$1::bigint,true)", [maximum.toString()]);
    }
    await client.query('COMMIT');
    console.log('Garment tag sequence synchronized with existing tags. No garment records changed.');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    await client.end();
  }
}

module.exports = {addGarmentTagSequence};
if (require.main === module) {
  addGarmentTagSequence().catch(error => {
    console.error('Could not initialize garment tag sequence:', error.message);
    process.exitCode = 1;
  });
}
