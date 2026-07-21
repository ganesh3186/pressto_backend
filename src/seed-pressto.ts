import fs from 'fs';
import path from 'path';
import {presstoBackendApplication} from './application';
import * as Repos from './repositories';

/**
 * Masters-only seeder for the client migration (`seed-masters-pressto.json`,
 * produced by scripts/migrate-pressto-masters.cjs).
 *
 *   npm run seed:pressto
 *
 * It does NOT touch roles/permissions — we keep our own RBAC. Records are inserted
 * by id only if not already present, so it is safe to re-run. Tables are seeded in
 * FK order (region → cluster → store; category → item; service).
 */
const SEED_FILE = path.join(__dirname, '../src/data/seed-masters-pressto.json');

// (table key in the JSON, repository) in dependency order.
const TABLES: {table: string; repoClass: unknown}[] = [
  {table: 'region', repoClass: Repos.RegionRepository},
  {table: 'cluster', repoClass: Repos.ClusterRepository},
  {table: 'store', repoClass: Repos.StoreRepository},
  {table: 'service_category', repoClass: Repos.ServiceCategoryRepository},
  {table: 'item_category', repoClass: Repos.ItemCategoryRepository},
  {table: 'item', repoClass: Repos.ItemRepository},
  {table: 'service', repoClass: Repos.ServiceRepository},
  {table: 'additional_charge_master', repoClass: Repos.AdditionalChargeMasterRepository},
  {table: 'service_item_mapping', repoClass: Repos.ServiceItemMappingRepository},
];

async function seedPresstoMasters() {
  if (!fs.existsSync(SEED_FILE)) {
    console.error('Seed file not found:', SEED_FILE);
    console.error('Run: node scripts/migrate-pressto-masters.cjs');
    process.exit(1);
  }
  const data = JSON.parse(fs.readFileSync(SEED_FILE, 'utf8'));

  const app = new presstoBackendApplication();
  await app.boot();
  await app.start();

  // Empty the master tables first so each run replaces the previous data instead
  // of layering on top of it. Children are cleared before parents.
  // Pass --keep to skip this and only insert what's missing.
  if (!process.argv.includes('--keep')) {
    console.log('Clearing existing master data…');
    for (const {table, repoClass} of [...TABLES].reverse()) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const repo = (await app.getRepository(repoClass as any)) as any;
      try {
        const res = await repo.deleteAll();
        const removed = res && typeof res.count === 'number' ? res.count : 0;
        if (removed) console.log(`  ${table.padEnd(24)} cleared: ${removed}`);
      } catch (err) {
        console.error(`  ${table.padEnd(24)} ✗ ${(err as Error).message}`);
      }
    }
    console.log('');
  }

  for (const {table, repoClass} of TABLES) {
    const rows = data[table];
    if (!Array.isArray(rows) || !rows.length) {
      console.log(`  ${table.padEnd(22)} — no rows, skipped`);
      continue;
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const repo = (await app.getRepository(repoClass as any)) as any;
    let inserted = 0;
    let skipped = 0;
    for (const record of rows) {
      try {
        const exists = record.id ? await repo.findOne({where: {id: record.id}}) : null;
        if (exists) {
          skipped += 1;
          continue;
        }
        await repo.create(record);
        inserted += 1;
      } catch (err) {
        console.error(`    ✗ ${table} (id: ${record.id}):`, (err as Error).message);
      }
    }
    console.log(`  ${table.padEnd(22)} inserted: ${inserted}, skipped: ${skipped}`);
  }

  console.log('Pressto master seed complete.');
  await app.stop();
  process.exit(0);
}

seedPresstoMasters().catch(err => {
  console.error('Pressto seed failed:', err);
  process.exit(1);
});
