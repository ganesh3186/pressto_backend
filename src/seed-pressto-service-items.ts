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
 *     cleared, matched by `code` (their real unique key) rather than id —
 *     a target DB can already have rows here from an earlier seed run OR
 *     added by hand through the admin panel, under a DIFFERENT id than
 *     whatever this JSON generated locally. Matching by id alone (the
 *     first version of this script did) tries to INSERT a second row
 *     with a colliding code, which Postgres rejects — and worse, leaves
 *     any item/service that pointed at the intended id referencing a row
 *     that was never actually created. Matching by code instead: if a
 *     row with that code already exists, its id is REUSED for item/
 *     service foreign keys below rather than inserting a duplicate.
 *
 * Pass --keep to skip the clear step entirely (still runs the code-match/
 * remap step; item/service/service_item_mapping are then inserted only
 * where missing by id, same as before, but now against the remapped
 * category ids).
 */
// dist/data/*.json, copied there by the build's copy-assets step — see the
// matching note in seed.ts.
const SEED_FILE = path.join(__dirname, 'data/seed-service-items.json');

interface SeedRecord {
  id: string;
  code?: string;
  [key: string]: unknown;
}

async function upsertByCode(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  repo: any,
  table: string,
  rows: SeedRecord[],
): Promise<Map<string, string>> {
  // jsonId -> the id actually used in the DB (its own, or an existing row's)
  const idRemap = new Map<string, string>();
  let inserted = 0;
  let matchedExisting = 0;
  for (const record of rows) {
    const existing = record.code ? await repo.findOne({where: {code: record.code}}) : null;
    if (existing) {
      idRemap.set(record.id, existing.id);
      matchedExisting += 1;
      continue;
    }
    try {
      await repo.create(record);
      idRemap.set(record.id, record.id);
      inserted += 1;
    } catch (err) {
      console.error(`    ✗ ${table} (code: ${record.code}):`, (err as Error).message);
    }
  }
  console.log(`  ${table.padEnd(22)} inserted: ${inserted}, matched existing: ${matchedExisting}`);
  return idRemap;
}

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
    const clearOrder: {table: string; repoClass: unknown}[] = [
      // child-to-parent order for the delete pass
      {table: 'service_item_mapping', repoClass: Repos.ServiceItemMappingRepository},
      {table: 'service', repoClass: Repos.ServiceRepository},
      {table: 'item', repoClass: Repos.ItemRepository},
    ];
    for (const {table, repoClass} of clearOrder) {
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

  console.log('Matching service_category / item_category / additional_charge_master by code…');
  const serviceCategoryRepo = await app.getRepository(Repos.ServiceCategoryRepository);
  const itemCategoryRepo = await app.getRepository(Repos.ItemCategoryRepository);
  const chargeRepo = await app.getRepository(Repos.AdditionalChargeMasterRepository);

  const svcCatRemap = await upsertByCode(
    serviceCategoryRepo,
    'service_category',
    data.service_category || [],
  );
  const itemCatRemap = await upsertByCode(itemCategoryRepo, 'item_category', data.item_category || []);
  // additional_charge_master's ids aren't referenced by anything else in
  // this JSON — no remap needed, just dedupe-by-code.
  await upsertByCode(chargeRepo, 'additional_charge_master', data.additional_charge_master || []);
  console.log('');

  // Apply the remaps before inserting item/service, so their category FKs
  // point at whatever id actually ended up in the DB.
  const items: SeedRecord[] = (data.item || []).map((r: SeedRecord) => ({
    ...r,
    itemCategoryId: itemCatRemap.get(r.itemCategoryId as string) ?? r.itemCategoryId,
  }));
  const services: SeedRecord[] = (data.service || []).map((r: SeedRecord) => ({
    ...r,
    serviceCategoryId: svcCatRemap.get(r.serviceCategoryId as string) ?? r.serviceCategoryId,
  }));

  const insertOrder: {table: string; repoClass: unknown; rows: SeedRecord[]}[] = [
    {table: 'item', repoClass: Repos.ItemRepository, rows: items},
    {table: 'service', repoClass: Repos.ServiceRepository, rows: services},
    {
      table: 'service_item_mapping',
      repoClass: Repos.ServiceItemMappingRepository,
      rows: data.service_item_mapping || [],
    },
  ];

  for (const {table, repoClass, rows} of insertOrder) {
    if (!rows.length) {
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
