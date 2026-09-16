/* eslint-disable */
/**
 * One-off migration generator: reads the client's
 * Rider_Master_List _Pulse.xlsx and emits `src/data/riders.json`.
 *
 *   node scripts/migrate-riders.cjs
 *
 * Then load it with:  npm run seed:riders
 *
 * The workbook has two overlapping sources for the same underlying
 * roster, confirmed by cross-checking phone numbers between them:
 *   - Four regional sheets (MMR/NCR/BLR/HYD), one row per (store, rider) —
 *     this is the ONLY source that captures a rider covering more than
 *     one store (e.g. one rider assigned to both "Indiranagar" and
 *     "PSB-Indiranagar"), which is the whole point of this seed.
 *   - "Rider List", a flatter one-ish-row-per-rider sheet. 58 of its 58
 *     distinct riders (by phone) also appear in the regional sheets — it
 *     is NOT a superset of store coverage (it collapses multi-store
 *     riders down to one row each) — but it does carry exactly one rider
 *     (Panchsheel Enclave / Arbaaz Khan) missing from the regional
 *     sheets, and the regional sheets carry exactly one (Vasant Vihar /
 *     Shatrughan) missing from Rider List.
 * So: rider IDENTITY and STORE COVERAGE are both taken as the UNION of
 * both sources, deduped by (normalized store name) per rider — nothing
 * from either sheet is dropped.
 *
 * Rows are skipped when: rider name is blank/"NO RIDER"/"No rider", or
 * the phone doesn't normalize to a 10-digit number. A "Cluster" grouping
 * row (blank name/phone) and stray leaked header rows ("Store"/"P2D
 * Rider Name"/"Contact ") are skipped the same way, since they carry no
 * usable name+phone either.
 *
 * Actual store resolution (rider's covered store-name text -> real
 * Store row -> its pincode coverage) happens at SEED time, not here —
 * this script has no DB access. See seed-riders.ts.
 *
 * ID preservation: re-running keeps the same id for any rider whose
 * natural key (normalized phone) still exists in the new workbook, by
 * reading the previously generated JSON first.
 */
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const XLSX = require(path.resolve(__dirname, '../../pressto-admin-panel/node_modules/xlsx'));

const WB_PATH = process.argv[2] || path.resolve(__dirname, '../../Rider_Master_List _Pulse.xlsx');
const OUT_PATH = path.resolve(__dirname, '../src/data/riders.json');

const uuid = () => crypto.randomUUID();

const normPhone = (p) => {
  if (p == null) return null;
  const digits = String(p).replace(/\D/g, '');
  return digits.length === 10 ? digits : null;
};
const normStore = (s) => (s == null ? null : String(s).trim().replace(/\s+/g, ' '));
const isNoRider = (name) => {
  const n = String(name || '').trim().toLowerCase();
  return !n || n === 'no rider' || n === 'norider';
};

// ── ID preservation ──────────────────────────────────────────────────────────
let prev = {riders: []};
try {
  prev = JSON.parse(fs.readFileSync(OUT_PATH, 'utf8'));
} catch {
  prev = {riders: []};
}
const prevIdByPhone = new Map((prev.riders || []).map((r) => [r.phone, r.id]));
const keepId = (phone) => prevIdByPhone.get(phone) || uuid();

// ── Read ─────────────────────────────────────────────────────────────────────
if (!fs.existsSync(WB_PATH)) {
  console.error('Workbook not found:', WB_PATH);
  process.exit(1);
}
const wb = XLSX.readFile(WB_PATH);

/** header rows differ per sheet (some have a leading region-title row) — pass the column index for Store/Name/Phone explicitly. */
function readSheetRows(sheetName, dataStartRow, cols) {
  const ws = wb.Sheets[sheetName];
  if (!ws) {
    console.error(`Sheet "${sheetName}" not found.`);
    return [];
  }
  const rows = XLSX.utils.sheet_to_json(ws, {header: 1, defval: null});
  return rows.slice(dataStartRow).map((r) => ({
    storeRaw: normStore(r[cols.store]),
    nameRaw: r[cols.name],
    phoneRaw: r[cols.phone],
  }));
}

const allRows = [
  ...readSheetRows('MMR', 1, {store: 1, name: 2, phone: 3}),
  ...readSheetRows('NCR', 2, {store: 1, name: 2, phone: 3}),
  ...readSheetRows('BLR', 2, {store: 1, name: 2, phone: 3}),
  ...readSheetRows('HYD', 2, {store: 1, name: 2, phone: 3}),
  ...readSheetRows('Rider List', 1, {store: 1, name: 2, phone: 3}),
];

// ── Build riders (by phone) + coverage (rider phone -> distinct store names) ──
const riderByPhone = new Map(); // phone -> {name}
const coverageByPhone = new Map(); // phone -> Set<storeRaw>

for (const row of allRows) {
  const phone = normPhone(row.phoneRaw);
  if (!phone || isNoRider(row.nameRaw)) continue;
  const name = String(row.nameRaw).trim().replace(/\s+/g, ' ');

  if (!riderByPhone.has(phone)) riderByPhone.set(phone, {name});

  if (row.storeRaw) {
    if (!coverageByPhone.has(phone)) coverageByPhone.set(phone, new Set());
    coverageByPhone.get(phone).add(row.storeRaw);
  }
}

const riders = [...riderByPhone.entries()].map(([phone, {name}]) => {
  const parts = name.split(' ').filter(Boolean);
  const firstName = parts[0] || name;
  const lastName = parts.slice(1).join(' ') || '-';
  return {
    id: keepId(phone),
    phone,
    firstName,
    lastName,
    storeNames: [...(coverageByPhone.get(phone) || [])],
  };
});

const totalCoveragePairs = riders.reduce((sum, r) => sum + r.storeNames.length, 0);

fs.writeFileSync(OUT_PATH, JSON.stringify({riders}, null, 2));
console.log(`Wrote ${riders.length} riders (${totalCoveragePairs} rider-store coverage pairs) to ${OUT_PATH}`);
