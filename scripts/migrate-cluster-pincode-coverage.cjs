/* eslint-disable */
/**
 * One-off migration generator: reads the client's
 * Pressto_Cluster_Pincode_Coverage.xlsx and emits
 * `src/data/store-pincode-coverage.json` from its "Store x Pincode" sheet
 * (~1000 rows: per-store, per-pincode delivery coverage %/area/distance/
 * overlap metadata).
 *
 *   node scripts/migrate-cluster-pincode-coverage.cjs
 *
 * Then load it with:  npm run seed:cluster-pincode-coverage
 *
 * Only "Store x Pincode" is seeded. The workbook's other three sheets
 * (Cluster Summary, Store Summary, Cluster x Pincode) are all derivable
 * from this sheet plus Store.clusterId — seeding them too would just be
 * redundant, driftable data, so they're intentionally skipped (confirmed
 * with the client).
 *
 * storeId is resolved from the sheet's own StoreID column (e.g. "ST059")
 * against the real Store.code at SEED time (this script has no DB
 * access) — see seed-cluster-pincode-coverage.ts.
 *
 * ID preservation: re-running keeps the same id for any row whose
 * natural key (storeCode + pincode) still exists in the new sheet, by
 * reading the previously generated JSON first — same pattern as
 * migrate-pressto-service-items.cjs.
 */
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

// xlsx isn't a backend dependency; borrow the copy from the admin-panel sibling.
const XLSX = require(path.resolve(__dirname, '../../pressto-admin-panel/node_modules/xlsx'));

const WB_PATH = process.argv[2] || path.resolve(__dirname, '../../Pressto_Cluster_Pincode_Coverage.xlsx');
const OUT_PATH = path.resolve(__dirname, '../src/data/store-pincode-coverage.json');

const uuid = () => crypto.randomUUID();

// ── ID preservation ──────────────────────────────────────────────────────────
let prevRows = [];
try {
  prevRows = JSON.parse(fs.readFileSync(OUT_PATH, 'utf8'));
} catch {
  prevRows = [];
}
const prevIdByKey = new Map();
for (const r of prevRows) {
  prevIdByKey.set(`${r.storeCode}:${r.pincode}`, r.id);
}
const keepId = (key) => prevIdByKey.get(key) || uuid();

// ── Read ─────────────────────────────────────────────────────────────────────
if (!fs.existsSync(WB_PATH)) {
  console.error('Workbook not found:', WB_PATH);
  process.exit(1);
}
const wb = XLSX.readFile(WB_PATH);
const ws = wb.Sheets['Store x Pincode'];
if (!ws) {
  console.error('Sheet "Store x Pincode" not found in workbook.');
  process.exit(1);
}
const rows = XLSX.utils.sheet_to_json(ws, {defval: null});

const out = [];
let skippedBadPincode = 0;
for (const row of rows) {
  const storeCode = String(row['StoreID'] || '').trim();
  const pincode = String(row['Pincode'] || '').trim();
  if (!storeCode || !/^[0-9]{6}$/.test(pincode)) {
    skippedBadPincode += 1;
    continue;
  }
  const key = `${storeCode}:${pincode}`;
  out.push({
    id: keepId(key),
    storeCode,
    storeName: row['StoreName'] ? String(row['StoreName']).trim() : undefined,
    region: row['Region'] ? String(row['Region']).trim() : undefined,
    cluster: row['Cluster'] ? String(row['Cluster']).trim() : undefined,
    pincode,
    pctOfPincodeInRange: row['Pct_Of_Pincode_In_Range'] != null ? Number(row['Pct_Of_Pincode_In_Range']) : undefined,
    areaInRangeSqkm: row['Area_In_Range_sqkm'] != null ? Number(row['Area_In_Range_sqkm']) : undefined,
    centroidDistanceKm: row['Centroid_Distance_km'] != null ? Number(row['Centroid_Distance_km']) : undefined,
    material: row['Material'] != null ? String(row['Material']).trim().toLowerCase() === 'yes' : undefined,
    storesCovering: row['Stores_Covering'] != null ? Number(row['Stores_Covering']) : undefined,
    overlap: row['Overlap'] != null ? String(row['Overlap']).trim().toLowerCase() === 'yes' : undefined,
    nearestStore: row['Nearest_Store'] ? String(row['Nearest_Store']).trim() : undefined,
    boundarySource: row['Boundary_Source'] ? String(row['Boundary_Source']).trim() : undefined,
  });
}

fs.writeFileSync(OUT_PATH, JSON.stringify(out, null, 2));
console.log(`Wrote ${out.length} store-pincode-coverage rows to ${OUT_PATH}`);
if (skippedBadPincode) {
  console.log(`Skipped ${skippedBadPincode} rows with a missing StoreID or malformed pincode.`);
}
