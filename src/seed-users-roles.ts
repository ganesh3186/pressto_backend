import fs from 'fs';
import path from 'path';
import {presstoBackendApplication} from './application';
import {BcryptHasher} from './services/hash.password.bcrypt';
import * as Repos from './repositories';

/**
 * Staff roster reseeder (`users-roles.json`, produced by
 * scripts/migrate-users-roles.cjs from "Pulse Users and Roles.xlsx").
 *
 *   npm run seed:users-roles
 *
 * Roles: upserted by value (create if missing, refresh label/scope if an
 * earlier run already created them) — never locked, since these are the
 * client's own operational roles, not platform system roles.
 *
 * Employees: upserted by employeeCode (their real HR code from the
 * sheet, kept as-is rather than regenerated) — an existing employee's
 * fields are refreshed on rerun; a new one gets a fresh Users + Employee
 * row + role assignment, with the dummy phone/hashed default password
 * the migrate step generated. A phone/email collision on create (e.g.
 * against a real account already in the system) is logged and skipped
 * rather than crashing the whole batch.
 *
 * Store/cluster/region resolution follows each role's scope (see
 * migrate-users-roles.cjs's header comment for the full mapping):
 * store-scoped roles get employee.storeId from their primary store
 * code; 'am' additionally resolves that store's clusterId; 'rm'
 * resolves that cluster's regionId; the three "sees everything" roles
 * (hop/pulse_finance/management) get no store/cluster/region binding at
 * all — their access comes from being hardcoded into
 * StoreScopeService.GLOBAL_ROLES instead (see that file).
 */
const SEED_FILE = path.join(__dirname, 'data/users-roles.json');

interface RoleRow {
  value: string;
  label: string;
  scope: 'store' | 'cluster' | 'region' | 'global';
}

interface EmployeeRow {
  id: string;
  employeeCode: string;
  roleValue: string;
  firstName: string;
  lastName: string;
  email?: string;
  countryCode: string;
  dummyPhone: string;
  dateOfBirth?: string;
  joiningDate?: string;
  password: string;
  addressLine1?: string;
  addressLine2?: string;
  city?: string;
  state?: string;
  pincode?: string;
  primaryStoreCode?: string;
  allStoreCodesRaw: string;
}

async function seedUsersRoles() {
  if (!fs.existsSync(SEED_FILE)) {
    console.error('Seed file not found:', SEED_FILE);
    console.error('Run: node scripts/migrate-users-roles.cjs');
    process.exit(1);
  }
  const {roles, employees}: {roles: RoleRow[]; employees: EmployeeRow[]} = JSON.parse(
    fs.readFileSync(SEED_FILE, 'utf8'),
  );

  const app = new presstoBackendApplication();
  await app.boot();
  await app.start();

  const rolesRepo = await app.getRepository(Repos.RolesRepository);
  const usersRepo = await app.getRepository(Repos.UsersRepository);
  const employeeRepo = await app.getRepository(Repos.EmployeeRepository);
  const userRolesRepo = await app.getRepository(Repos.UserRolesRepository);
  const storeRepo = await app.getRepository(Repos.StoreRepository);
  const clusterRepo = await app.getRepository(Repos.ClusterRepository);
  const hasher = await app.get<BcryptHasher>('service.hasher');

  // ── Roles: upsert by value ────────────────────────────────────────────────
  console.log('Upserting roles…');
  const roleIdByValue = new Map<string, string>();
  for (const r of roles) {
    // 'global' isn't a real Roles.scope value (store|cluster|region only) —
    // stored as 'store' (harmless placeholder; these roles never reach
    // StoreScopeService's scope branch at all, they're intercepted by the
    // GLOBAL_ROLES bypass first) rather than widening the schema for it.
    const dbScope = r.scope === 'global' ? 'store' : r.scope;
    const existing = await rolesRepo.findOne({where: {value: r.value}});
    if (existing) {
      await rolesRepo.updateById(existing.id, {label: r.label, scope: dbScope});
      roleIdByValue.set(r.value, existing.id);
    } else {
      const created = await rolesRepo.create({
        value: r.value,
        label: r.label,
        description: `Client-defined role, seeded from Pulse Users and Roles.xlsx.`,
        isLocked: false,
        loginAccess: true,
        scope: dbScope,
        isActive: true,
        isDeleted: false,
      });
      roleIdByValue.set(r.value, created.id);
    }
  }
  console.log(`  ${roles.length} roles upserted.`);

  // ── Store -> cluster -> region resolution ────────────────────────────────
  const allStores = await storeRepo.find({fields: {id: true, code: true, clusterId: true}});
  const storeByCode = new Map(allStores.map(s => [s.code, s]));
  const allClusters = await clusterRepo.find({fields: {id: true, regionId: true}});
  const clusterById = new Map(allClusters.map(c => [c.id, c]));

  const GLOBAL_SCOPE_ROLES = new Set(['hop', 'pulse_finance', 'management']);
  const CLUSTER_SCOPE_ROLES = new Set(['am']);
  const REGION_SCOPE_ROLES = new Set(['rm']);

  let created = 0;
  let updated = 0;
  const unresolvedStoreCodes = new Set<string>();
  const skippedCollisions: string[] = [];

  for (const emp of employees) {
    const store = emp.primaryStoreCode ? storeByCode.get(emp.primaryStoreCode) : undefined;
    if (emp.primaryStoreCode && !store) unresolvedStoreCodes.add(emp.primaryStoreCode);

    let storeId: string | undefined;
    let clusterId: string | undefined;
    let regionId: string | undefined;
    if (!GLOBAL_SCOPE_ROLES.has(emp.roleValue)) {
      if (REGION_SCOPE_ROLES.has(emp.roleValue)) {
        const cluster = store ? clusterById.get(store.clusterId) : undefined;
        regionId = cluster?.regionId;
      } else if (CLUSTER_SCOPE_ROLES.has(emp.roleValue)) {
        clusterId = store?.clusterId;
      } else {
        storeId = store?.id;
      }
    }

    const roleId = roleIdByValue.get(emp.roleValue);
    if (!roleId) {
      console.error(`  ✗ ${emp.employeeCode}: role "${emp.roleValue}" was not upserted — skipping.`);
      continue;
    }

    const existingEmployee = await employeeRepo.findOne({where: {employeeCode: emp.employeeCode}});

    let userId: string;
    if (existingEmployee) {
      await usersRepo.updateById(existingEmployee.userId, {
        fullName: `${emp.firstName} ${emp.lastName}`.trim(),
        email: emp.email,
        countryCode: emp.countryCode,
      });
      await employeeRepo.updateById(existingEmployee.id, {
        firstName: emp.firstName,
        lastName: emp.lastName,
        dateOfBirth: emp.dateOfBirth ? new Date(emp.dateOfBirth) : undefined,
        joiningDate: emp.joiningDate ? new Date(emp.joiningDate) : undefined,
        storeId,
        clusterId,
        regionId,
        addressLine1: emp.addressLine1 ?? 'N/A',
        addressLine2: emp.addressLine2,
        city: emp.city ?? 'N/A',
        state: emp.state ?? 'N/A',
        pincode: emp.pincode ?? '000000',
      });
      userId = existingEmployee.userId;
      updated += 1;
    } else {
      try {
        const hashedPassword = await hasher.hashPassword(emp.password);
        const user = await usersRepo.create({
          fullName: `${emp.firstName} ${emp.lastName}`.trim(),
          username: `emp${emp.employeeCode}`,
          email: emp.email,
          countryCode: emp.countryCode,
          phone: emp.dummyPhone,
          password: hashedPassword,
          isActive: true,
        });
        await employeeRepo.create({
          userId: user.id,
          employeeCode: emp.employeeCode,
          firstName: emp.firstName,
          lastName: emp.lastName,
          dateOfBirth: emp.dateOfBirth ? new Date(emp.dateOfBirth) : undefined,
          joiningDate: emp.joiningDate ? new Date(emp.joiningDate) : undefined,
          storeId,
          clusterId,
          regionId,
          addressLine1: emp.addressLine1 ?? 'N/A',
          addressLine2: emp.addressLine2,
          city: emp.city ?? 'N/A',
          state: emp.state ?? 'N/A',
          pincode: emp.pincode ?? '000000',
        });
        userId = user.id;
        created += 1;
      } catch (err) {
        skippedCollisions.push(`${emp.employeeCode} (${emp.firstName} ${emp.lastName}): ${(err as Error).message}`);
        continue;
      }
    }

    const alreadyAssigned = await userRolesRepo.findOne({where: {usersId: userId, rolesId: roleId}});
    if (!alreadyAssigned) {
      await userRolesRepo.create({usersId: userId, rolesId: roleId});
    }
  }

  console.log(`Employees created: ${created}, updated: ${updated}`);
  if (unresolvedStoreCodes.size) {
    console.log(
      `Unresolved primary store code(s) (no matching Store row — scope left unbound): ${[...unresolvedStoreCodes].sort().join(', ')}`,
    );
  }
  if (skippedCollisions.length) {
    console.log(`Skipped ${skippedCollisions.length} row(s) on create (phone/email collision):`);
    for (const line of skippedCollisions) console.log(`  ✗ ${line}`);
  }

  console.log('Users & roles seed complete.');
  await app.stop();
  process.exit(0);
}

seedUsersRoles().catch(err => {
  console.error('Users & roles seed failed:', err);
  process.exit(1);
});
