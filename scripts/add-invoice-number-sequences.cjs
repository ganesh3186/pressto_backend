require('dotenv').config();
const {Client} = require('pg');

/** Seed counters only; existing invoices and ticket sequences are never rewritten. */
async function addInvoiceNumberSequences() {
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
    await client.query("SELECT pg_advisory_xact_lock(hashtext('pressto.invoice-number-migration'))");
    await client.query(`CREATE TABLE IF NOT EXISTS public.invoice_number_sequence (
      storeid UUID NOT NULL REFERENCES public.store(id),
      financialyear INTEGER NOT NULL,
      lastnumber BIGINT NOT NULL DEFAULT 0 CHECK (lastnumber >= 0),
      updatedat TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (storeid, financialyear)
    )`);
    const {rows} = await client.query(`SELECT
      EXTRACT(YEAR FROM CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')::int -
      CASE WHEN EXTRACT(MONTH FROM CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata') < 4 THEN 1 ELSE 0 END AS year`);
    const financialYear = rows[0].year;
    await client.query(`WITH period_invoices AS (
      SELECT invoicenumber, orderid FROM public.invoice
      WHERE createdat >= make_timestamptz($1,4,1,0,0,0,'Asia/Kolkata')
        AND createdat < make_timestamptz($1+1,4,1,0,0,0,'Asia/Kolkata')
    ), numbered AS (
      SELECT CASE WHEN invoicenumber ~ '^[^/]+/[0-9]+$'
        THEN split_part(invoicenumber,'/',1)
        ELSE regexp_replace(invoicenumber,'-[0-9]{4}-[0-9]+$','') END AS series,
        invoicenumber ~ '^[^/]+/[0-9]+$' AS legacy,
        substring(invoicenumber from '([0-9]+)$')::bigint AS sequence
      FROM period_invoices
      WHERE invoicenumber ~ '^[^/]+/[0-9]+$' OR invoicenumber ~ '^.+-[0-9]{4}-[0-9]+$'
    ), maxima AS (
      SELECT series,legacy,MAX(sequence) AS sequence FROM numbered GROUP BY series,legacy
    ), previous_application_numbers AS (
      SELECT o.storeid,MAX(substring(i.invoicenumber from '([0-9]+)$')::bigint) AS sequence
      FROM period_invoices i JOIN public.orders o ON o.id=i.orderid
      WHERE i.invoicenumber ~ '^INV-[0-9]{6}-[0-9]+$' GROUP BY o.storeid
    )
    INSERT INTO public.invoice_number_sequence AS counter (storeid,financialyear,lastnumber)
    SELECT s.id,$1,GREATEST(COALESCE(MAX(m.sequence),0),COALESCE(MAX(p.sequence),0))
    FROM public.store s
    LEFT JOIN maxima m ON (m.legacy AND m.series=s.code) OR (NOT m.legacy AND m.series=s.storeprefix)
    LEFT JOIN previous_application_numbers p ON p.storeid=s.id
    GROUP BY s.id
    ON CONFLICT (storeid,financialyear) DO UPDATE
      SET lastnumber=GREATEST(counter.lastnumber,EXCLUDED.lastnumber),updatedat=CURRENT_TIMESTAMP`, [financialYear]);
    await client.query('COMMIT');
    console.log(`Invoice sequences are available for financial year ${financialYear}-${financialYear + 1}. Existing invoices are unchanged.`);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    await client.end();
  }
}

module.exports = {addInvoiceNumberSequences};
if (require.main === module) {
  addInvoiceNumberSequences().catch(error => {
    console.error('Could not initialize invoice sequences:', error.message);
    process.exitCode = 1;
  });
}
