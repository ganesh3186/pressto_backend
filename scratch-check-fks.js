const { Client } = require('pg');
const client = new Client({ host: 'localhost', port: 5432, user: 'postgres', password: 'Postgres@123', database: 'pressto' });

async function main() {
  await client.connect();
  const res = await client.query(`
    select
      tc.table_name as child_table,
      kcu.column_name as child_column,
      ccu.table_name as parent_table,
      ccu.column_name as parent_column
    from information_schema.table_constraints tc
    join information_schema.key_column_usage kcu on tc.constraint_name = kcu.constraint_name
    join information_schema.constraint_column_usage ccu on tc.constraint_name = ccu.constraint_name
    where tc.constraint_type = 'FOREIGN KEY'
      and ccu.table_name in ('service','item','service_item_mapping','item_category','service_category','store','cluster','region','additional_charge_master')
    order by parent_table, child_table;
  `);
  console.log('FK constraints referencing seed-master tables:', JSON.stringify(res.rows, null, 2));

  // Counts of transactional data that would reference these masters
  const counts = await client.query(`
    select
      (select count(*) from public.orders) as orders,
      (select count(*) from public.order_item) as order_items,
      (select count(*) from public.garment) as garments,
      (select count(*) from public.service_item_mapping) as service_item_mappings,
      (select count(*) from public.sales_return) as sales_returns,
      (select count(*) from public.challan) as challans,
      (select count(*) from public.invoice) as invoices,
      (select count(*) from public.approval_request) as approval_requests
  `);
  console.log('Current row counts:', counts.rows[0]);

  await client.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
