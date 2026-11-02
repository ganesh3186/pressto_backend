require('dotenv').config();

const {Client} = require('pg');

// Manage Invoice looks up consolidated invoices on every page for a
// store-limited caller (invoice.controller.ts's _invoiceListScope). Without this
// index each lookup scans all 1.97M invoices (~1s, EXPLAIN ANALYZE). Run this
// BEFORE deploying that code, and before `npm run migrate`, which would otherwise
// build it without CONCURRENTLY and block writes to invoice while it runs.
async function addInvoiceConsolidatedIndex() {
  const client = new Client({
    host: process.env.PG_HOST,
    port: Number(process.env.PG_PORT),
    user: process.env.PG_USER,
    password: process.env.PG_PASSWORD,
    database: process.env.PG_DATABASE,
  });

  await client.connect();
  try {
    // CONCURRENTLY avoids locking invoice against writes while a table this
    // size (1.97M rows) builds the index. Cannot run inside a transaction
    // block, which this script never opens (each query auto-commits).
    await client.query(
      'CREATE INDEX CONCURRENTLY IF NOT EXISTS "invoiceIsConsolidated" ' +
        'ON public.invoice (isconsolidated)',
    );
    console.log('invoice.invoiceIsConsolidated is available.');
  } finally {
    await client.end();
  }
}

addInvoiceConsolidatedIndex().catch(error => {
  console.error('Could not add invoice consolidated index:', error.message);
  process.exit(1);
});
