require('dotenv').config();

const {Client} = require('pg');

// Indexes behind the store dashboard endpoints (/dashboard/live, /window,
// /lists). Each name MUST match the `indexes` entry declared on its model:
// `npm run migrate` (autoupdate) drops any index a model does not declare,
// so an index created here without a model entry would silently vanish on
// the next migrate.
const INDEXES = [
  ['orderStoreStatusDeliveryDate', 'orders', 'storeid, status, deliverydate'],
  ['orderStoreCreatedAt', 'orders', 'storeid, createdat'],
  ['orderItemOrderId', 'order_item', 'orderid'],
  ['garmentOrderItemId', 'garment', 'orderitemid'],
  ['paymentTransactionOrderId', 'payment_transaction', 'orderid'],
  ['paymentTransactionPaymentDate', 'payment_transaction', 'paymentdate'],
  ['transferToStoreId', 'transfer', 'tostoreid'],
  ['deliveryStoreStartedAt', 'delivery', 'storeid, startedat'],
  ['deliveryOrderDeliveryId', 'delivery_order', 'deliveryid'],
  ['pickupRequestStoreStatusDate', 'pickup_request', 'storeid, status, requesteddate'],
  [
    'riderCashHandoverStoreStatusConfirmed',
    'rider_cash_handover',
    'handovertostoreid, status, confirmedat',
  ],
];

async function addDashboardIndexes() {
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
      await client.query(
        `CREATE INDEX IF NOT EXISTS "${name}" ON public.${table} USING btree (${columns})`,
      );
      console.log(`${table}.${name} is available.`);
    }
  } finally {
    await client.end();
  }
}

addDashboardIndexes().catch(error => {
  console.error('Could not add dashboard indexes:', error.message);
  process.exit(1);
});
