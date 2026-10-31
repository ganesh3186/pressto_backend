require('dotenv').config();

const {Client} = require('pg');

// Manage Ticket's invoice-number search (invoice.controller.ts/order.service.ts)
// uses ILIKE '%q%', which only a trigram index can serve — confirmed via
// EXPLAIN ANALYZE as a ~6s full sequential scan on 1.97M rows without it.
// `npm run migrate` (autoupdate) doesn't reliably create this one even
// though the model declares it (same as the composite/GIN indexes in
// add-dashboard-indexes.cjs) — the model entry only stops autoupdate from
// dropping it once it exists, so this script is what actually creates it.
async function addInvoiceNumberTrgmIndex() {
  const client = new Client({
    host: process.env.PG_HOST,
    port: Number(process.env.PG_PORT),
    user: process.env.PG_USER,
    password: process.env.PG_PASSWORD,
    database: process.env.PG_DATABASE,
  });

  await client.connect();
  try {
    await client.query('CREATE EXTENSION IF NOT EXISTS pg_trgm');
    // CONCURRENTLY avoids locking invoice against writes while a table this
    // size (1.97M rows) builds the index. Cannot run inside a transaction
    // block, which this script never opens (each query auto-commits).
    await client.query(
      'CREATE INDEX CONCURRENTLY IF NOT EXISTS "invoiceNumberTrgm" ' +
        'ON public.invoice USING gin (invoicenumber gin_trgm_ops)',
    );
    console.log('invoice.invoiceNumberTrgm is available.');
  } finally {
    await client.end();
  }
}

addInvoiceNumberTrgmIndex().catch(error => {
  console.error('Could not add invoice number trigram index:', error.message);
  process.exit(1);
});
