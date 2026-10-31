require('dotenv').config();
const {Client} = require('pg');

async function addTicketNumberSequences() {
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
    await client.query("SELECT pg_advisory_xact_lock(hashtext('pressto.ticket-number-migration'))");
    await client.query(`CREATE TABLE IF NOT EXISTS public.ticket_number_sequence (
      storeid UUID NOT NULL REFERENCES public.store(id),
      period INTEGER NOT NULL,
      lastnumber BIGINT NOT NULL DEFAULT 0 CHECK (lastnumber >= 0),
      updatedat TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (storeid, period)
    )`);
    // Match the issued prefix rather than the order's current store: transferred
    // orders must still reserve their numbers in the originating store's series.
    await client.query(`WITH numbered AS (
      SELECT regexp_replace(ordernumber,'-[0-9]{4}-[0-9]+$','') AS prefix,
        substring(ordernumber from '([0-9]+)$')::bigint AS sequence
      FROM public.orders
      WHERE ordernumber ~ ('^.+-' || to_char(CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata','MMYY') || '-[0-9]+$')
    ), maxima AS (
      SELECT prefix,MAX(sequence) AS sequence FROM numbered GROUP BY prefix
    )
    INSERT INTO public.ticket_number_sequence AS counter (storeid,period,lastnumber)
    SELECT s.id,to_char(CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata','YYYYMM')::integer,
      COALESCE(m.sequence,0)
    FROM public.store s LEFT JOIN maxima m ON m.prefix=s.storeprefix
    ON CONFLICT (storeid,period) DO UPDATE SET
      lastnumber=GREATEST(counter.lastnumber,EXCLUDED.lastnumber),updatedat=CURRENT_TIMESTAMP`);
    await client.query('COMMIT');
    console.log('Monthly ticket sequences initialized. Existing ticket IDs are unchanged.');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    await client.end();
  }
}

module.exports = {addTicketNumberSequences};
if (require.main === module) {
  addTicketNumberSequences().catch(error => {
    console.error('Could not initialize monthly ticket sequences:', error.message);
    process.exitCode = 1;
  });
}
