require('dotenv').config();

const {Client} = require('pg');

// Found during the go-live performance audit (2026-11-01): both were full
// table scans on every single Manage Order page load. Names MUST match the
// `indexes` entries declared on their models: `npm run migrate` (autoupdate)
// drops any index a model does not declare, so an index created here
// without a model entry would silently vanish on the next migrate.
const INDEXES = [
  // Global-scope staff (no storeId filter) hit `where:{isDeleted:false},
  // order:['createdAt DESC']` with none of the store-scoped composites on
  // `orders` able to help.
  ['orderIsDeletedCreatedAt', 'orders', 'isdeleted, createdat'],
  // listOrders queries approval_request unconditionally, filtered by
  // status + entityType/entityId, against a table with zero indexes.
  ['approvalPendingByEntity', 'approval_request', 'status, entitytype, entityid'],
];

async function addOrderApprovalIndexes() {
  const client = new Client({
    host: process.env.PG_HOST,
    port: Number(process.env.PG_PORT),
    user: process.env.PG_USER,
    password: process.env.PG_PASSWORD,
    database: process.env.PG_DATABASE,
  });

  await client.connect();
  try {
    for (const [name, table, columns] of INDEXES) {
      // CONCURRENTLY avoids locking the table against writes while a large
      // production table (orders, approval_request) builds the index. It
      // cannot run inside a transaction block, which this script never
      // opens (each query auto-commits).
      await client.query(
        `CREATE INDEX CONCURRENTLY IF NOT EXISTS "${name}" ON public.${table} USING btree (${columns})`,
      );
      console.log(`${table}.${name} is available.`);
    }
  } finally {
    await client.end();
  }
}

addOrderApprovalIndexes().catch(error => {
  console.error('Could not add order/approval indexes:', error.message);
  process.exit(1);
});
