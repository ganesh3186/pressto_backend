/* eslint-disable */
/**
 * One-off migration generator: reads the client's "Pulse Role and Access
 * Matrix_V01_290726.xlsx" and emits `src/data/role-permissions.json`.
 *
 *   node scripts/migrate-role-permissions.cjs
 *
 * Then load it with:  npm run seed:role-permissions
 *
 * Scope, confirmed with the client before building this (see commit
 * message / conversation for the full reasoning):
 *   - SEED ONLY. No backend controller is touched — every new permission
 *     below is inert until a later pass wires the matching @authorize
 *     decorators. Access stays exactly as broad as it is today.
 *   - Only the "OPERATION" section (14 rows) has real per-role
 *     differentiation in the sheet. The other 89 rows (REPORTS/MASTERS/
 *     ADMINISTRATION) show access for Admin (IT) ONLY — every other role,
 *     including MD/CEO, is blank in the sheet itself. Seeded exactly as
 *     written.
 *   - Rows with no corresponding Pressto feature at all (most of the 36
 *     reports, several masters, most ADMINISTRATION items) are skipped
 *     entirely — no point creating a permission nothing can ever check.
 *   - The sheet's own note ("Transaction Deletion Access Disabled Across
 *     All Roles") is read narrowly: it caps the OPERATION section's
 *     numeric level 4 down to 3 (no delete, ever, on transactional
 *     records like orders/invoices/deliveries). MASTERS/ADMINISTRATION
 *     rows are reference/config data, not transactions, so a literal "4"
 *     there (only ever Admin (IT)) keeps its delete suffix.
 *
 * Level legend from the sheet: 1=View, 2=Create/View, 3=Create/View/
 * Update, 4=Create/View/Update/Delete. Reports are read-only by nature
 * regardless of the numeric level shown (matches the existing
 * report_*:read permissions already in the DB — none of them have a
 * create/update/delete counterpart).
 *
 * ROW_MAP below is the actual mapping decision per sheet row — built by
 * hand against the real 221-row `permissions` table (see
 * scripts/migrate-role-permissions.cjs's own commit for the full
 * cross-reference), not derived mechanically. Two kinds of entries:
 *   - reuse: {permissions: [...]} — existing permission(s), applied
 *     whenever the cell's level is >= the listed threshold.
 *   - new: {newPermissions: [...]} — permission(s) that don't exist yet,
 *     created once (idempotent, matched by string) and applied the same
 *     way.
 * `action` entries (approve-style) are granted at level >= 3 (matches the
 * existing petty_cash_register:update's own "Approve" semantics) rather
 * than following the create/read/update ladder, since approving isn't a
 * CRUD action.
 */
const path = require('path');
const fs = require('fs');

const XLSX = require(path.resolve(__dirname, '../../pressto-admin-panel/node_modules/xlsx'));

const WB_PATH = process.argv[2] || path.resolve(__dirname, '../../Pulse Role and Access Matrix_V01_290726.xlsx');
const OUT_PATH = path.resolve(__dirname, '../src/data/role-permissions.json');

// Column order in the sheet (row 7), left to right starting at column D
// (index 3 in a 0-based row array sliced from column B).
const ROLE_COLUMNS = [
  {sheetCol: 3, roleValue: 'rider'},
  {sheetCol: 4, roleValue: 'cce'},
  {sheetCol: 5, roleValue: 'cci'},
  {sheetCol: 6, roleValue: 'store-manager-sm'},
  {sheetCol: 7, roleValue: 'manager-asm'},
  {sheetCol: 8, roleValue: 'regional-manager'},
  {sheetCol: 9, roleValue: 'hop'},
  {sheetCol: 10, roleValue: 'pulse_finance'},
  // Genuinely new roles — no existing equivalent (checked against staging).
  {sheetCol: 11, roleValue: 'marketing', label: 'Marketing'},
  {sheetCol: 12, roleValue: 'scm', label: 'SCM'},
  {sheetCol: 13, roleValue: 'md_ceo', label: 'MD/CEO'},
  {sheetCol: 14, roleValue: 'admin_it', label: 'Admin (IT)'},
];
// All four already carry "All Stores" scope per the client's own Roles
// sheet from the earlier Users & Roles pass — hardcoded into
// StoreScopeService.GLOBAL_ROLES alongside hop/pulse_finance/management,
// not modeled as a Roles.scope value (see that file for why).
const NEW_GLOBAL_ROLES = ['marketing', 'scm', 'md_ceo', 'admin_it'];

const CRUD = ['create', 'read', 'update', 'delete'];
// Legend: 1=View, 2=Create/View, 3=Create/View/Update, 4=Create/View/
// Update/Delete — NOT a plain slice of CRUD (level 1 is "read" alone,
// not "create" alone), so the ladder is spelled out explicitly.
const LEVEL_LADDER = {
  1: ['read'],
  2: ['create', 'read'],
  3: ['create', 'read', 'update'],
  4: ['create', 'read', 'update', 'delete'],
};
// level -> which CRUD suffixes are implied, capped at 3 (no delete) for
// OPERATION rows per the sheet's own transaction-deletion note.
function impliedSuffixes(level, { capDelete = false, validSuffixes = CRUD } = {}) {
  if (!level || level < 1) return [];
  const cappedLevel = capDelete ? Math.min(level, 3) : level;
  const ladder = LEVEL_LADDER[cappedLevel] || LEVEL_LADDER[4];
  return ladder.filter((s) => validSuffixes.includes(s));
}

// resource: existing permission prefix already in the DB, or null to mint one.
// kind: 'crud' (apply impliedSuffixes) | 'action' (single permission, granted at level >= actionThreshold) | 'read-only' (reports).
const ROW_MAP = {
  // ── OPERATION ─────────────────────────────────────────────────────────
  'Order': { resource: 'order', kind: 'crud', capDelete: true, validSuffixes: ['create', 'read', 'update'] },
  'Tax Invoice': { resource: 'invoice', kind: 'crud', isNew: true, validSuffixes: ['read', 'update'] },
  'Delivery': { resource: 'delivery', kind: 'crud', validSuffixes: ['read', 'update'] },
  'Order Return': { resource: 'order_return', kind: 'crud', isNew: true, validSuffixes: ['create', 'read', 'update'] },
  // Credit Note is the exact same feature/access pattern as Sales Return
  // in this sheet (identical numbers for every role) — reuses the same
  // new permission rather than minting a duplicate resource.
  'Sales Return': { resource: 'sales_return', kind: 'crud', isNew: true, validSuffixes: ['create', 'read'] },
  'Credit Note': { resource: 'sales_return', kind: 'crud', isNew: true, validSuffixes: ['create', 'read'] },
  'Sales & Order Return Approval': { resource: 'sales_return', kind: 'action', action: 'approve', isNew: true, actionThreshold: 3 },
  'Petty Cash - Add Budget Amount': { resource: 'petty_cash_finance', kind: 'crud', validSuffixes: ['create'] },
  'Petty Cash - Expense Booking': { resource: 'petty_cash_register', kind: 'crud', validSuffixes: ['create'] },
  'Petty Cash Approval': { resource: 'petty_cash_register', kind: 'action', action: 'update', actionThreshold: 3 },
  'Shift Opening / Closur (Hand Over)': { resource: 'shift', kind: 'crud', validSuffixes: ['create', 'update'] },
  'Re-Print Garment Label / Order': { resource: 'label_reprint', kind: 'crud', isNew: true, validSuffixes: ['create'] },
  'Warehouse - Item Transfer / Recived': { resource: 'transfer', kind: 'crud', validSuffixes: ['create', 'read', 'update'] },
  // Intra-store transfer has no distinct Pressto feature (separate from
  // interstore `transfer:*`) — skipped, not mapped.

  // ── REPORTS (Admin (IT) only per the sheet; read-only by nature) ───────
  'Consodidated Daily Sales Report (NEW) >> ERP': { resource: 'report_consolidated_daily_sales', kind: 'read-only' },
  'Mode Of Payment Report': { resource: 'report_mode_of_payment', kind: 'read-only' },
  'On Account Billing Report': { resource: 'report_on_account_billing', kind: 'read-only' },
  'Pending Payments Report': { resource: 'report_pending_payments', kind: 'read-only' },
  'Pending Tickets Report': { resource: 'report_pending_tickets', kind: 'read-only' },
  'Petty Cash Expense Summary Report': { resource: 'report_petty_cash_expense', kind: 'read-only' },

  // ── MASTERS (Admin (IT) only per the sheet) ────────────────────────────
  'Cluster Master': { resource: 'cluster', kind: 'crud' },
  'Region Master': { resource: 'region', kind: 'crud' },
  'Store Master': { resource: 'store', kind: 'crud' },
  'Colour Master': { resource: 'color', kind: 'crud' },
  'Customer Discount Group Master': { resource: 'customer_discount_group', kind: 'crud' },
  'Customer Group Master': { resource: 'customer_label', kind: 'crud' },
  'Customer Master': { resource: 'customer', kind: 'crud' },
  'Item Master': { resource: 'item', kind: 'crud' },
  'Service Master': { resource: 'service', kind: 'crud' },
  'Price List Master': { resource: 'price_list', kind: 'crud' },
  'Promotion Master': { resource: 'coupon', kind: 'crud' },
  'Role Master': { resource: 'role', kind: 'crud' },
  'User Master': { resource: 'employee', kind: 'crud' },
  // Business Unit / Default Remarks / Sales Return Remark / HSN Code /
  // Petty Cash Reason / Pincode / Store Category / Store Mapping / Store
  // Status / Store Type Master: no corresponding Pressto model — skipped.

  // ── ADMINISTRATION (Admin (IT) only per the sheet) ─────────────────────
  'Price Lists': { resource: 'price_list', kind: 'crud' },
  'Store Configuration': { resource: 'store', kind: 'crud' },
  'Tax configuration': { resource: 'gst_tax_configuration', kind: 'crud' },
  // Everything else in ADMINISTRATION (associate discount/customer groups
  // to store, batch delete, bulk price update, master data export/
  // import/update, password reset, price hierarchy, printer config,
  // revenue targets, database backup): no corresponding Pressto feature
  // — skipped.
};

function readMatrix(wb) {
  const ws = wb.Sheets['ROLE & ACCESS'];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null, range: 'B7:P103' });
  const header = rows[0];
  const dataRows = rows.slice(1);
  return dataRows
    .map((row) => ({ name: row[1] ? String(row[1]).trim() : null, type: row[2], cells: row }))
    .filter((row) => row.name && !['O', 'R', 'M', 'A'].every((t) => t !== row.type) === false || true)
    // Section header rows have Sr.No blank AND their name is the all-caps
    // section title (OPERATION/REPORTS/MASTERS/ADMINISTRATION) — those,
    // and fully blank spacer rows, are dropped; every real line item has
    // a Sr. No.
    .filter((row) => row.cells[0] != null && row.name);
}

if (!fs.existsSync(WB_PATH)) {
  console.error('Workbook not found:', WB_PATH);
  process.exit(1);
}
const wb = XLSX.readFile(WB_PATH);
const matrixRows = readMatrix(wb);
console.log(`Read ${matrixRows.length} line items from the matrix.`);

const newPermissionsSet = new Map(); // permission string -> description
const rolePermissionPairs = new Set(); // "roleValue::permission"
const unmappedRows = [];

for (const row of matrixRows) {
  const mapping = ROW_MAP[row.name];
  if (!mapping) {
    unmappedRows.push(row.name);
    continue;
  }

  for (const { sheetCol, roleValue } of ROLE_COLUMNS) {
    const level = row.cells[sheetCol];
    if (level == null) continue;

    let grantedPermissions = [];
    if (mapping.kind === 'read-only') {
      grantedPermissions = [`${mapping.resource}:read`];
    } else if (mapping.kind === 'action') {
      if (Number(level) >= (mapping.actionThreshold || 3)) {
        grantedPermissions = [`${mapping.resource}:${mapping.action}`];
      }
    } else {
      const suffixes = impliedSuffixes(Number(level), {
        capDelete: Boolean(mapping.capDelete),
        validSuffixes: mapping.validSuffixes || CRUD,
      });
      grantedPermissions = suffixes.map((s) => `${mapping.resource}:${s}`);
    }

    for (const permission of grantedPermissions) {
      if (mapping.isNew && !newPermissionsSet.has(permission)) {
        newPermissionsSet.set(permission, `${row.name} (from Pulse Role and Access Matrix)`);
      }
      rolePermissionPairs.add(`${roleValue}::${permission}`);
    }
  }
}

const newPermissions = [...newPermissionsSet.entries()].map(([permission, description]) => ({
  permission,
  description,
}));
const rolePermissions = [...rolePermissionPairs].map((pair) => {
  const [roleValue, permission] = pair.split('::');
  return { roleValue, permission };
});
const newRoles = ROLE_COLUMNS.filter((c) => c.label).map((c) => ({
  value: c.roleValue,
  label: c.label,
  global: NEW_GLOBAL_ROLES.includes(c.roleValue),
}));

fs.writeFileSync(
  OUT_PATH,
  JSON.stringify({ newRoles, newPermissions, rolePermissions }, null, 2),
);
console.log(`New roles: ${newRoles.length}`);
console.log(`New permissions: ${newPermissions.length} — ${newPermissions.map((p) => p.permission).join(', ')}`);
console.log(`Role-permission assignments: ${rolePermissions.length}`);
if (unmappedRows.length) {
  console.log(`\nSkipped (no matching Pressto feature), ${unmappedRows.length} rows:`);
  console.log('  ' + unmappedRows.join('\n  '));
}
console.log(`\nWrote ${OUT_PATH}`);
