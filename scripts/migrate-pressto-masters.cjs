/* eslint-disable */
/**
 * One-off migration generator: reads the client's Excel master workbook and emits
 * `src/data/seed-masters-pressto.json` mapped to our models, with generated UUIDs
 * and resolved foreign keys. Re-run whenever the sheet changes.
 *
 *   node scripts/migrate-pressto-masters.cjs
 *
 * Then load it with:  npm run seed:pressto
 *
 * Only masters are produced (roles/permissions are NOT touched — we keep ours).
 */
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

// xlsx isn't a backend dependency; borrow the copy from the admin-panel sibling.
const XLSX = require(path.resolve(__dirname, '../../pressto-admin-panel/node_modules/xlsx'));

const WB_PATH = path.resolve(__dirname, '../../Pressto_Pulse_Master (1).xlsx');
const OUT_PATH = path.resolve(__dirname, '../src/data/seed-masters-pressto.json');

const uuid = () => crypto.randomUUID();
const norm = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
const slugBase = (s) =>
  String(s || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '') || 'x';

// Make a code unique within a set by suffixing on collision.
function uniqueCode(base, used) {
  let code = base;
  let i = 1;
  while (used.has(code)) {
    i += 1;
    code = `${base}_${i}`;
  }
  used.add(code);
  return code;
}

const wb = XLSX.readFile(WB_PATH);
const sheet = (name) => XLSX.utils.sheet_to_json(wb.Sheets[name], { blankrows: false, defval: '' });

// Region code embedded in the cluster code's 3rd char: CL[B|D|H|M]…
const REGION_BY_CLUSTER_PREFIX = { B: 'BLR', D: 'NCR', H: 'HYD', M: 'MMR' };

const out = {
  region: [],
  cluster: [],
  store: [],
  service_category: [],
  item_category: [],
  item: [],
  service: [],
  service_item_mapping: [],
};
const report = {};

// ── Region ──────────────────────────────────────────────────────────────────
const regionByCode = {};
sheet('RegionMaster').forEach((r) => {
  const code = String(r.Code || '').trim();
  if (!code) return;
  const id = uuid();
  out.region.push({
    id,
    name: String(r.Name || '').trim(),
    code,
    isActive: r.IsActive !== 0,
    isDeleted: false,
  });
  regionByCode[code] = id;
});
report.region = out.region.length;

// ── Cluster (regionId from code prefix) ──────────────────────────────────────
const clusterByCode = {};
let clusterNoRegion = 0;
sheet('ClusterMaster').forEach((c) => {
  const code = String(c.Code || '').trim();
  if (!code) return;
  const prefixChar = code.replace(/^CL/i, '')[0];
  const regionId = regionByCode[REGION_BY_CLUSTER_PREFIX[prefixChar]] || null;
  if (!regionId) clusterNoRegion += 1;
  const id = uuid();
  out.cluster.push({
    id,
    regionId,
    name: String(c.Name || '').trim(),
    code,
    isActive: c.IsActive !== 0,
    isDeleted: false,
  });
  clusterByCode[code] = id;
});
report.cluster = out.cluster.length;
report.clusterWithoutRegion = clusterNoRegion;

// ── Store (clusterId from ClusterCode) ───────────────────────────────────────
const storeCodes = new Set();
let storeNoCluster = 0;
sheet('Store Master').forEach((s) => {
  const clusterId = clusterByCode[String(s.ClusterCode || '').trim()] || null;
  if (!clusterId) storeNoCluster += 1;
  const address = [s.AddressLine1, s.AddressLine2, s.Locality, s.Area]
    .map((x) => String(x || '').trim())
    .filter(Boolean)
    .join(', ');
  out.store.push({
    id: uuid(),
    clusterId,
    name: String(s.Name || '').trim(),
    code: uniqueCode(String(s.StoreID || '').trim() || slugBase(s.Name), storeCodes),
    storeType: 'Main Store', // sheet has no per-store type; default (see feedback #3)
    address,
    city: String(s.City || '').trim(),
    state: String(s.State || '').trim(),
    country: 'India',
    pincode: String(s.PinCode || '').trim(),
    phone: String(s.Contact1 || '').trim(),
    isActive: true,
    isDeleted: false,
  });
});
report.store = out.store.length;
report.storeWithoutCluster = storeNoCluster;

// ── Item Category (ProductGroupMaster) ───────────────────────────────────────
const catByPGId = {};
const catCodes = new Set();
sheet('ProductGroupMaster').forEach((p) => {
  const id = uuid();
  out.item_category.push({
    id,
    name: String(p.ProductGroupName || '').trim(),
    code: uniqueCode(String(p.PGCode || '').trim() || slugBase(p.ProductGroupName), catCodes),
    sequence: 0,
    isActive: p.IsActive !== 0,
    isDeleted: false,
  });
  if (p.Id !== '') catByPGId[String(p.Id)] = id;
});
report.item_category = out.item_category.length;

// ── Item (itemCategoryId from PGId) ──────────────────────────────────────────
const itemByName = {};
const itemCodes = new Set();
let itemNoCategory = 0;
sheet('ItemMaster').forEach((it) => {
  const itemCategoryId = catByPGId[String(it.PGId)] || null;
  if (!itemCategoryId) itemNoCategory += 1;
  const name = String(it.ItemDesc || '').trim();
  const id = uuid();
  out.item.push({
    id,
    name,
    code: uniqueCode(String(it.ItemCode || '').trim() || slugBase(name), itemCodes),
    itemCategoryId,
    sequence: 0,
    isMeasurement: false,
    isActive: true,
    isDeleted: false,
  });
  if (name) itemByName[norm(name)] = id;
});
report.item = out.item.length;
report.itemWithoutCategory = itemNoCategory;

// ── Service Category (default bucket — sheet has none) ────────────────────────
const svcCatId = uuid();
out.service_category.push({
  id: svcCatId,
  name: 'General',
  code: 'GENERAL',
  isActive: true,
  isDeleted: false,
});

// ── Service (distinct "Service Name" in the price list ∪ add-on list) ─────────
const price = sheet('Base Service Price List');
const serviceByName = {};
const svcCodes = new Set();
const distinctSvc = new Map(); // norm -> original display name
price.forEach((r) => {
  const n = String(r['Service Name'] || '').trim();
  if (n) distinctSvc.set(norm(n), n);
});
const addonSet = new Set();
sheet('AddonServiceListMaster').forEach((a) => {
  const n = String(a.ServiceDesc || '').trim();
  if (!n) return;
  addonSet.add(norm(n));
  if (!distinctSvc.has(norm(n))) distinctSvc.set(norm(n), n);
});
distinctSvc.forEach((name, key) => {
  const id = uuid();
  out.service.push({
    id,
    name,
    code: uniqueCode(slugBase(name).slice(0, 40), svcCodes),
    serviceCategoryId: svcCatId,
    sequence: 0,
    isActive: true,
    isDeleted: false,
  });
  serviceByName[key] = id;
});
report.service = out.service.length;
report.serviceAddonFlagged = [...addonSet].length;

// ── Service Item Mapping (price list; item matched by name) ───────────────────
const seen = new Set();
let unmatchedItem = 0;
let unmatchedSvc = 0;
let dup = 0;
const unmatchedItemSamples = new Set();
price.forEach((r) => {
  const svcKey = norm(r['Service Name']);
  const serviceId = serviceByName[svcKey];
  // Try the "New Name" first, then the raw "Iteam Name".
  const itemId =
    itemByName[norm(r['New Name'])] || itemByName[norm(r['Iteam Name'])] || null;
  if (!itemId) {
    unmatchedItem += 1;
    if (unmatchedItemSamples.size < 15) {
      unmatchedItemSamples.add(String(r['New Name'] || r['Iteam Name'] || '').trim());
    }
    return;
  }
  if (!serviceId) {
    unmatchedSvc += 1;
    return;
  }
  const key = `${itemId}:${serviceId}`;
  if (seen.has(key)) {
    dup += 1;
    return;
  }
  seen.add(key);
  out.service_item_mapping.push({
    id: uuid(),
    serviceId,
    itemId,
    basePrice: Number(r['Base Price']) || 0,
    estimatedDurationInDays: 1,
    additionalServiceIds: [],
    isActive: true,
    isDeleted: false,
  });
});
report.service_item_mapping = out.service_item_mapping.length;
report.priceRowsTotal = price.length;
report.priceUnmatchedItem = unmatchedItem;
report.priceUnmatchedService = unmatchedSvc;
report.priceDuplicatePair = dup;

fs.writeFileSync(OUT_PATH, JSON.stringify(out, null, 2));

console.log('Wrote', path.relative(process.cwd(), OUT_PATH));
console.log('\n── Summary ──');
Object.entries(report).forEach(([k, v]) => console.log('  ' + k.padEnd(22) + v));
console.log('\n── Sample unmatched price-list items (need attention) ──');
[...unmatchedItemSamples].forEach((s) => console.log('  •', s));
