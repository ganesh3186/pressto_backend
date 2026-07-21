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

// Defaults to the client's latest workbook; pass a path to override.
const WB_PATH =
  process.argv[2] || path.resolve(__dirname, '../../Pressto_Pulse_Master ---new (1) (1).xlsx');
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

// ── Service master: taken straight from the sheet's "Service Name" column ────
// The client's updated workbook does the grouping itself: "Service Name" is the
// top-level service and the old granular names moved to "Service SubType Name".
// Preferred POS order first, then anything else alphabetically.
const SERVICE_ORDER = [
  'clean',
  'press',
  'shoes-bags',
  'curtain-carpet',
  'wash dry fold',
  'presstoke',
  'repair',
  'colouring',
  'cc-repair',
  'packing',
  'others',
];
const serviceDisplay = new Map(); // norm -> display name as written in the sheet
price.forEach((r) => {
  const raw = String(r['Service Name'] || '').trim();
  if (raw) serviceDisplay.set(norm(raw), raw);
});
const orderedServiceKeys = [...serviceDisplay.keys()].sort((a, b) => {
  const ia = SERVICE_ORDER.indexOf(a);
  const ib = SERVICE_ORDER.indexOf(b);
  if (ia !== -1 && ib !== -1) return ia - ib;
  if (ia !== -1) return -1;
  if (ib !== -1) return 1;
  return a.localeCompare(b);
});

const serviceIdByKey = {};
const svcCodes = new Set();
orderedServiceKeys.forEach((key, index) => {
  const name = serviceDisplay.get(key);
  const code = uniqueCode(slugBase(name).slice(0, 40), svcCodes);
  const id = keepId(prevService, key);
  out.service.push({
    id,
    name,
    code,
    serviceCategoryId: svcCatId,
    sequence: index + 1,
    estimatedDurationInHours: 24,
    description: name,
    isActive: true,
    isDeleted: false,
  });
  serviceIdByKey[key] = id;
});
report.service = out.service.length;

// ── Additional charges: the add-on catalogue, priced from the sub-type rows ───
const addonByName = new Map();
sheet('AddonServiceListMaster').forEach((a) => {
  const n = String(a.ServiceDesc || '').trim();
  if (n) addonByName.set(norm(n), {code: String(a.ServiceCode || '').trim(), name: n});
});
// Granular prices now live under "Service SubType Name".
const pricesBySubType = new Map();
price.forEach((r) => {
  const key = norm(r['Service SubType Name']);
  if (!key) return;
  if (!pricesBySubType.has(key)) pricesBySubType.set(key, new Set());
  pricesBySubType.get(key).add(Number(r['Base Price']) || 0);
});

const chargeCodes = new Set();
const chargeKeys = new Set();
function addCharge(displayName, key) {
  if (!key || chargeKeys.has(key)) return;
  const priceSet = pricesBySubType.get(key);
  const prices = priceSet ? [...priceSet].filter((n) => Number.isFinite(n)) : [];
  const addon = addonByName.get(key);
  const code = uniqueCode(addon ? addon.code : slugBase(displayName).slice(0, 40), chargeCodes);
  out.additional_charge_master.push({
    id: keepId(prevCharge, code),
    name: displayName,
    code,
    chargeScope: 'item',
    chargeType: 'standard',
    defaultAmount: prices.length ? Math.min(...prices) : 0, // lowest seen
    isTaxable: true,
    isActive: true,
    isDeleted: false,
  });
  chargeKeys.add(key);
}
addonByName.forEach((a, key) => addCharge(a.name, key));
FORCE_TO_CHARGE.forEach((n) => addCharge(n, norm(n)));
report.additional_charge_master = out.additional_charge_master.length;

// ── Service Item Mapping: one row per (item, service) at the LOWEST price ─────
const best = new Map();
let unmatchedItem = 0;
let placeholderX = 0;
let noService = 0;
const unmatchedItemSamples = new Set();

price.forEach((r) => {
  const svcKey = norm(r['Service Name']);
  const serviceId = serviceIdByKey[svcKey];
  if (!serviceId) {
    noService += 1;
    return;
  }
  const a = norm(r['New Name']);
  const b = norm(r['Iteam Name']);
  const itemId = itemByName[a] || itemByName[b] || null;
  if (!itemId) {
    // "X" is a placeholder the source system leaves when no product is named.
    if (a === 'x' || b === 'x') placeholderX += 1;
    else {
      unmatchedItem += 1;
      if (unmatchedItemSamples.size < 12) {
        unmatchedItemSamples.add(String(r['New Name'] || r['Iteam Name'] || '(blank)').trim());
      }
    }
    return;
  }
  const key = `${serviceId}:${itemId}`;
  const amount = Number(r['Base Price']) || 0;
  const current = best.get(key);
  if (!current || amount < current.basePrice) best.set(key, {serviceId, itemId, basePrice: amount});
});

best.forEach((v, key) => {
  out.service_item_mapping.push({
    id: keepId(prevMapping, key),
    serviceId: v.serviceId,
    itemId: v.itemId,
    basePrice: v.basePrice,
    estimatedDurationInDays: 1,
    additionalServiceIds: [],
    isActive: true,
    isDeleted: false,
  });
});
report.service_item_mapping = out.service_item_mapping.length;
report.priceRowsTotal = price.length;
report.priceRowsPlaceholderX = placeholderX;
report.priceUnmatchedItem = unmatchedItem;
report.priceNoServiceName = noService;

const perService = {};
out.service_item_mapping.forEach((m) => {
  perService[m.serviceId] = (perService[m.serviceId] || 0) + 1;
});

fs.writeFileSync(OUT_PATH, JSON.stringify(out, null, 2));

console.log('Source workbook:', path.basename(WB_PATH));
console.log('Wrote', path.relative(process.cwd(), OUT_PATH));
console.log('\n── Summary ──');
Object.entries(report).forEach(([k, v]) => console.log('  ' + k.padEnd(30) + v));
console.log('\n── Mappings per service (POS order) ──');
out.service.forEach((s) => console.log('  seq ' + String(s.sequence).padStart(2) + '  ' + String(perService[s.id] || 0).padStart(4) + '  ' + s.name));
console.log('\n── Items not found in ItemMaster (sample) ──');
[...unmatchedItemSamples].forEach((s) => console.log('  •', s));
