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
 *
 * v2 (29.07 workbook): PresstoKe/Repair/CC-Repair are now seeded as independent
 * services with hasOwnProcess=false (see Service.dependencyType/hasOwnProcess) —
 * they carry no billable work of their own. Their old "AddonServiceListMaster"
 * catalogue is now seeded as real dependent Services (dependencyType='dependent'),
 * each with its own service_item_mapping rows, wired into the shell services'
 * additionalServiceIds so a New Order line under Presstoke/Repair/CC-Repair can
 * actually select them. Most of that pricing in the sheet is keyed to a placeholder
 * "X" item (flat per-treatment pricing, not truly item-specific) — that price is
 * broadcast across a representative sample of real items per business unit
 * (PDC/PSBO/CC) so the feature is testable against real items, not just the
 * handful of rows that happen to name a real item.
 */
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

// xlsx isn't a backend dependency; borrow the copy from the admin-panel sibling.
const XLSX = require(path.resolve(__dirname, '../../pressto-admin-panel/node_modules/xlsx'));

// Defaults to the client's latest workbook; pass a path to override.
const WB_PATH =
  process.argv[2] || path.resolve(__dirname, '../../Pressto_Pulse_Master --- new 29.07.xlsx');
const OUT_PATH = path.resolve(__dirname, '../src/data/seed-masters-pressto.json');

const uuid = () => crypto.randomUUID();
const norm = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');

// Services that are really charges (packaging / misc), not things an item is
// "serviced" with. These are forced into additional_charge_master even though the
// price list maps them to an item or an addon sub-type.
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
const FORCE_TO_CHARGE_KEYS = new Set(FORCE_TO_CHARGE.map(norm));

// Shell services: independent (selectable as a primary service) but carry no
// process/pricing of their own — hasOwnProcess=false. All real work is billed
// through the dependent addon services created below.
const SHELL_SERVICES = ['PresstoKe', 'Repair', 'CC-Repair'];
const SHELL_SERVICE_KEYS = new Set(SHELL_SERVICES.map(norm));

// Region code → state (the model requires `state`; the sheet doesn't carry it).
const REGION_STATE = {
  BLR: 'Karnataka',
  HYD: 'Telangana',
  MMR: 'Maharashtra',
  NCR: 'Delhi',
};

// BU Name (from the price list) → a ServiceCategory we create.
const SERVICE_CATEGORY_BY_BU = {
  PDC: {code: 'PDC', name: 'Garments (PDC)'},
  PSBO: {code: 'PSBO', name: 'Shoes & Bags (PSBO)'},
  CC: {code: 'CC', name: 'Curtain & Carpet (CC)'},
};
const DEFAULT_SERVICE_CATEGORY = 'PDC';

// How many real items to sample per business-unit group when broadcasting a
// shell service's addon pricing, on top of whatever items the sheet already
// names explicitly against Repair/CC-Repair. Keeps the seed testable without
// generating tens of thousands of mapping rows.
const SAMPLE_ITEMS_PER_GROUP = 8;

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

// ── Item Category (fixed 20-category taxonomy, per client's exact list) ────
// The client wants item_category to be exactly these 20 broad groups, not the
// old fine-grained ProductGroupMaster sub-groups. These line up with the
// "Product Group" column ItemMaster already carries directly per row — no PGId
// indirection needed. Sequence follows the order the client gave.
const ITEM_CATEGORIES = [
  'Shirt', 'Bottom', 'Top', 'Jacket', 'Dress', 'Indian Top', 'Indian Bottom',
  'Saree-Dupatta', 'Shawl', 'Small Items', 'Accessory', 'Bed', 'Pillow',
  'Table', 'Upholstrey', 'Bag', 'Shoe', 'Others', 'Carpet', 'Curtain',
];
// The sheet spells two of these slightly differently ("Other" / "Upholstery").
const ITEM_CATEGORY_ALIASES = {other: 'others', upholstery: 'upholstrey'};

const catCodes = new Set();
const catIdByNormName = new Map();
ITEM_CATEGORIES.forEach((name, index) => {
  const code = uniqueCode(slugBase(name), catCodes);
  const id = keepId(prevItemCat, code);
  out.item_category.push({
    id,
    name,
    code,
    sequence: index + 1,
    isActive: true,
    isDeleted: false,
  });
  catIdByNormName.set(norm(name), id);
});
report.item_category = out.item_category.length;

function resolveItemCategoryId(rawGroup) {
  const key = norm(rawGroup);
  if (!key) return null;
  return catIdByNormName.get(ITEM_CATEGORY_ALIASES[key] || key) || null;
}

// Exact BU -> item-category partition, per the client's own mapping:
//   PDC:  Clean/Iron/PresstoKe/Wash Dry Fold  -> Shirt..Upholstrey (15 cats)
//   PSBO: Shoes-Bags/Repair/Colouring         -> Bag, Shoe, Others  (3 cats)
//   CC:   Curtain-Carpet/CC-Repair            -> Carpet, Curtain    (2 cats)
// Note "Others" is PSBO here, NOT PDC — the client's legend puts it under the
// Shoes-Bags/Repair/Colouring group.
const BU_CATEGORY_NAMES = {
  PDC: ['Shirt', 'Bottom', 'Top', 'Jacket', 'Dress', 'Indian Top', 'Indian Bottom',
    'Saree-Dupatta', 'Shawl', 'Small Items', 'Accessory', 'Bed', 'Pillow', 'Table', 'Upholstrey'],
  PSBO: ['Bag', 'Shoe', 'Others'],
  CC: ['Carpet', 'Curtain'],
};
const buGroupByCategoryId = new Map();
Object.entries(BU_CATEGORY_NAMES).forEach(([bu, names]) => {
  names.forEach((name) => {
    const id = catIdByNormName.get(norm(name));
    if (id) buGroupByCategoryId.set(id, bu);
  });
});
function resolveItemBuGroup(itemCategoryId) {
  return buGroupByCategoryId.get(itemCategoryId) || 'PDC';
}

// ── Item (itemCategoryId from ItemMaster's own "Product Group" column) ─────
const itemByName = {};
const itemsByBuGroup = { PDC: [], PSBO: [], CC: [] };
const itemCodes = new Set();
let itemNoCategory = 0;
let itemBlankName = 0;
sheet('ItemMaster').forEach((it) => {
  const name = String(it.ItemDesc || '').trim();
  if (!name) {
    itemBlankName += 1; // model requires a name — skip blank rows
    return;
  }
  const broadGroup = String(it['Product Group'] || '').trim();
  const itemCategoryId = resolveItemCategoryId(broadGroup);
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
  const buGroup = resolveItemBuGroup(itemCategoryId);
  itemsByBuGroup[buGroup].push({id, name});
});
report.item = out.item.length;
report.itemWithoutCategory = itemNoCategory;
report.itemBlankNameSkipped = itemBlankName;

// ── Service Category (PDC / PSBO / CC, from the price list's BU Name) ───────
const svcCatIdByCode = {};
Object.values(SERVICE_CATEGORY_BY_BU).forEach(({code, name}) => {
  const id = keepId(prevSvcCat, code);
  out.service_category.push({id, name, code, isActive: true, isDeleted: false});
  svcCatIdByCode[code] = id;
});
report.service_category = out.service_category.length;

const price = sheet('BaseServicePriceList');

// ── Determine each top-level service's dominant BU (for its ServiceCategory) ─
const buCountsByService = new Map();
price.forEach((r) => {
  const svc = norm(r['Service Name']);
  const bu = String(r['BU Name'] || '').trim();
  if (!svc || !bu) return;
  if (!buCountsByService.has(svc)) buCountsByService.set(svc, new Map());
  const m = buCountsByService.get(svc);
  m.set(bu, (m.get(bu) || 0) + 1);
});
function dominantBuFor(svcKey) {
  const m = buCountsByService.get(svcKey);
  if (!m) return null;
  let best = null;
  let bestCount = -1;
  m.forEach((count, bu) => {
    if (count > bestCount) { best = bu; bestCount = count; }
  });
  return best;
}

// ── Service master ────────────────────────────────────────────────────────
// Top-level services taken from the sheet's "Service Name" column, EXCLUDING
// the ones that are really order-level charges (Packing/Logistics/Others — see
// AddonServices-OrderLevel + FORCE_TO_CHARGE) and the shell services (handled
// separately below with hasOwnProcess=false).
const NON_SERVICE_NAMES = new Set(['others', 'packing', 'logistics'].map(norm));
const SERVICE_ORDER = [
  'clean',
  'press',
  'shoes-bags',
  'curtain-carpet',
  'wash dry fold',
  'colouring',
  'presstoke',
  'repair',
  'cc-repair',
];

// Per-service turnaround (days), from the client's estimation table:
//   PRESSTOKE 7, DC 2, PRESS 2, WDF 2, SB CLEAN 5, REPAIR 7, COLOURING 21,
//   CC 7, CC-REPAIR 7, PACKING 3
// DC = "Dry Clean" -> Clean; SB = Shoes-Bags; CC = Curtain-Carpet. PACKING has
// no Service row (it's routed to additional_charge_master), so it's unused
// here.
const SERVICE_TAT_DAYS = {
  clean: 2,
  press: 2,
  'shoes-bags': 5,
  'curtain-carpet': 7,
  'wash dry fold': 2,
  colouring: 21,
  presstoke: 7,
  repair: 7,
  'cc-repair': 7,
};
const tatDaysForKey = (key) => SERVICE_TAT_DAYS[key] ?? 1;
const serviceDisplay = new Map(); // norm -> display name as written in the sheet
price.forEach((r) => {
  const raw = String(r['Service Name'] || '').trim();
  const key = norm(raw);
  if (raw && !NON_SERVICE_NAMES.has(key)) serviceDisplay.set(key, raw);
});
// Iron is dropped entirely — it's the same treatment as Press, just under a
// different name in the old system; no separate service is seeded for it.

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
  const isShell = SHELL_SERVICE_KEYS.has(key);
  const bu = dominantBuFor(key);
  const serviceCategoryId = svcCatIdByCode[bu] || svcCatIdByCode[DEFAULT_SERVICE_CATEGORY];
  out.service.push({
    id,
    name,
    code,
    serviceCategoryId,
    sequence: index + 1,
    estimatedDurationInHours: 24,
    description: name,
    dependencyType: 'independent',
    // Presstoke/Repair/CC-Repair carry no work of their own — every garment
    // under them MUST have an additional (dependent) service attached.
    hasOwnProcess: !isShell,
    isActive: true,
    isDeleted: false,
  });
  serviceIdByKey[key] = id;
});
report.service = out.service.length;
const serviceKeyByServiceId = new Map(
  Object.entries(serviceIdByKey).map(([key, id]) => [id, key]),
);
report.shellServices = SHELL_SERVICES.filter((s) => serviceIdByKey[norm(s)]).join(', ');

// ── Additional charges (order-level) ─────────────────────────────────────────
// AddonServices-OrderLevel is genuinely order-level, flat charges (pickup/drop,
// curtain mounting, extra bag) — these become additional_charge_master rows
// with chargeScope='order'.
const chargeCodes = new Set();
const chargeKeys = new Set();
function addOrderCharge(name, amount) {
  const key = norm(name);
  if (!key || chargeKeys.has(key)) return;
  const code = uniqueCode(slugBase(name).slice(0, 40), chargeCodes);
  out.additional_charge_master.push({
    id: keepId(prevCharge, code),
    name,
    code,
    chargeScope: 'order',
    chargeType: 'standard',
    defaultAmount: Number(amount) || 0,
    isTaxable: true,
    isActive: true,
    isDeleted: false,
  });
  chargeKeys.add(key);
}
sheet('AddonServices-OrderLevel').forEach((r) => {
  const name = String(r['New Name'] || r['Item Name'] || '').trim();
  if (!name) return;
  addOrderCharge(name, r['Base Price']);
});
report.additional_charge_master_orderLevel = out.additional_charge_master.length;

// FORCE_TO_CHARGE sub-types (packaging tiers etc.) become item-scoped charges,
// priced at the lowest amount seen for that sub-type across the price list.
const pricesBySubType = new Map();
price.forEach((r) => {
  const key = norm(r['Service SubType Name']);
  if (!key) return;
  if (!pricesBySubType.has(key)) pricesBySubType.set(key, []);
  const n = Number(r['Base Price']);
  if (Number.isFinite(n)) pricesBySubType.get(key).push(n);
});
FORCE_TO_CHARGE.forEach((displayName) => {
  const key = norm(displayName);
  const prices = pricesBySubType.get(key) || [];
  if (chargeKeys.has(key)) return;
  const code = uniqueCode(slugBase(displayName).slice(0, 40), chargeCodes);
  out.additional_charge_master.push({
    id: keepId(prevCharge, code),
    name: displayName,
    code,
    chargeScope: 'item',
    chargeType: 'standard',
    defaultAmount: prices.length ? Math.min(...prices) : 0,
    isTaxable: true,
    isActive: true,
    isDeleted: false,
  });
  chargeKeys.add(key);
});
report.additional_charge_master = out.additional_charge_master.length;

// ── Service Item Mapping: base services (Clean/Press/...) ──────────────────
// One row per (item, service) at the LOWEST price seen. Shell services
// (Presstoke/Repair/CC-Repair) are excluded here — their pricing is almost
// entirely against a placeholder "X" item (flat per-treatment pricing, not
// item-specific) and is handled separately below via the dependent-service
// broadcast, not as a direct base price on the shell itself.
const best = new Map();
let unmatchedItem = 0;
let placeholderX = 0;
let noService = 0;
const unmatchedItemSamples = new Set();

price.forEach((r) => {
  const svcKey = norm(r['Service Name']);
  if (SHELL_SERVICE_KEYS.has(svcKey)) return; // handled by the broadcast below
  const serviceId = serviceIdByKey[svcKey];
  if (!serviceId) {
    noService += 1;
    return;
  }
  const a = norm(r['New Name']);
  const b = norm(r['Item Name']);
  const itemId = itemByName[a] || itemByName[b] || null;
  if (!itemId) {
    // "X" is a placeholder the source system leaves when no product is named.
    if (a === 'x' || b === 'x') placeholderX += 1;
    else {
      unmatchedItem += 1;
      if (unmatchedItemSamples.size < 12) {
        unmatchedItemSamples.add(String(r['New Name'] || r['Item Name'] || '(blank)').trim());
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
  const svcKey = serviceKeyByServiceId.get(v.serviceId);
  out.service_item_mapping.push({
    id: keepId(prevMapping, key),
    serviceId: v.serviceId,
    itemId: v.itemId,
    basePrice: v.basePrice,
    estimatedDurationInDays: tatDaysForKey(svcKey),
    additionalServiceIds: [],
    isActive: true,
    isDeleted: false,
  });
});
report.service_item_mapping_base = out.service_item_mapping.length;
report.priceRowsTotal = price.length;
report.priceRowsPlaceholderX = placeholderX;
report.priceUnmatchedItem = unmatchedItem;
report.priceNoServiceName = noService;

// ── Dependent services (Presstoke/Repair/CC-Repair addon catalogue) ─────────
// Every non-charge "Service SubType Name" seen under a shell service becomes
// its own dependent Service (dependencyType='dependent') — selectable ONLY as
// an additional service, never as a primary one.
const depServiceIdBySubtype = {}; // shellKey -> {subtypeKey -> serviceId}
const depServiceNameBySubtype = {}; // subtypeKey -> display name
const depServiceCodeSource = new Map(); // subtypeKey -> ServiceCode from AddonServiceListMaster, if any
sheet('AddonServiceListMaster').forEach((a) => {
  const n = norm(a.ServiceDesc);
  if (n && a.ServiceCode) depServiceCodeSource.set(n, String(a.ServiceCode).trim());
});

const depSvcCodes = new Set();
SHELL_SERVICES.forEach((shellName) => {
  depServiceIdBySubtype[norm(shellName)] = {};
});

price.forEach((r) => {
  const svcKey = norm(r['Service Name']);
  if (!SHELL_SERVICE_KEYS.has(svcKey)) return;
  const subtypeRaw = String(r['Service SubType Name'] || '').trim();
  const subtypeKey = norm(subtypeRaw);
  if (!subtypeKey || FORCE_TO_CHARGE_KEYS.has(subtypeKey)) return; // packaging tiers -> already a charge

  if (!depServiceIdBySubtype[svcKey][subtypeKey]) {
    const displayName = subtypeRaw;
    const sourceCode = depServiceCodeSource.get(subtypeKey);
    const code = uniqueCode((sourceCode || slugBase(displayName)).slice(0, 40), depSvcCodes);
    const shellServiceId = serviceIdByKey[svcKey];
    const shellServiceCategoryId = out.service.find((s) => s.id === shellServiceId)?.serviceCategoryId;
    const id = keepId(prevService, `dep:${svcKey}:${subtypeKey}`);
    out.service.push({
      id,
      name: displayName,
      code,
      serviceCategoryId: shellServiceCategoryId || svcCatIdByCode[DEFAULT_SERVICE_CATEGORY],
      sequence: 0,
      estimatedDurationInHours: 24,
      description: `Additional service under ${serviceDisplay.get(svcKey)}`,
      dependencyType: 'dependent',
      hasOwnProcess: true,
      isActive: true,
      isDeleted: false,
    });
    depServiceIdBySubtype[svcKey][subtypeKey] = id;
    depServiceNameBySubtype[subtypeKey] = displayName;
  }
});
report.dependent_services = Object.values(depServiceIdBySubtype).reduce(
  (sum, m) => sum + Object.keys(m).length,
  0,
);

// ── Broadcast dependent-service pricing + wire shell additionalServiceIds ───
// Representative price per (shell, subtype): prefer the lowest price seen
// against a REAL (non-"X") item; fall back to the lowest "X"-row price.
function collectSubtypePrices(shellKey) {
  const realPrice = new Map(); // subtypeKey -> min price seen on a real item
  const anyPrice = new Map(); // subtypeKey -> min price seen at all (incl. "X")
  const realItemsBySubtype = new Map(); // subtypeKey -> Set(itemId) with a real row

  price.forEach((r) => {
    if (norm(r['Service Name']) !== shellKey) return;
    const subtypeKey = norm(r['Service SubType Name']);
    if (!subtypeKey || FORCE_TO_CHARGE_KEYS.has(subtypeKey)) return;
    const amount = Number(r['Base Price']) || 0;
    const a = norm(r['New Name']);
    const b = norm(r['Item Name']);
    const nameKey = a && a !== 'x' ? a : b && b !== 'x' ? b : null;

    if (!anyPrice.has(subtypeKey) || amount < anyPrice.get(subtypeKey)) anyPrice.set(subtypeKey, amount);
    if (nameKey) {
      const itemId = itemByName[nameKey];
      if (itemId) {
        if (!realPrice.has(subtypeKey) || amount < realPrice.get(subtypeKey)) realPrice.set(subtypeKey, amount);
        if (!realItemsBySubtype.has(subtypeKey)) realItemsBySubtype.set(subtypeKey, new Set());
        realItemsBySubtype.get(subtypeKey).add(itemId);
      }
    }
  });

  return {realPrice, anyPrice, realItemsBySubtype};
}

const mappingSeen = new Set(out.service_item_mapping.map((m) => `${m.serviceId}:${m.itemId}`));
function addMapping(serviceId, itemId, basePrice, additionalServiceIds, estimatedDurationInDays) {
  const key = `${serviceId}:${itemId}`;
  if (mappingSeen.has(key)) return;
  mappingSeen.add(key);
  out.service_item_mapping.push({
    id: keepId(prevMapping, key),
    serviceId,
    itemId,
    basePrice,
    estimatedDurationInDays: estimatedDurationInDays ?? 1,
    additionalServiceIds: additionalServiceIds || [],
    isActive: true,
    isDeleted: false,
  });
}

const buGroupByShellKey = {
  repair: 'PSBO',
  'cc-repair': 'CC',
};

// PresstoKe is handled separately below (see "PresstoKe: BU-aware broadcast")
// — its addon prices genuinely differ by business unit, so it can't use the
// single-representative-price sample this loop uses for Repair/CC-Repair.
SHELL_SERVICES.filter((s) => norm(s) !== 'presstoke').forEach((shellName) => {
  const shellKey = norm(shellName);
  const shellServiceId = serviceIdByKey[shellKey];
  const depBySubtype = depServiceIdBySubtype[shellKey] || {};
  const allDepIds = Object.values(depBySubtype);
  if (!shellServiceId || !allDepIds.length) return;

  const {realPrice, anyPrice, realItemsBySubtype} = collectSubtypePrices(shellKey);

  // Item sample this shell service will be made orderable against: every real
  // item named anywhere in its own price rows, plus a top-up sample from its
  // dominant business-unit group so untested/placeholder-only addons still
  // have real items to attach to.
  const namedItems = new Set();
  realItemsBySubtype.forEach((set) => set.forEach((id) => namedItems.add(id)));

  const buGroup = buGroupByShellKey[shellKey] || 'PDC';
  const pool = itemsByBuGroup[buGroup] || [];
  for (const {id} of pool) {
    if (namedItems.size >= SAMPLE_ITEMS_PER_GROUP) break;
    namedItems.add(id);
  }

  // Shell mapping: ₹0 base — all real pricing comes from the additional
  // service(s) attached, exactly like the "leave blank/0 for a free item"
  // convention already used for Repair/Presstoke in the admin panel.
  const shellTatDays = tatDaysForKey(shellKey);
  namedItems.forEach((itemId) => {
    addMapping(shellServiceId, itemId, 0, allDepIds, shellTatDays);
  });

  // Each dependent service gets its own price against every item in the
  // sample, so whichever item + addon combo staff pick, pricing resolves.
  Object.entries(depBySubtype).forEach(([subtypeKey, depServiceId]) => {
    const representativePrice = realPrice.has(subtypeKey)
      ? realPrice.get(subtypeKey)
      : anyPrice.get(subtypeKey) || 0;
    namedItems.forEach((itemId) => {
      addMapping(depServiceId, itemId, representativePrice, [], shellTatDays);
    });
  });
});

// ── PresstoKe: BU-aware broadcast ────────────────────────────────────────
// Every PresstoKe price row is against the "X" placeholder item, tagged with
// a real BU Name (PSBO or PDC) — and the SAME subtype can carry a DIFFERENT
// price per BU (e.g. Darning Medium: ₹641 under PSBO, ₹668 under PDC). So
// unlike Repair/CC-Repair (single BU each, sampled), PresstoKe needs: for
// every subtype, apply its BU-specific price to EVERY item whose category
// falls under that BU — not a small sample, and not one blended price.
{
  const shellKey = 'presstoke';
  const shellServiceId = serviceIdByKey[shellKey];
  const depBySubtype = depServiceIdBySubtype[shellKey] || {};
  const allDepIds = Object.values(depBySubtype);
  if (shellServiceId && allDepIds.length) {
    const shellTatDays = tatDaysForKey(shellKey);

    // subtypeKey -> Map(BU -> min price seen for that BU)
    const priceByBuBySubtype = new Map();
    price.forEach((r) => {
      if (norm(r['Service Name']) !== shellKey) return;
      const subtypeKey = norm(r['Service SubType Name']);
      if (!subtypeKey || FORCE_TO_CHARGE_KEYS.has(subtypeKey)) return;
      const bu = String(r['BU Name'] || '').trim().toUpperCase();
      if (!BU_CATEGORY_NAMES[bu]) return; // ignore rows with no recognised BU
      const amount = Number(r['Base Price']) || 0;
      if (!priceByBuBySubtype.has(subtypeKey)) priceByBuBySubtype.set(subtypeKey, new Map());
      const buMap = priceByBuBySubtype.get(subtypeKey);
      if (!buMap.has(bu) || amount < buMap.get(bu)) buMap.set(bu, amount);
    });

    // Which dependent services are actually priced for each BU — e.g.
    // "Zipper Correction" is PSBO-only, so a PDC item (a Shirt) must NOT be
    // offered it as an additional service: nothing would resolve its price,
    // since no (Zipper Correction, Shirt) mapping row exists. Subtypes with
    // no BU-tagged price row at all fall back to PDC only (matches the ₹0
    // fallback pricing below).
    const depIdsByBu = {PDC: [], PSBO: [], CC: []};
    Object.entries(depBySubtype).forEach(([subtypeKey, depServiceId]) => {
      const buMap = priceByBuBySubtype.get(subtypeKey);
      const bus = buMap && buMap.size ? [...buMap.keys()] : ['PDC'];
      bus.forEach((bu) => depIdsByBu[bu]?.push(depServiceId));
    });

    // Shell mapping (₹0 base) — every item gets ONLY the additional services
    // actually priced for its own BU, never the full cross-BU list.
    Object.entries(depIdsByBu).forEach(([bu, depIds]) => {
      if (!depIds.length) return;
      (itemsByBuGroup[bu] || []).forEach(({id}) => addMapping(shellServiceId, id, 0, depIds, shellTatDays));
    });

    // Each dependent service: its BU-specific price, applied to every item in
    // that BU's category group.
    Object.entries(depBySubtype).forEach(([subtypeKey, depServiceId]) => {
      const buMap = priceByBuBySubtype.get(subtypeKey);
      if (buMap && buMap.size) {
        buMap.forEach((amount, bu) => {
          (itemsByBuGroup[bu] || []).forEach(({id}) => addMapping(depServiceId, id, amount, [], shellTatDays));
        });
      } else {
        // Subtype exists (e.g. from AddonServiceListMaster) but has no priced
        // row under PresstoKe — fall back to ₹0 against the full PDC pool so
        // it's still orderable.
        (itemsByBuGroup.PDC || []).forEach(({id}) => addMapping(depServiceId, id, 0, [], shellTatDays));
      }
    });
  }
}

report.service_item_mapping_total = out.service_item_mapping.length;

fs.writeFileSync(OUT_PATH, JSON.stringify(out, null, 2));

console.log('Source workbook:', path.basename(WB_PATH));
console.log('Wrote', path.relative(process.cwd(), OUT_PATH));
console.log('\n── Summary ──');
Object.entries(report).forEach(([k, v]) => console.log('  ' + k.padEnd(34) + v));
console.log('\n── Mappings per service (POS order) ──');
const perService = {};
out.service_item_mapping.forEach((m) => {
  perService[m.serviceId] = (perService[m.serviceId] || 0) + 1;
});
out.service.forEach((s) => console.log('  ' + s.dependencyType.padEnd(11) + String(perService[s.id] || 0).padStart(4) + '  ' + s.name));
console.log('\n── Items not found in ItemMaster (sample, base services) ──');
[...unmatchedItemSamples].forEach((s) => console.log('  •', s));
