import fs from 'fs';
import path from 'path';
import {presstoBackendApplication} from './application';
import {PermissionsRepository, RolePermissionsRepository, RolesRepository} from './repositories';

/**
 * Role & permission reseeder (`role-permissions.json`, produced by
 * scripts/migrate-role-permissions.cjs from
 * "Pulse Role and Access Matrix_V01_290726.xlsx").
 *
 *   npm run seed:role-permissions
 *
 * Additive-only, same posture as seed-new-permissions.ts: inserts a
 * permission only if it doesn't already exist by string, upserts the 4
 * new roles by value, and only ADDS role-permission links — never prunes
 * an existing one. Safe to rerun.
 *
 * This is a SEED, not enforcement — none of these permissions have a
 * matching @authorize decorator added in this pass (confirmed scope with
 * the client). Access stays exactly as broad as it is today until a
 * later pass wires each one in.
 */
const SEED_FILE = path.join(__dirname, 'data/role-permissions.json');

interface RoleRow {
  value: string;
  label: string;
  global: boolean;
}
interface PermissionRow {
  permission: string;
  description: string;
}
interface RolePermissionRow {
  roleValue: string;
  permission: string;
}

async function seedRolePermissions() {
  if (!fs.existsSync(SEED_FILE)) {
    console.error('Seed file not found:', SEED_FILE);
    console.error('Run: node scripts/migrate-role-permissions.cjs');
    process.exit(1);
  }
  const {
    newRoles,
    newPermissions,
    rolePermissions,
  }: {newRoles: RoleRow[]; newPermissions: PermissionRow[]; rolePermissions: RolePermissionRow[]} = JSON.parse(
    fs.readFileSync(SEED_FILE, 'utf8'),
  );

  const app = new presstoBackendApplication();
  await app.boot();
  await app.start();

  const roleRepo = await app.getRepository(RolesRepository);
  const permRepo = await app.getRepository(PermissionsRepository);
  const rolePermRepo = await app.getRepository(RolePermissionsRepository);

  // ── 1. Roles: upsert by value ───────────────────────────────────────────
  console.log('Upserting roles…');
  let rolesCreated = 0;
  for (const r of newRoles) {
    const existing = await roleRepo.findOne({where: {value: r.value}});
    if (existing) {
      await roleRepo.updateById(existing.id, {label: r.label});
      continue;
    }
    // scope is a placeholder for these — all 4 are global-access roles
    // bypassed via StoreScopeService.GLOBAL_ROLES, same as
    // hop/pulse_finance/management (see that file for why 'store' rather
    // than widening the Roles.scope enum for a 'global' value).
    await roleRepo.create({
      value: r.value,
      label: r.label,
      description: 'Client-defined role, seeded from Pulse Role and Access Matrix.',
      isLocked: false,
      loginAccess: true,
      scope: 'store',
      isActive: true,
      isDeleted: false,
    });
    rolesCreated++;
  }
  console.log(`  ${newRoles.length} role(s) processed, ${rolesCreated} newly created.`);

  // ── 2. Permissions: insert if missing ───────────────────────────────────
  console.log('Inserting new permissions…');
  let permInserted = 0;
  let permSkipped = 0;
  for (const entry of newPermissions) {
    const exists = await permRepo.findOne({where: {permission: entry.permission}});
    if (exists) {
      permSkipped++;
      continue;
    }
    await permRepo.create({...entry, isActive: true, isDeleted: false});
    permInserted++;
  }
  console.log(`  Permissions — inserted: ${permInserted}, already present: ${permSkipped}`);

  // ── 3. Role-permission links: additive only ─────────────────────────────
  console.log('Granting role-permission links…');
  let linksInserted = 0;
  let linksSkipped = 0;
  const missingRoles = new Set<string>();
  const missingPermissions = new Set<string>();

  const roleCache = new Map<string, {id: string}>();
  const permCache = new Map<string, {id: string}>();
  const existingLinksByRole = new Map<string, Set<string>>();

  for (const {roleValue, permission} of rolePermissions) {
    let role = roleCache.get(roleValue);
    if (!role) {
      const found = await roleRepo.findOne({where: {value: roleValue}});
      if (!found) {
        missingRoles.add(roleValue);
        continue;
      }
      role = {id: found.id};
      roleCache.set(roleValue, role);
    }

    let perm = permCache.get(permission);
    if (!perm) {
      const found = await permRepo.findOne({where: {permission}});
      if (!found) {
        missingPermissions.add(permission);
        continue;
      }
      perm = {id: found.id};
      permCache.set(permission, perm);
    }

    let existingPermIds = existingLinksByRole.get(role.id);
    if (!existingPermIds) {
      const links = await rolePermRepo.find({where: {rolesId: role.id}});
      existingPermIds = new Set(links.map(l => l.permissionsId));
      existingLinksByRole.set(role.id, existingPermIds);
    }
    if (existingPermIds.has(perm.id)) {
      linksSkipped++;
      continue;
    }

    await rolePermRepo.create({rolesId: role.id, permissionsId: perm.id, isActive: true, isDeleted: false});
    existingPermIds.add(perm.id);
    linksInserted++;
  }

  console.log(`  Role-permission links — inserted: ${linksInserted}, already present: ${linksSkipped}`);
  if (missingRoles.size) console.log(`  ⚠ role(s) not found, skipped: ${[...missingRoles].join(', ')}`);
  if (missingPermissions.size) {
    console.log(`  ⚠ permission(s) not found, skipped: ${[...missingPermissions].join(', ')}`);
  }

  console.log('Role & permission seed complete.');
  await app.stop();
  process.exit(0);
}

seedRolePermissions().catch(err => {
  console.error('Role & permission seed failed:', err);
  process.exit(1);
});
