require('dotenv').config();
const {Client} = require('pg');

// Challan numbers become per store and per month, like ticket numbers:
// CHL-<store prefix>-<MMYY>-<000001>. Each store/month has one counter row,
// updated atomically, so two tickets saved at the same moment can never get
// the same number. The old global "count + 1" did not hold under concurrency.
// Existing challan numbers (CHL-001888) are unchanged.
async function addChallanNumberSequences() {
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
    await client.query("SELECT pg_advisory_xact_lock(hashtext('pressto.challan-number-migration'))");
    await client.query(`CREATE TABLE IF NOT EXISTS public.challan_number_sequence (
      storeid UUID NOT NULL REFERENCES public.store(id),
      period INTEGER NOT NULL,
      lastnumber BIGINT NOT NULL DEFAULT 0 CHECK (lastnumber >= 0),
      updatedat TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (storeid, period)
    )`);
    // Safe to re-run: start each store's current month after any challan
    // already issued in the new format, and never move a counter backwards.
    await client.query(`WITH monthyear AS (
      SELECT to_char(CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata','MMYY') AS mmyy
    ), numbered AS (
      SELECT substring(c.challannumber from '^CHL-(.+)-[0-9]{4}-[0-9]+$') AS prefix,
        substring(c.challannumber from '([0-9]+)$')::bigint AS sequence
      FROM public.challan c, monthyear
      WHERE c.challannumber ~ ('^CHL-.+-' || monthyear.mmyy || '-[0-9]+$')
    ), maxima AS (
      SELECT prefix, MAX(sequence) AS sequence FROM numbered GROUP BY prefix
    )
    INSERT INTO public.challan_number_sequence AS counter (storeid,period,lastnumber)
    SELECT s.id, to_char(CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata','YYYYMM')::integer,
      COALESCE(m.sequence,0)
    FROM public.store s LEFT JOIN maxima m ON m.prefix=s.storeprefix
    ON CONFLICT (storeid,period) DO UPDATE SET
      lastnumber=GREATEST(counter.lastnumber,EXCLUDED.lastnumber),updatedat=CURRENT_TIMESTAMP`);
    await client.query('COMMIT');
    console.log('Monthly challan sequences initialized. Existing challan numbers are unchanged.');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    await client.end();
  }
}

module.exports = {addChallanNumberSequences};
if (require.main === module) {
  addChallanNumberSequences().catch(error => {
    console.error('Could not initialize monthly challan sequences:', error.message);
    process.exitCode = 1;
  });
}
