/* eslint-disable */
/**
 * DESTRUCTIVE. Empties the master tables the pressto migration targets, so the
 * migrated data can be seeded into a clean slate.
 *
 *   node scripts/wipe-master-tables.cjs --yes
 *
 * ⚠ This removes ALL rows in these tables — including any pre-existing/test
 * masters. Operational rows that reference them (orders, order items, garments,
 * store-service mappings, price overrides) are NOT deleted and will be left
 * pointing at ids that no longer exist.
 *
 * Deletion runs in reverse-dependency order (mappings → items/services →
 * stores → clusters → regions).
 */
const path = require('path');
const {presstoBackendApplication} = require(path.resolve(__dirname, '../dist/application'));
const Repos = require(path.resolve(__dirname, '../dist/repositories'));

const TABLES = [
  ['service_item_mapping', 'ServiceItemMappingRepository'],
  ['additional_charge_master', 'AdditionalChargeMasterRepository'],
  ['item', 'ItemRepository'],
  ['item_category', 'ItemCategoryRepository'],
  ['service', 'ServiceRepository'],
  ['service_category', 'ServiceCategoryRepository'],
  ['store', 'StoreRepository'],
  ['cluster', 'ClusterRepository'],
  ['region', 'RegionRepository'],
];

if (!process.argv.includes('--yes')) {
  console.error('Refusing to run without --yes (this deletes every row in 9 master tables).');
  console.error('  node scripts/wipe-master-tables.cjs --yes');
  process.exit(1);
}

(async () => {
  const app = new presstoBackendApplication();
  await app.boot();
  await app.start();

  let totalDeleted = 0;
  for (const [table, repoName] of TABLES) {
    const repo = await app.getRepository(Repos[repoName]);
    const before = (await repo.count()).count;
    try {
      const res = await repo.deleteAll();
      const removed = res && typeof res.count === 'number' ? res.count : before;
      totalDeleted += removed;
      const after = (await repo.count()).count;
      console.log(`  ${table.padEnd(26)} deleted: ${String(removed).padStart(4)}   remaining: ${after}`);
    } catch (err) {
      console.error(`  ${table.padEnd(26)} ✗ ${err.message}`);
    }
  }

  console.log(`\nTotal rows deleted: ${totalDeleted}`);
  await app.stop();
  process.exit(0);
})().catch(err => {
  console.error('Wipe failed:', err.message);
  process.exit(1);
});
