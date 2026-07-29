import {presstoBackendApplication} from './application';
import {
  PermissionsRepository,
  RolePermissionsRepository,
  RolesRepository,
} from './repositories';

// ─────────────────────────────────────────────────────────────────────────
// Incremental, additive-only permission patch.
//
// seed.ts is the authoritative source of truth for every role's FULL
// permission set — re-running it prunes any permission a locked role
// (manager/asm/store_exec/finance) holds that isn't listed there. That's
// fine on a fresh environment, but risky against a live database where
// permissions may have been hand-tuned since via the admin UI's Role
// Permissions screen: a full reseed would silently strip those.
//
// This script instead only ADDS the permissions listed below, and only
// grants them to roles — it never removes an existing role-permission link,
// so it's safe to run against a database that's already diverged from
// seed.ts's role definitions.
//
// Add a new block here each time a controller gains a permission after the
// initial seed, instead of relying on a full `npm run seed` re-run.
//
// Run: npm run seed:new-permissions
// ─────────────────────────────────────────────────────────────────────────

const NEW_PERMISSIONS: {permission: string; description: string}[] = [
  // Customer Address (see CustomerAddressController)
  {permission: 'customer_address:create', description: 'Add a customer address'},
  {permission: 'customer_address:read',   description: 'View customer addresses'},
  {permission: 'customer_address:update', description: 'Update a customer address'},
  {permission: 'customer_address:delete', description: 'Delete a customer address'},
  // Customer Phone (see CustomerPhoneController)
  {permission: 'customer_phone:create', description: 'Add a customer phone number'},
  {permission: 'customer_phone:read',   description: 'View customer phone numbers'},
  {permission: 'customer_phone:update', description: 'Update a customer phone number'},
  {permission: 'customer_phone:delete', description: 'Delete a customer phone number'},
];

// Which of the permissions above each role should get. Mirrors the access
// level each role already has on the sibling `customer` resource in
// seed.ts's ROLES table (manager: full CRUD, store_exec/counter_staff: no
// delete, asm/finance: read-only). super_admin needs nothing — it bypasses
// every permission check. Any role not listed here is left untouched.
const ROLE_GRANTS: {roleValue: string; permissions: string[]}[] = [
  {
    roleValue: 'manager',
    permissions: [
      'customer_address:create', 'customer_address:read', 'customer_address:update', 'customer_address:delete',
      'customer_phone:create', 'customer_phone:read', 'customer_phone:update', 'customer_phone:delete',
    ],
  },
  {
    roleValue: 'store_exec',
    permissions: [
      'customer_address:create', 'customer_address:read', 'customer_address:update',
      'customer_phone:create', 'customer_phone:read', 'customer_phone:update',
    ],
  },
  {
    roleValue: 'counter_staff',
    permissions: [
      'customer_address:create', 'customer_address:read', 'customer_address:update',
      'customer_phone:create', 'customer_phone:read', 'customer_phone:update',
    ],
  },
  {roleValue: 'asm', permissions: ['customer_address:read', 'customer_phone:read']},
  {roleValue: 'finance', permissions: ['customer_address:read', 'customer_phone:read']},
];

export async function seedNewPermissions() {
  const app = new presstoBackendApplication();
  await app.boot();
  await app.start();

  const permRepo = await app.getRepository(PermissionsRepository);
  const roleRepo = await app.getRepository(RolesRepository);
  const rolePermRepo = await app.getRepository(RolePermissionsRepository);

  // ── 1. Insert any permission not already present ───────────────────────
  let permInserted = 0;
  let permSkipped = 0;
  for (const entry of NEW_PERMISSIONS) {
    const exists = await permRepo.findOne({where: {permission: entry.permission}});
    if (exists) {
      permSkipped++;
      continue;
    }
    await permRepo.create({...entry, isActive: true, isDeleted: false});
    permInserted++;
  }
  console.log(`Permissions — inserted: ${permInserted}, already present: ${permSkipped}`);

  // ── 2. Grant to roles — additive only, never prunes ────────────────────
  let linksInserted = 0;
  let linksSkipped = 0;

  for (const {roleValue, permissions} of ROLE_GRANTS) {
    const role = await roleRepo.findOne({where: {value: roleValue}});
    if (!role) {
      console.warn(`  ⚠ role "${roleValue}" not found — skipped`);
      continue;
    }

    const existingLinks = await rolePermRepo.find({where: {rolesId: role.id}});
    const existingPermIds = new Set(existingLinks.map(l => l.permissionsId));
    let grantedForRole = 0;

    for (const permission of permissions) {
      const perm = await permRepo.findOne({where: {permission}});
      if (!perm) {
        console.warn(`  ⚠ permission "${permission}" not found — skipped`);
        continue;
      }
      if (existingPermIds.has(perm.id)) {
        linksSkipped++;
        continue;
      }

      await rolePermRepo.create({
        rolesId: role.id,
        permissionsId: perm.id,
        isActive: true,
        isDeleted: false,
      });
      linksInserted++;
      grantedForRole++;
    }

    console.log(`  • ${roleValue.padEnd(18)} — granted ${grantedForRole} new permission(s)`);
  }

  console.log(`Role-permission links — inserted: ${linksInserted}, already present: ${linksSkipped}`);
  console.log('New permissions seed complete.');
  await app.stop();
  process.exit(0);
}

seedNewPermissions().catch(err => {
  console.error('New permissions seed failed:', err);
  process.exit(1);
});
