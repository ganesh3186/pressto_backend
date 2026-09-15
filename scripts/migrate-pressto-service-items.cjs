/* eslint-disable */
/**
 * One-off migration generator: reads the client's REVISED service/item
 * workbook (pressto_master_data.xlsx — a clean reshape of the original
 * operational mapping, six sheets: Service Category Master, Service
 * Master, Add Ons Master, Item Category Master, Item Master, Service Item
 * Mapping) and emits `src/data/seed-service-items.json`, mapped to our
 * models with generated UUIDs and resolved foreign keys.
 *
 *   node scripts/migrate-pressto-service-items.cjs
 *
 * Then load it with:  npm run seed:pressto-seed
 *
 * This is a NARROWER, separate seeder from migrate-pressto-masters.cjs /
 * seed:pressto — it only touches service_category, item_category, item,
 * service, additional_charge_master and service_item_mapping. It does NOT
 * touch region/cluster/store/country_code (this workbook carries none of
 * that data) or roles/permissions.
 *
 * Row-shape of "Service Item Mapping" (19k+ rows), confirmed against the
 * actual delivered workbook:
 *   - Primary-service rows (Service = one of the 8 Primary Service names
 *     in Service Master): Base Price + duration are the item's own price
 *     for that primary service — including a legitimate 0 for the three
 *     "shell" primaries (Presstoke, PSB Repair, Carpet Repair: entry
 *     points that carry no price of their own, the real price comes from
 *     whichever additional service gets attached).
 *   - Additional-service rows (every other Service value): the sheet is a
 *     full cross-join of every item against every additional service in
 *     its own business line, so ~41% of these carry a placeholder 0
 *     rather than being left blank — a 0 here means "not actually offered
 *     for this item", not "free". Confirmed empirically: for a given
 *     item, the set of additional services with a NON-ZERO price exactly
 *     equals the primary row's own semicolon-separated "Additional
 *     Services" list — so additionalServiceIds is derived straight from
 *     non-zero rows, not by parsing that semicolon text (avoids edge
 *     cases like the "heel tips (beige)" non-breaking-space name).
 *
 * ID preservation: re-running keeps the same id for any record whose
 * natural key (name) still exists in the new sheet, by reading the
 * PREVIOUSLY generated JSON first — same pattern as
 * migrate-pressto-masters.cjs. Renamed/removed items or services get a
 * fresh id, same as a first-time seed.
 */
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

// xlsx isn't a backend dependency; borrow the copy from the admin-panel sibling.
const XLSX = require(path.resolve(__dirname, '../../pressto-admin-panel/node_modules/xlsx'));

// Defaults to the client's latest service/item workbook; pass a path to override.
const WB_PATH = process.argv[2] || path.resolve(__dirname, '../../pressto_master_data.xlsx');
const OUT_PATH = path.resolve(__dirname, '../src/data/seed-service-items.json');

const uuid = () => crypto.randomUUID();
const norm = (s) =>
  String(s || '')
    .trim()
    .toLowerCase()
    .replace(/ /g, ' ') // the sheet has at least one non-breaking space in a name
    .replace(/\s+/g, ' ');

// ── ID preservation ──────────────────────────────────────────────────────────
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
const prevSvcCat = prevIds('service_category', (r) => norm(r.name));
const prevItemCat = prevIds('item_category', (r) => norm(r.name));
const prevItem = prevIds('item', (r) => norm(r.name));
const prevService = prevIds('service', (r) => norm(r.name));
const prevCharge = prevIds('additional_charge_master', (r) => norm(r.name));
const prevMapping = prevIds('service_item_mapping', (r) => `${r.serviceId}:${r.itemId}`);
const keepId = (map, key) => map.get(key) || uuid();

const slugBase = (s) =>
  String(s || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '') || 'x';

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
const sheet = (name) => XLSX.utils.sheet_to_json(wb.Sheets[name], {blankrows: false, defval: ''});

const out = {
  service_category: [],
  item_category: [],
  item: [],
  service: [],
  additional_charge_master: [],
  service_item_mapping: [],
};
const report = {};

// ── Service Category ─────────────────────────────────────────────────────────
const svcCatCodes = new Set();
const svcCatIdByNormName = new Map();
sheet('Service Category Master').forEach((r) => {
  const name = String(r['Service Category Name'] || '').trim();
  if (!name) return;
  const code = uniqueCode(slugBase(name).slice(0, 20).toUpperCase(), svcCatCodes);
  const id = keepId(prevSvcCat, norm(name));
  out.service_category.push({
    id,
    name,
    code,
    description: String(r.Description || '').trim() || undefined,
    isActive: true,
    isDeleted: false,
  });
  svcCatIdByNormName.set(norm(name), id);
});
report.service_category = out.service_category.length;

// ── Item Category ─────────────────────────────────────────────────────────────
const itemCatCodes = new Set();
const itemCatIdByNormName = new Map();
sheet('Item Category Master').forEach((r, idx) => {
  const name = String(r['Item Category Name'] || '').trim();
  if (!name) return;
  const code = uniqueCode(slugBase(name), itemCatCodes);
  const id = keepId(prevItemCat, norm(name));
  out.item_category.push({
    id,
    name,
    code,
    sequence: idx + 1,
    description: String(r.Description || '').trim() || undefined,
    isActive: true,
    isDeleted: false,
  });
  itemCatIdByNormName.set(norm(name), id);
});
report.item_category = out.item_category.length;

// ── Item ──────────────────────────────────────────────────────────────────────
const itemCodes = new Set();
const itemIdByNormName = new Map();
let itemNoCategory = 0;
sheet('Item Master').forEach((r, idx) => {
  const name = String(r.Name || '').trim();
  if (!name) return;
  const itemCategoryId = itemCatIdByNormName.get(norm(r['Item Category'])) || null;
  if (!itemCategoryId) itemNoCategory += 1;
  const code = uniqueCode(slugBase(name).slice(0, 60), itemCodes);
  const id = keepId(prevItem, norm(name));
  out.item.push({
    id,
    name,
    code,
    itemCategoryId,
    sequence: idx + 1,
    description: String(r.Description || '').trim() || undefined,
    isMeasurement: false,
    isActive: true,
    isDeleted: false,
  });
  itemIdByNormName.set(norm(name), id);
});
report.item = out.item.length;
report.itemWithoutCategory = itemNoCategory;

// ── Service Master ───────────────────────────────────────────────────────────
const PRIMARY_KEY = norm('Primary Service');
const svcCodes = new Set();
const serviceIdByNormName = new Map();
const serviceDependencyByNormName = new Map(); // normName -> 'independent' | 'dependent'
let svcNoCategory = 0;
sheet('Service Master').forEach((r, idx) => {
  const name = String(r['Service Name'] || '').trim();
  if (!name) return;
  const isPrimary = norm(r['Primary/Additional']) === PRIMARY_KEY;
  const serviceCategoryId = svcCatIdByNormName.get(norm(r['Service Category'])) || null;
  if (!serviceCategoryId) svcNoCategory += 1;
  const code = uniqueCode(slugBase(name).slice(0, 40), svcCodes);
  const id = keepId(prevService, norm(name));
  out.service.push({
    id,
    name,
    code,
    serviceCategoryId,
    sequence: idx + 1,
    estimatedDurationInHours: 24, // real per-(service,item) TAT lives on service_item_mapping
    description: String(r.Description || '').trim() || undefined,
    dependencyType: isPrimary ? 'independent' : 'dependent',
    hasOwnProcess: true, // corrected below for the shell (always-zero-priced) primaries
    isActive: true,
    isDeleted: false,
  });
  serviceIdByNormName.set(norm(name), id);
  serviceDependencyByNormName.set(norm(name), isPrimary ? 'independent' : 'dependent');
});
report.service = out.service.length;
report.serviceWithoutCategory = svcNoCategory;

const isPrimaryServiceName = (name) => serviceDependencyByNormName.get(norm(name)) === 'independent';

// ── Add Ons Master → additional_charge_master ────────────────────────────────
// This 14-row catalogue (all PSB packaging: "Premium Packing *", "Protection
// Bag *") is entirely disjoint from Service Master AND never appears in the
// Service Item Mapping sheet — no pricing exists for these anywhere in this
// workbook. Created at defaultAmount 0; report flags this so it isn't mistaken
// for a real price.
const chargeCodes = new Set();
sheet('Add Ons Master').forEach((r) => {
  const name = String(r['Service Name'] || '').trim();
  if (!name) return;
  const code = uniqueCode(slugBase(name).slice(0, 40), chargeCodes);
  out.additional_charge_master.push({
    id: keepId(prevCharge, norm(name)),
    name,
    code,
    chargeScope: 'item',
    chargeType: 'standard',
    defaultAmount: 0,
    isTaxable: true,
    description: String(r.Description || '').trim() || undefined,
    isActive: true,
    isDeleted: false,
  });
});
report.additional_charge_master = out.additional_charge_master.length;
report.additional_charge_master_no_pricing_in_workbook = out.additional_charge_master.length;

// ── Service Item Mapping (19k+ rows) ─────────────────────────────────────────
const mappingRows = sheet('Service Item Mapping');

// Shell primaries (hasOwnProcess=false): every primary-shape row for that
// service is priced at 0. Determined from the data, not hardcoded names.
const primaryPricesByService = new Map();
mappingRows.forEach((r) => {
  const svcName = String(r.Service || '').trim();
  if (!svcName || !isPrimaryServiceName(svcName)) return;
  const key = norm(svcName);
  if (!primaryPricesByService.has(key)) primaryPricesByService.set(key, []);
  primaryPricesByService.get(key).push(Number(r['Base Price']) || 0);
});
primaryPricesByService.forEach((prices, key) => {
  const allZero = prices.length > 0 && prices.every((p) => p === 0);
  const svc = out.service.find((s) => s.id === serviceIdByNormName.get(key));
  if (svc) svc.hasOwnProcess = !allZero;
});
report.shellPrimaryServices = out.service
  .filter((s) => s.dependencyType === 'independent' && s.hasOwnProcess === false)
  .map((s) => s.name)
  .join(', ');

// Orphan additional-service names: present as a "Service" value in the
// mapping sheet but absent from Service Master. Created as a dependent
// service ONLY if it has real (non-zero) pricing somewhere — otherwise it
// would have zero valid mapping rows anyway (skipped, reported).
let orphanCreated = 0;
let orphanSkippedNoPricing = 0;
const additionalNamesInSheet = new Set();
mappingRows.forEach((r) => {
  const svcName = String(r.Service || '').trim();
  if (svcName && !isPrimaryServiceName(svcName)) additionalNamesInSheet.add(svcName);
});
additionalNamesInSheet.forEach((rawName) => {
  const key = norm(rawName);
  if (serviceIdByNormName.has(key)) return; // already in Service Master
  const hasRealPrice = mappingRows.some(
    (r) => norm(r.Service) === key && (Number(r['Base Price']) || 0) !== 0,
  );
  if (!hasRealPrice) {
    orphanSkippedNoPricing += 1;
    return;
  }
  const code = uniqueCode(slugBase(rawName).slice(0, 40), svcCodes);
  const id = keepId(prevService, key);
  out.service.push({
    id,
    name: rawName,
    code,
    serviceCategoryId: out.service_category[0]?.id || null,
    sequence: out.service.length + 1,
    estimatedDurationInHours: 24,
    description: `${rawName} — not listed in Service Master, inferred from mapping data`,
    dependencyType: 'dependent',
    hasOwnProcess: true,
    isActive: true,
    isDeleted: false,
  });
  serviceIdByNormName.set(key, id);
  serviceDependencyByNormName.set(key, 'dependent');
  orphanCreated += 1;
});
report.orphanAdditionalServicesCreated = orphanCreated;
report.orphanAdditionalServicesSkippedNoPricing = orphanSkippedNoPricing;

// Pass 1: primary-shape rows — one mapping row each, additionalServiceIds
// filled in during pass 3.
const mappingSeen = new Set();
const primaryMappingByKey = new Map();
let primaryRowsSkippedNoItem = 0;
mappingRows.forEach((r) => {
  const svcName = String(r.Service || '').trim();
  const itemName = String(r.Item || '').trim();
  if (!svcName || !itemName || !isPrimaryServiceName(svcName)) return;
  const serviceId = serviceIdByNormName.get(norm(svcName));
  const itemId = itemIdByNormName.get(norm(itemName));
  if (!serviceId) return; // every primary name is in Service Master by construction
  if (!itemId) {
    primaryRowsSkippedNoItem += 1;
    return;
  }
  const key = `${serviceId}:${itemId}`;
  const mapping = {
    id: keepId(prevMapping, key),
    serviceId,
    itemId,
    basePrice: Number(r['Base Price']) || 0,
    estimatedDurationInDays: Number(r['Estimated Duration (days)']) || 1,
    additionalServiceIds: [],
    isActive: true,
    isDeleted: false,
  };
  out.service_item_mapping.push(mapping);
  mappingSeen.add(key);
  primaryMappingByKey.set(key, mapping);
});

// Pass 2: additional-shape rows — only where actually priced (non-zero); a
// zero here means "not offered for this item", confirmed against the
// primary row's own curated list (see header comment).
const additionalServiceIdsByItem = new Map(); // itemId -> Set(serviceId)
let additionalRowsIncluded = 0;
let additionalRowsSkippedZero = 0;
let additionalRowsSkippedNoItem = 0;
let additionalRowsSkippedNoService = 0;
mappingRows.forEach((r) => {
  const svcName = String(r.Service || '').trim();
  const itemName = String(r.Item || '').trim();
  if (!svcName || !itemName || isPrimaryServiceName(svcName)) return;
  const serviceId = serviceIdByNormName.get(norm(svcName));
  if (!serviceId) {
    additionalRowsSkippedNoService += 1; // an orphan skipped above for lacking any real price
    return;
  }
  const itemId = itemIdByNormName.get(norm(itemName));
  if (!itemId) {
    additionalRowsSkippedNoItem += 1;
    return;
  }
  const basePrice = Number(r['Base Price']) || 0;
  if (basePrice === 0) {
    additionalRowsSkippedZero += 1;
    return;
  }
  const key = `${serviceId}:${itemId}`;
  if (mappingSeen.has(key)) return;
  mappingSeen.add(key);
  out.service_item_mapping.push({
    id: keepId(prevMapping, key),
    serviceId,
    itemId,
    basePrice,
    estimatedDurationInDays: Number(r['Estimated Duration (days)']) || 1,
    additionalServiceIds: [],
    isActive: true,
    isDeleted: false,
  });
  additionalRowsIncluded += 1;
  if (!additionalServiceIdsByItem.has(itemId)) additionalServiceIdsByItem.set(itemId, new Set());
  additionalServiceIdsByItem.get(itemId).add(serviceId);
});

// Pass 3: patch each primary-shape mapping's additionalServiceIds with
// every additional service actually priced (non-zero) for that same item.
primaryMappingByKey.forEach((mapping) => {
  const set = additionalServiceIdsByItem.get(mapping.itemId);
  mapping.additionalServiceIds = set ? [...set] : [];
});

report.service_item_mapping_primary = primaryMappingByKey.size;
report.service_item_mapping_primary_skipped_no_item = primaryRowsSkippedNoItem;
report.service_item_mapping_additional_included = additionalRowsIncluded;
report.service_item_mapping_additional_skipped_zero_price = additionalRowsSkippedZero;
report.service_item_mapping_additional_skipped_no_item = additionalRowsSkippedNoItem;
report.service_item_mapping_additional_skipped_no_service = additionalRowsSkippedNoService;
report.service_item_mapping_total = out.service_item_mapping.length;

fs.writeFileSync(OUT_PATH, JSON.stringify(out, null, 2));

console.log('Source workbook:', path.basename(WB_PATH));
console.log('Wrote', path.relative(process.cwd(), OUT_PATH));
console.log('\n── Summary ──');
Object.entries(report).forEach(([k, v]) => console.log('  ' + k.padEnd(42) + v));
