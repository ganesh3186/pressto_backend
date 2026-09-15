import fs from 'fs';
import path from 'path';
import {presstoBackendApplication} from './application';
import * as Repos from './repositories';

/**
 * Service/item catalogue reseeder for the client's revised workbook
 * (`seed-service-items.json`, produced by
 * scripts/migrate-pressto-service-items.cjs from pressto_master_data.xlsx).
 *
 *   npm run seed:pressto-seed
 *
 * Narrower than seed:pressto (seed-pressto.ts) — this ONLY touches the
 * service/item catalogue, never region/cluster/store/country_code or
 * roles/permissions:
 *
 *   - service_item_mapping, service, item: fully CLEARED then replaced —
 *     the client explicitly wants the old catalogue gone, not layered
 *     under the new one (children cleared before parents: mappings, then
 *     services and items). If anything (an existing Order/Garment) still
 *     references an item or service that this reseed renamed or removed,
 *     that reference is left dangling — the migrate script preserves ids
 *     for anything whose NAME is unchanged, which covers most of the
 *     catalogue, but a genuine rename/removal in the new workbook can't
 *     be avoided. Run seed:pressto-seed knowing that.
 *   - service_category, item_category, additional_charge_master: NEVER
 *     cleared, only inserted if missing by id — these are shared/lower
 *     churn and other data may already point at rows here beyond what
 *     this workbook covers.
 *
 * Pass --keep to skip the clear step entirely (insert-if-missing only,
 * for every table here).
 */
// dist/data/*.json, copied there by the build's copy-assets step — see the
// matching note in seed.ts.
const SEED_FILE = path.join(__dirname, 'data/seed-service-items.json');

const CLEARED_TABLES: {table: string; repoClass: unknown}[] = [
  // child-to-parent order for the delete pass
  {table: 'service_item_mapping', repoClass: Repos.ServiceItemMappingRepository},
  {table: 'service', repoClass: Repos.ServiceRepository},
  {table: 'item', repoClass: Repos.ItemRepository},
];
const UPSERT_ONLY_TABLES: {table: string; repoClass: unknown}[] = [
  {table: 'service_category', repoClass: Repos.ServiceCategoryRepository},
  {table: 'item_category', repoClass: Repos.ItemCategoryRepository},
  {table: 'additional_charge_master', repoClass: Repos.AdditionalChargeMasterRepository},
];
// insert order: parents the cleared tables' FKs point at, first
const INSERT_ORDER: {table: string; repoClass: unknown}[] = [
  ...UPSERT_ONLY_TABLES,
  {table: 'item', repoClass: Repos.ItemRepository},
  {table: 'service', repoClass: Repos.ServiceRepository},
  {table: 'service_item_mapping', repoClass: Repos.ServiceItemMappingRepository},
];

async function seedPresstoServiceItems() {
  if (!fs.existsSync(SEED_FILE)) {
    console.error('Seed file not found:', SEED_FILE);
    console.error('Run: node scripts/migrate-pressto-service-items.cjs');
    process.exit(1);
  }
  const data = JSON.parse(fs.readFileSync(SEED_FILE, 'utf8'));

  const app = new presstoBackendApplication();
  await app.boot();
  await app.start();

  if (!process.argv.includes('--keep')) {
    console.log('Clearing existing service/item catalogue (service_item_mapping, service, item)…');
    for (const {table, repoClass} of CLEARED_TABLES) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const repo = (await app.getRepository(repoClass as any)) as any;
      try {
        const res = await repo.deleteAll();
        const removed = res && typeof res.count === 'number' ? res.count : 0;
        console.log(`  ${table.padEnd(24)} cleared: ${removed}`);
      } catch (err) {
        console.error(`  ${table.padEnd(24)} ✗ ${(err as Error).message}`);
      }
    }
    console.log('');
  }

  for (const {table, repoClass} of INSERT_ORDER) {
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

  console.log('Pressto service/item seed complete.');
  await app.stop();
  process.exit(0);
}

seedPresstoServiceItems().catch(err => {
  console.error('Pressto service/item seed failed:', err);
  process.exit(1);
});
