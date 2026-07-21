/* eslint-disable */
/**
 * READ-ONLY. Counts rows in the master tables the pressto migration touches, plus
 * the operational tables that reference them, so we can see what a delete would hit.
 *
 *   node scripts/inspect-master-tables.cjs
 */
const path = require('path');
const {presstoBackendApplication} = require(path.resolve(__dirname, '../dist/application'));
const Repos = require(path.resolve(__dirname, '../dist/repositories'));
const seed = require(path.resolve(__dirname, '../src/data/seed-masters-pressto.json'));

const TABLES = [
  ['region', 'RegionRepository'],
  ['cluster', 'ClusterRepository'],
  ['store', 'StoreRepository'],
  ['service_category', 'ServiceCategoryRepository'],
  ['item_category', 'ItemCategoryRepository'],
  ['item', 'ItemRepository'],
  ['service', 'ServiceRepository'],
  ['additional_charge_master', 'AdditionalChargeMasterRepository'],
  ['service_item_mapping', 'ServiceItemMappingRepository'],
];

// Operational data that would be orphaned by a blanket wipe.
const OPERATIONAL = [
  ['order', 'OrderRepository'],
  ['order_item', 'OrderItemRepository'],
  ['garment', 'GarmentRepository'],
  ['store_service_mapping', 'StoreServiceMappingRepository'],
  ['store_price_override', 'StorePriceOverrideRepository'],
  ['cluster_price_list', 'ClusterPriceListRepository'],
  ['price_list', 'PriceListRepository'],
];

(async () => {
  const app = new presstoBackendApplication();
  await app.boot();
  await app.start();

  console.log('\n── Master tables (targets of the migration) ──');
  console.log('  table                     total   fromThisMigration   other');
  for (const [table, repoName] of TABLES) {
    const repo = await app.getRepository(Repos[repoName]);
    const total = (await repo.count()).count;
    const ids = new Set((seed[table] || []).map(r => r.id));
    let mine = 0;
    if (ids.size) {
      const rows = await repo.find({fields: {id: true}});
      rows.forEach(r => {
        if (ids.has(String(r.id))) mine += 1;
      });
    }
    console.log(
      '  ' + table.padEnd(26) + String(total).padStart(5) + String(mine).padStart(18) + String(total - mine).padStart(8),
    );
  }

  console.log('\n── Operational data that references these masters ──');
  for (const [table, repoName] of OPERATIONAL) {
    try {
      const repo = await app.getRepository(Repos[repoName]);
      const total = (await repo.count()).count;
      console.log('  ' + table.padEnd(26) + String(total).padStart(5));
    } catch (e) {
      console.log('  ' + table.padEnd(26) + '  (n/a)');
    }
  }

  await app.stop();
  process.exit(0);
})().catch(err => {
  console.error('Inspect failed:', err.message);
  process.exit(1);
});
