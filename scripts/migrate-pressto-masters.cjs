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

// Services that are really charges (packaging / misc), not things an item is
// "serviced" with. These are forced into additional_charge_master even though the
// price list maps them to an item.
const FORCE_TO_CHARGE = [
  'Freshener',
  'Miscelleneous Xtra Large',
  'Premium Packing M-39',
  'Premium Packing M-40',
  'Premium Packing M-41',
  'Premium Packing M-42',
  'Premium Packing M-43',
  'Premium Packing M-44',
  'Premium Packing M-45',
  'Premium Packing F-37',
  'Premium Packing F-39',
  'Premium Packing M Discounted',
  'Premium Packing W Discounted',
];

// Region code → state (the model requires `state`; the sheet doesn't carry it).
const REGION_STATE = {
  BLR: 'Karnataka',
  HYD: 'Telangana',
  MMR: 'Maharashtra',
  NCR: 'Delhi',
};

// ── ID preservation ──────────────────────────────────────────────────────────
// Re-generating must keep the SAME ids for records that already exist, otherwise
// rows already seeded (stores → clusterId, mappings → serviceId) would point at
// ids that no longer exist. Keyed by each table's natural key.
let prev = {};
try {
  prev = JSON.parse(fs.readFileSync(OUT_PATH, 'utf8'));
} catch {
  prev = {};
}
const prevIds = (table, keyFn) => {
  const m = new Map();
  (prev[table] || []).forEach((r) => {
    const k = keyFn(r);
    if (k) m.set(k, r.id);
  });
  return m;
};
const prevRegion = prevIds('region', (r) => r.code);
const prevCluster = prevIds('cluster', (r) => r.code);
const prevStore = prevIds('store', (r) => r.code);
const prevSvcCat = prevIds('service_category', (r) => r.code);
const prevItemCat = prevIds('item_category', (r) => r.code);
const prevItem = prevIds('item', (r) => r.code);
const prevService = prevIds('service', (r) => norm(r.name));
const prevCharge = prevIds('additional_charge_master', (r) => r.code);
const prevMapping = prevIds('service_item_mapping', (r) => `${r.serviceId}:${r.itemId}`);
const keepId = (map, key) => map.get(key) || uuid();
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
  additional_charge_master: [],
  service_item_mapping: [],
};
const report = {};

// ── Region ──────────────────────────────────────────────────────────────────
const regionByCode = {};
sheet('RegionMaster').forEach((r) => {
  const code = String(r.Code || '').trim();
  if (!code) return;
  const id = keepId(prevRegion, code);
  out.region.push({
    id,
    name: String(r.Name || '').trim(),
    code,
    country: 'India',
    state: REGION_STATE[code] || 'India', // model requires state; sheet has none
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
  const id = keepId(prevCluster, code);
  out.cluster.push({
    id,
    regionId,
    name: String(c.Name || '').trim(),
    code,
    clusterType: 'standard', // model requires it; sheet has no cluster type
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
    id: keepId(prevStore, String(s.StoreID || '').trim()),
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
let catBlankName = 0;
sheet('ProductGroupMaster').forEach((p) => {
  const name = String(p.ProductGroupName || '').trim();
  if (!name) {
    catBlankName += 1; // model requires a name — skip blank rows
    return;
  }
  const code = uniqueCode(String(p.PGCode || '').trim() || slugBase(name), catCodes);
  const id = keepId(prevItemCat, code);
  out.item_category.push({
    id,
    name,
    code,
    sequence: 0,
    isActive: p.IsActive !== 0,
    isDeleted: false,
  });
  if (p.Id !== '') catByPGId[String(p.Id)] = id;
});
report.item_category = out.item_category.length;
report.itemCategoryBlankNameSkipped = catBlankName;

// ── Item (itemCategoryId from PGId) ──────────────────────────────────────────
const itemByName = {};
const itemCodes = new Set();
let itemNoCategory = 0;
let itemBlankName = 0;
sheet('ItemMaster').forEach((it) => {
  const name = String(it.ItemDesc || '').trim();
  if (!name) {
    itemBlankName += 1; // model requires a name — skip blank rows
    return;
  }
  const itemCategoryId = catByPGId[String(it.PGId)] || null;
  if (!itemCategoryId) itemNoCategory += 1;
  const code = uniqueCode(String(it.ItemCode || '').trim() || slugBase(name), itemCodes);
  const id = keepId(prevItem, code);
  out.item.push({
    id,
    name,
    code,
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
report.itemBlankNameSkipped = itemBlankName;

// ── Service Category (default bucket — sheet has none) ────────────────────────
const svcCatId = keepId(prevSvcCat, 'GENERAL');
out.service_category.push({
  id: svcCatId,
  name: 'General',
  code: 'GENERAL',
  isActive: true,
  isDeleted: false,
});

const price = sheet('Base Service Price List');

// ── Classify add-ons: distinct price count decides flat vs per-item ───────────
// Add-ons from the AddonServiceList sheet (name -> {code, name}).
const addonByName = new Map();
sheet('AddonServiceListMaster').forEach((a) => {
  const n = String(a.ServiceDesc || '').trim();
  if (n) addonByName.set(norm(n), {code: String(a.ServiceCode || '').trim(), name: n});
});
// Distinct base prices per service name across the price list.
const pricesByName = new Map();
price.forEach((r) => {
  const key = norm(r['Service Name']);
  if (!key) return;
  if (!pricesByName.has(key)) pricesByName.set(key, new Set());
  pricesByName.get(key).add(Number(r['Base Price']) || 0);
});
// Flat add-ons (≤1 distinct price) → additional charges; the rest stay services.
const flatAddonKeys = new Set();
const variableAddonKeys = new Set();
addonByName.forEach((_v, key) => {
  const p = pricesByName.get(key);
  if (p && p.size > 1) variableAddonKeys.add(key);
  else flatAddonKeys.add(key);
});

// ── Additional Charge Master (flat add-ons only) ──────────────────────────────
const chargeCodes = new Set();
flatAddonKeys.forEach((key) => {
  const a = addonByName.get(key);
  const p = pricesByName.get(key);
  const code = uniqueCode(a.code || slugBase(a.name).slice(0, 40), chargeCodes);
  out.additional_charge_master.push({
    id: keepId(prevCharge, code),
    name: a.name,
    code,
    chargeScope: 'item',
    chargeType: 'standard',
    defaultAmount: p ? [...p][0] : 0, // single flat price (0 if never priced)
    isTaxable: true,
    isActive: true,
    isDeleted: false,
  });
});
report.additional_charge_master = out.additional_charge_master.length;

// ── Service (primary services + variable add-ons; flat add-ons excluded) ──────
const serviceByName = {};
const svcCodes = new Set();
const distinctSvc = new Map(); // norm -> original display name
price.forEach((r) => {
  const raw = String(r['Service Name'] || '').trim();
  const key = norm(raw);
  if (raw && !flatAddonKeys.has(key)) distinctSvc.set(key, raw);
});
distinctSvc.forEach((name, key) => {
  const id = keepId(prevService, key);
  out.service.push({
    id,
    name,
    code: uniqueCode(slugBase(name).slice(0, 40), svcCodes),
    serviceCategoryId: svcCatId,
    sequence: 0,
    estimatedDurationInHours: 24, // model requires it; sheet has no TAT
    description: name,
    isActive: true,
    isDeleted: false,
  });
  serviceByName[key] = id;
});
report.service = out.service.length;
report.variableAddonsKeptAsService = variableAddonKeys.size;

// ── Service Item Mapping (price list; flat add-ons skipped — they're charges) ──
const seen = new Set();
let unmatchedItem = 0;
let unmatchedSvc = 0;
let dup = 0;
let skippedFlatAddon = 0;
const unmatchedItemSamples = new Set();
price.forEach((r) => {
  const svcKey = norm(r['Service Name']);
  if (flatAddonKeys.has(svcKey)) {
    skippedFlatAddon += 1;
    return;
  }
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
    id: keepId(prevMapping, `${serviceId}:${itemId}`),
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
report.priceSkippedFlatAddon = skippedFlatAddon;
report.priceUnmatchedItem = unmatchedItem;
report.priceUnmatchedService = unmatchedSvc;
report.priceDuplicatePair = dup;

// ── Orphan services → additional charges ─────────────────────────────────────
// Only services that actually map to an item stay services. Anything left over
// (its price rows never matched an item) is unusable as a service, so it becomes
// a flat charge instead — priced at the lowest amount seen in the price list.
const usedServiceIds = new Set(out.service_item_mapping.map((m) => m.serviceId));
const forcedToCharge = new Set(FORCE_TO_CHARGE.map(norm));
const keptServices = [];
const movedMultiPrice = [];
const movedServiceIds = new Set();
out.service.forEach((s) => {
  // Keep only services that map to an item AND aren't on the force-to-charge list.
  if (usedServiceIds.has(s.id) && !forcedToCharge.has(norm(s.name))) {
    keptServices.push(s);
    return;
  }
  movedServiceIds.add(s.id);
  const key = norm(s.name);
  const priceSet = pricesByName.get(key);
  const prices = priceSet ? [...priceSet].filter((n) => Number.isFinite(n)) : [];
  if (prices.length > 1) movedMultiPrice.push(`${s.name} (${Math.min(...prices)}–${Math.max(...prices)})`);
  const addon = addonByName.get(key);
  const code = uniqueCode(addon ? addon.code : slugBase(s.name).slice(0, 40), chargeCodes);
  out.additional_charge_master.push({
    id: keepId(prevCharge, code),
    name: s.name,
    code,
    chargeScope: 'item',
    chargeType: 'standard',
    defaultAmount: prices.length ? Math.min(...prices) : 0,
    isTaxable: true,
    isActive: true,
    isDeleted: false,
  });
});
report.servicesMovedToCharge = out.service.length - keptServices.length;
out.service = keptServices;
// A moved service can't keep its mappings — drop them.
const mappingsBefore = out.service_item_mapping.length;
out.service_item_mapping = out.service_item_mapping.filter((m) => !movedServiceIds.has(m.serviceId));
report.mappingsDroppedWithMovedServices = mappingsBefore - out.service_item_mapping.length;
report.service = out.service.length;
report.service_item_mapping = out.service_item_mapping.length;
report.additional_charge_master = out.additional_charge_master.length;

fs.writeFileSync(OUT_PATH, JSON.stringify(out, null, 2));

console.log('Wrote', path.relative(process.cwd(), OUT_PATH));
console.log('\n── Summary ──');
Object.entries(report).forEach(([k, v]) => console.log('  ' + k.padEnd(22) + v));
console.log('\n── Sample unmatched price-list items (need attention) ──');
[...unmatchedItemSamples].forEach((s) => console.log('  •', s));

if (movedMultiPrice.length) {
  console.log('\n── Moved to charges but had a price RANGE (flattened to the lowest) ──');
  movedMultiPrice.forEach((s) => console.log('  •', s));
}
