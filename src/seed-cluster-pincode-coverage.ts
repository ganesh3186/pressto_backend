import fs from 'fs';
import path from 'path';
import {presstoBackendApplication} from './application';
import * as Repos from './repositories';

/**
 * Store×pincode delivery-coverage reseeder
 * (`store-pincode-coverage.json`, produced by
 * scripts/migrate-cluster-pincode-coverage.cjs from
 * Pressto_Cluster_Pincode_Coverage.xlsx).
 *
 *   npm run seed:cluster-pincode-coverage
 *
 * store_pincode_coverage is fully CLEARED then replaced every run — this
 * table has no other model pointing at its ids as a foreign key, so a
 * full wipe+reinsert is safe (unlike service/item, nothing goes dangling).
 * storeCode is resolved against the real Store.code; any code that
 * doesn't resolve (a store not yet onboarded into Store) is skipped and
 * logged rather than failing the whole run.
 */
// dist/data/*.json, copied there by the build's copy-assets step.
const SEED_FILE = path.join(__dirname, 'data/store-pincode-coverage.json');

interface CoverageRow {
  id: string;
  storeCode: string;
  storeName?: string;
  region?: string;
  cluster?: string;
  pincode: string;
  pctOfPincodeInRange?: number;
  areaInRangeSqkm?: number;
  centroidDistanceKm?: number;
  material?: boolean;
  storesCovering?: number;
  overlap?: boolean;
  nearestStore?: string;
  boundarySource?: string;
}

async function seedClusterPincodeCoverage() {
  if (!fs.existsSync(SEED_FILE)) {
    console.error('Seed file not found:', SEED_FILE);
    console.error('Run: node scripts/migrate-cluster-pincode-coverage.cjs');
    process.exit(1);
  }
  const rows: CoverageRow[] = JSON.parse(fs.readFileSync(SEED_FILE, 'utf8'));

  const app = new presstoBackendApplication();
  await app.boot();
  await app.start();

  const coverageRepo = await app.getRepository(Repos.StorePincodeCoverageRepository);
  const storeRepo = await app.getRepository(Repos.StoreRepository);

  console.log('Clearing existing store_pincode_coverage…');
  const cleared = await coverageRepo.deleteAll();
  console.log(`  store_pincode_coverage cleared: ${cleared.count ?? 0}`);

  const storeIdByCode = new Map<string, string>();
  const stores = await storeRepo.find({fields: {id: true, code: true}});
  for (const store of stores) storeIdByCode.set(store.code, store.id);

  let inserted = 0;
  let skipped = 0;
  const unresolvedCodes = new Set<string>();
  for (const row of rows) {
    const storeId = storeIdByCode.get(row.storeCode);
    if (!storeId) {
      unresolvedCodes.add(row.storeCode);
      skipped += 1;
      continue;
    }
    try {
      await coverageRepo.create({
        id: row.id,
        storeId,
        pincode: row.pincode,
        storeName: row.storeName,
        region: row.region,
        cluster: row.cluster,
        pctOfPincodeInRange: row.pctOfPincodeInRange,
        areaInRangeSqkm: row.areaInRangeSqkm,
        centroidDistanceKm: row.centroidDistanceKm,
        material: row.material,
        storesCovering: row.storesCovering,
        overlap: row.overlap,
        nearestStore: row.nearestStore,
        boundarySource: row.boundarySource,
      });
      inserted += 1;
    } catch (err) {
      console.error(`  ✗ ${row.storeCode} / ${row.pincode}:`, (err as Error).message);
    }
  }

  console.log(`store_pincode_coverage inserted: ${inserted}, skipped: ${skipped}`);
  if (unresolvedCodes.size) {
    console.log(
      `  ${unresolvedCodes.size} store code(s) not found in Store: ${[...unresolvedCodes].sort().join(', ')}`,
    );
  }

  console.log('Store×pincode coverage seed complete.');
  await app.stop();
  process.exit(0);
}

seedClusterPincodeCoverage().catch(err => {
  console.error('Store×pincode coverage seed failed:', err);
  process.exit(1);
});
