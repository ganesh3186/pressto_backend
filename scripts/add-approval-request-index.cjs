require('dotenv').config();

const {Client} = require('pg');

// listOrders (order.service.ts) queries approval_request unconditionally on
// every Manage Order page load, filtered by status + entityType/entityId,
// against a table with zero indexes — a full sequential scan. Found during
// the go-live performance audit (2026-11-01). Name MUST match the `indexes`
// entry declared on the model: `npm run migrate` (autoupdate) drops any
// index a model does not declare, so an index created here without a model
// entry would silently vanish on the next migrate.
async function addApprovalRequestIndex() {
  const client = new Client({
    host: process.env.PG_HOST,
    port: Number(process.env.PG_PORT),
    user: process.env.PG_USER,
    password: process.env.PG_PASSWORD,
    database: process.env.PG_DATABASE,
  });

  await client.connect();
  try {
    // CONCURRENTLY avoids locking approval_request against writes while the
    // index builds. Cannot run inside a transaction block, which this
    // script never opens (each query auto-commits).
    await client.query(
      'CREATE INDEX CONCURRENTLY IF NOT EXISTS "approvalPendingByEntity" ' +
        'ON public.approval_request USING btree (status, entitytype, entityid)',
    );
    console.log('approval_request.approvalPendingByEntity is available.');
  } finally {
    await client.end();
  }
}

addApprovalRequestIndex().catch(error => {
  console.error('Could not add approval_request index:', error.message);
  process.exit(1);
});
