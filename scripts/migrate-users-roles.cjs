/* eslint-disable */
/**
 * One-off migration generator: reads the client's "Pulse Users and
 * Roles.xlsx" and emits `src/data/users-roles.json`.
 *
 *   node scripts/migrate-users-roles.cjs
 *
 * Then load it with:  npm run seed:users-roles
 *
 * Role -> scope mapping (from the workbook's own "Roles" sheet, folded
 * into DB-supported scopes — see notes/decisions this was built against):
 *   SM, CCE, CCI, PMU  -> store   (employee.storeId = their PRIMARY store —
 *                                   several people list more than one store
 *                                   code, e.g. "ST005,ST006,ST016"; only the
 *                                   first is kept, by explicit decision —
 *                                   Employee has no multi-store binding)
 *   AM                 -> cluster (employee.clusterId, resolved from their
 *                                   primary store's cluster at seed time)
 *   RM                 -> region  (employee.regionId, resolved from their
 *                                   primary store's cluster's region)
 *   HOP, Finance, Management -> "all stores": the workbook calls this scope
 *                                   for HOP/Finance/Marketing/SCM/MD-CEO/
 *                                   Admin(IT), but Roles.scope has no
 *                                   'global' value and a Cluster can only
 *                                   belong to one Region (so 'region' scope
 *                                   can never actually cover ALL stores for
 *                                   one employee). By explicit decision,
 *                                   these three role VALUES are instead
 *                                   hardcoded into StoreScopeService's
 *                                   GLOBAL_ROLES set (see store-scope.service.ts)
 *                                   — same bypass super_admin already uses.
 *                                   Their employee row gets no store/
 *                                   cluster/region binding at all.
 *
 * Role VALUE assignment: the client's own labels, lowercased, except
 * Finance -> 'pulse_finance' (the platform already has a distinct, locked
 * system role with value 'finance' with different, store-scoped behavior
 * — reusing it would silently widen access for whoever else already
 * holds it; a separate value avoids that entirely).
 *
 * Dummy phone numbers: every row's "Phone Number" column is blank in the
 * source workbook. Generated as '9' followed by the employee's own code
 * zero-padded to 9 digits (e.g. employeeCode 542 -> 9000000542) —
 * guaranteed unique per employee (employeeCode is unique in the sheet)
 * and, with 7 padding zeros right after the leading 9, essentially never
 * collides with a real assigned Indian mobile number.
 *
 * ID preservation: re-running keeps the same id for any employee whose
 * natural key (employeeCode) still exists in the new sheet.
 */
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const XLSX = require(path.resolve(__dirname, '../../pressto-admin-panel/node_modules/xlsx'));

const WB_PATH = process.argv[2] || path.resolve(__dirname, '../../Pulse Users and Roles.xlsx');
const OUT_PATH = path.resolve(__dirname, '../src/data/users-roles.json');

const uuid = () => crypto.randomUUID();

const ROLE_DEFS = {
  SM: {value: 'sm', label: 'SM', scope: 'store'},
  CCE: {value: 'cce', label: 'CCE', scope: 'store'},
  CCI: {value: 'cci', label: 'CCI', scope: 'store'},
  PMU: {value: 'pmu', label: 'PMU', scope: 'store'},
  AM: {value: 'am', label: 'AM', scope: 'cluster'},
  RM: {value: 'rm', label: 'RM', scope: 'region'},
  HOP: {value: 'hop', label: 'HOP', scope: 'global'},
  Finance: {value: 'pulse_finance', label: 'Finance', scope: 'global'},
  Management: {value: 'management', label: 'Management', scope: 'global'},
};

// ── ID preservation ──────────────────────────────────────────────────────────
let prev = {employees: []};
try {
  prev = JSON.parse(fs.readFileSync(OUT_PATH, 'utf8'));
} catch {
  prev = {employees: []};
}
const prevIdByEmployeeCode = new Map((prev.employees || []).map((e) => [e.employeeCode, e.id]));
const keepId = (employeeCode) => prevIdByEmployeeCode.get(employeeCode) || uuid();

// Manual Excel-serial -> ISO date conversion. The xlsx package's own
// `cellDates` option was tried first and produced a WRONG date (off by
// one, with a bogus ~18:30 time component — e.g. serial 33038, whose
// cell literally displays "6/14/90", came back as 1990-06-13T18:29:50Z)
// for this specific workbook — some precision/epoch quirk in that
// codepath, not a timezone issue (reproduced identically under
// {UTC: true} too). Converting the raw numeric serial directly, with
// Excel's well-known epoch (serial 0 = 1899-12-30, which already bakes
// in Excel's fake 1900-leap-year bug), verified correct against this
// exact cell before trusting it for the rest of the sheet.
function toIsoDate(serial) {
  if (serial == null || serial === '') return undefined;
  const num = Number(serial);
  if (!Number.isFinite(num)) return undefined;
  const utcDays = Math.floor(num - 25569);
  const d = new Date(utcDays * 86400 * 1000);
  if (Number.isNaN(d.getTime())) return undefined;
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function splitName(fullName) {
  const parts = String(fullName || '').trim().split(/\s+/).filter(Boolean);
  return {
    firstName: parts[0] || 'Employee',
    lastName: parts.slice(1).join(' ') || '-',
  };
}

// ── Read ─────────────────────────────────────────────────────────────────────
if (!fs.existsSync(WB_PATH)) {
  console.error('Workbook not found:', WB_PATH);
  process.exit(1);
}
const wb = XLSX.readFile(WB_PATH);
const ws = wb.Sheets['Users'];
if (!ws) {
  console.error('Sheet "Users" not found in workbook.');
  process.exit(1);
}
const rows = XLSX.utils.sheet_to_json(ws, {defval: null});

const employees = [];
let skippedUnknownRole = 0;
for (const row of rows) {
  const roleLabel = String(row['Role'] || '').trim();
  const roleDef = ROLE_DEFS[roleLabel];
  if (!roleDef) {
    skippedUnknownRole += 1;
    console.log(`  skipping row with unmapped role "${roleLabel}" (employee code ${row['Employee Code']})`);
    continue;
  }

  // The sheet's own code is a bare number (e.g. "861") — doesn't match this
  // platform's EMP-prefixed format (EMP0861, same as EmployeeController's own
  // generator, just zero-padded to the sheet's own widest code instead of a
  // fixed 3 digits, since several of these already run past 999).
  const employeeCodeRaw = String(row['Employee Code'] || '').trim();
  const employeeCode = `EMP${employeeCodeRaw.padStart(4, '0')}`;
  const {firstName, lastName} = splitName(row['Name']);
  const storeRaw = String(row['Store'] || '')
    .replace(/[\r\n]+/g, '')
    .trim();
  const storeCodes = storeRaw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  employees.push({
    id: keepId(employeeCode),
    employeeCode,
    roleValue: roleDef.value,
    firstName,
    lastName,
    email: row['Email Address'] ? String(row['Email Address']).trim() : undefined,
    countryCode: '+91',
    // Derived from the sheet's raw numeric code, not the EMP-prefixed one
    // above — keeps the dummy phone purely numeric.
    dummyPhone: `9${employeeCodeRaw.padStart(9, '0')}`,
    dateOfBirth: toIsoDate(row['DOB']),
    joiningDate: toIsoDate(row['DOJ']),
    password: row['Password'] ? String(row['Password']).trim() : 'pressto123',
    addressLine1: row['Address Line 1'] ? String(row['Address Line 1']).trim() : undefined,
    addressLine2: row['Address Line 2'] ? String(row['Address Line 2']).trim() : undefined,
    city: row['City'] ? String(row['City']).trim() : undefined,
    state: row['State'] ? String(row['State']).trim() : undefined,
    pincode: row['Pincode'] != null ? String(row['Pincode']).trim() : undefined,
    primaryStoreCode: storeCodes[0],
    allStoreCodesRaw: storeRaw,
  });
}

const roles = Object.values(ROLE_DEFS).map((r) => ({value: r.value, label: r.label, scope: r.scope}));

fs.writeFileSync(OUT_PATH, JSON.stringify({roles, employees}, null, 2));
console.log(`Wrote ${roles.length} roles and ${employees.length} employees to ${OUT_PATH}`);
if (skippedUnknownRole) {
  console.log(`Skipped ${skippedUnknownRole} row(s) with an unmapped role label.`);
}
