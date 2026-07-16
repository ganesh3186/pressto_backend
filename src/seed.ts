import {presstoBackendApplication} from './application';
import {
  PermissionsRepository,
  RolePermissionsRepository,
  RolesRepository,
} from './repositories';
import {UserRolesRepository} from './repositories/user-roles.repository';
import * as Repos from './repositories';
import fs from 'fs';
import path from 'path';

const PERMISSIONS: {permission: string; description: string}[] = [
  // Brand
  {permission: 'brand:create', description: 'Create a brand'},
  {permission: 'brand:read',   description: 'View brands'},
  {permission: 'brand:update', description: 'Update a brand'},
  {permission: 'brand:delete', description: 'Delete a brand'},
  // Color
  {permission: 'color:create', description: 'Create a color'},
  {permission: 'color:read',   description: 'View colors'},
  {permission: 'color:update', description: 'Update a color'},
  {permission: 'color:delete', description: 'Delete a color'},
  // Stain
  {permission: 'stain:create', description: 'Create a stain type'},
  {permission: 'stain:read',   description: 'View stain types'},
  {permission: 'stain:update', description: 'Update a stain type'},
  {permission: 'stain:delete', description: 'Delete a stain type'},
  // Damage Type
  {permission: 'damage_type:create', description: 'Create a damage type'},
  {permission: 'damage_type:read',   description: 'View damage types'},
  {permission: 'damage_type:update', description: 'Update a damage type'},
  {permission: 'damage_type:delete', description: 'Delete a damage type'},
  // Item Category
  {permission: 'item_category:create', description: 'Create an item category'},
  {permission: 'item_category:read',   description: 'View item categories'},
  {permission: 'item_category:update', description: 'Update an item category'},
  {permission: 'item_category:delete', description: 'Delete an item category'},
  // Service
  {permission: 'service:create', description: 'Create a service'},
  {permission: 'service:read',   description: 'View services'},
  {permission: 'service:update', description: 'Update a service'},
  {permission: 'service:delete', description: 'Delete a service'},
  // Customer Label
  {permission: 'customer_label:create', description: 'Create a customer label'},
  {permission: 'customer_label:read',   description: 'View customer labels'},
  {permission: 'customer_label:update', description: 'Update a customer label'},
  {permission: 'customer_label:delete', description: 'Delete a customer label'},
  // Order Label
  {permission: 'order_label:create', description: 'Create an order label'},
  {permission: 'order_label:read',   description: 'View order labels'},
  {permission: 'order_label:update', description: 'Update an order label'},
  {permission: 'order_label:delete', description: 'Delete an order label'},
  // Customer Discount Group
  {permission: 'customer_discount_group:create', description: 'Create a customer discount group'},
  {permission: 'customer_discount_group:read',   description: 'View customer discount groups'},
  {permission: 'customer_discount_group:update', description: 'Update a customer discount group'},
  {permission: 'customer_discount_group:delete', description: 'Delete a customer discount group'},
  // Process Step
  {permission: 'process_step:create', description: 'Create a process step'},
  {permission: 'process_step:read',   description: 'View process steps'},
  {permission: 'process_step:update', description: 'Update a process step'},
  {permission: 'process_step:delete', description: 'Delete a process step'},
  // Service Category
  {permission: 'service_category:create', description: 'Create a service category'},
  {permission: 'service_category:read',   description: 'View service categories'},
  {permission: 'service_category:update', description: 'Update a service category'},
  {permission: 'service_category:delete', description: 'Delete a service category'},
  // Item
  {permission: 'item:create', description: 'Create an item'},
  {permission: 'item:read',   description: 'View items'},
  {permission: 'item:update', description: 'Update an item'},
  {permission: 'item:delete', description: 'Delete an item'},
  // Additional Charge Master
  {permission: 'additional_charge_master:create', description: 'Create an additional charge'},
  {permission: 'additional_charge_master:read',   description: 'View additional charges'},
  {permission: 'additional_charge_master:update', description: 'Update an additional charge'},
  {permission: 'additional_charge_master:delete', description: 'Delete an additional charge'},
  // Customer Type Master
  {permission: 'customer_type_master:create', description: 'Create a customer type'},
  {permission: 'customer_type_master:read',   description: 'View customer types'},
  {permission: 'customer_type_master:update', description: 'Update a customer type'},
  {permission: 'customer_type_master:delete', description: 'Delete a customer type'},
  // Region
  {permission: 'region:create', description: 'Create a region'},
  {permission: 'region:read',   description: 'View regions'},
  {permission: 'region:update', description: 'Update a region'},
  {permission: 'region:delete', description: 'Delete a region'},
  // Price List
  {permission: 'price_list:create', description: 'Create a price list'},
  {permission: 'price_list:read',   description: 'View price lists'},
  {permission: 'price_list:update', description: 'Update a price list'},
  {permission: 'price_list:delete', description: 'Delete a price list'},
  // Cluster
  {permission: 'cluster:create', description: 'Create a cluster'},
  {permission: 'cluster:read',   description: 'View clusters'},
  {permission: 'cluster:update', description: 'Update a cluster'},
  {permission: 'cluster:delete', description: 'Delete a cluster'},
  // GST Tax Configuration
  {permission: 'gst_tax_configuration:create', description: 'Create GST tax config'},
  {permission: 'gst_tax_configuration:read',   description: 'View GST tax config'},
  {permission: 'gst_tax_configuration:update', description: 'Update GST tax config'},
  {permission: 'gst_tax_configuration:delete', description: 'Delete GST tax config'},
  // Wallet Configuration
  {permission: 'wallet_configuration:create', description: 'Create wallet config'},
  {permission: 'wallet_configuration:read',   description: 'View wallet config'},
  {permission: 'wallet_configuration:update', description: 'Update wallet config'},
  {permission: 'wallet_configuration:delete', description: 'Delete wallet config'},
  // Delivery Type Configuration
  {permission: 'delivery_type_configuration:create', description: 'Create delivery type config'},
  {permission: 'delivery_type_configuration:read',   description: 'View delivery type config'},
  {permission: 'delivery_type_configuration:update', description: 'Update delivery type config'},
  {permission: 'delivery_type_configuration:delete', description: 'Delete delivery type config'},
  // Store
  {permission: 'store:create', description: 'Create a store'},
  {permission: 'store:read',   description: 'View stores'},
  {permission: 'store:update', description: 'Update a store'},
  {permission: 'store:delete', description: 'Delete a store'},
  // Employee
  {permission: 'employee:create', description: 'Create an employee'},
  {permission: 'employee:read',   description: 'View employees'},
  {permission: 'employee:update', description: 'Update an employee'},
  {permission: 'employee:delete', description: 'Delete an employee'},
  // Role
  {permission: 'role:create', description: 'Create a role'},
  {permission: 'role:read',   description: 'View roles'},
  {permission: 'role:update', description: 'Update a role'},
  {permission: 'role:delete', description: 'Delete a role'},
  // Permission
  {permission: 'permission:create', description: 'Create a permission'},
  {permission: 'permission:read',   description: 'View permissions'},
  {permission: 'permission:update', description: 'Update a permission'},
  {permission: 'permission:delete', description: 'Delete a permission'},
  // Service Process Mapping
  {permission: 'service_process_mapping:create', description: 'Create service-process mapping'},
  {permission: 'service_process_mapping:read',   description: 'View service-process mappings'},
  {permission: 'service_process_mapping:update', description: 'Update service-process mapping'},
  {permission: 'service_process_mapping:delete', description: 'Delete service-process mapping'},
  // Store Service Mapping
  {permission: 'store_service_mapping:create', description: 'Create store-service mapping'},
  {permission: 'store_service_mapping:read',   description: 'View store-service mappings'},
  {permission: 'store_service_mapping:update', description: 'Update store-service mapping'},
  {permission: 'store_service_mapping:delete', description: 'Delete store-service mapping'},
  // Service Item Mapping
  {permission: 'service_item_mapping:create', description: 'Create service-item mapping'},
  {permission: 'service_item_mapping:read',   description: 'View service-item mappings'},
  {permission: 'service_item_mapping:update', description: 'Update service-item mapping'},
  {permission: 'service_item_mapping:delete', description: 'Delete service-item mapping'},
  // Price List Item
  {permission: 'price_list_item:create', description: 'Create a price list item'},
  {permission: 'price_list_item:read',   description: 'View price list items'},
  {permission: 'price_list_item:update', description: 'Update a price list item'},
  {permission: 'price_list_item:delete', description: 'Delete a price list item'},
  // Cluster Price List
  {permission: 'cluster_price_list:create', description: 'Create a cluster price list'},
  {permission: 'cluster_price_list:read',   description: 'View cluster price lists'},
  {permission: 'cluster_price_list:update', description: 'Update a cluster price list'},
  {permission: 'cluster_price_list:delete', description: 'Delete a cluster price list'},
  // Store Price Override
  {permission: 'store_price_override:create', description: 'Create a store price override'},
  {permission: 'store_price_override:read',   description: 'View store price overrides'},
  {permission: 'store_price_override:update', description: 'Update a store price override'},
  {permission: 'store_price_override:delete', description: 'Delete a store price override'},
  // Customer
  {permission: 'customer:create', description: 'Create a customer'},
  {permission: 'customer:read',   description: 'View customers'},
  {permission: 'customer:update', description: 'Update a customer'},
  {permission: 'customer:delete', description: 'Delete a customer'},
  // Order
  {permission: 'order:create', description: 'Create an order'},
  {permission: 'order:read',   description: 'View orders'},
  {permission: 'order:update', description: 'Update an order'},
  {permission: 'order:delete', description: 'Delete an order'},
  // Garment
  {permission: 'garment:create', description: 'Create/intake a garment'},
  {permission: 'garment:read',   description: 'View garments'},
  {permission: 'garment:update', description: 'Update a garment'},
  {permission: 'garment:delete', description: 'Delete a garment'},
  // Bag
  {permission: 'bag:create', description: 'Create a bag'},
  {permission: 'bag:read',   description: 'View bags'},
  {permission: 'bag:update', description: 'Update a bag'},
  {permission: 'bag:delete', description: 'Delete a bag'},
  // Approval
  {permission: 'approval:create', description: 'Create an approval'},
  {permission: 'approval:read',   description: 'View approvals'},
  {permission: 'approval:update', description: 'Update an approval'},
  {permission: 'approval:delete', description: 'Delete an approval'},
  // Audit
  {permission: 'audit:read', description: 'View audit logs'},
  // Profile
  {permission: 'profile:read',   description: 'View own profile'},
  {permission: 'profile:update', description: 'Update own profile'},
  // Customer Recharge
  {permission: 'customer_recharge:create', description: 'Recharge customer wallet'},
  {permission: 'customer_recharge:read',   description: 'View customer recharges'},
  // Family Group
  {permission: 'family_group:create', description: 'Create a family group'},
  {permission: 'family_group:read',   description: 'View family groups'},
  {permission: 'family_group:update', description: 'Update a family group'},
  {permission: 'family_group:delete', description: 'Delete a family group'},
  // File Upload
  {permission: 'file_upload:create', description: 'Upload files'},
  {permission: 'file_upload:read',   description: 'View uploaded files'},
];

// ─── Roles ──────────────────────────────────────────────────────────────────
//
// Two kinds of role:
//   • isLocked: true  → SYSTEM role. The codebase references its `value` by
//     literal string (super_admin bypass, approval routing to asm/store_exec/
//     manager/finance, the customer app). These must never be renamed or
//     deleted, and the seed keeps their permission set authoritative (it prunes
//     anything not listed here on every run).
//   • isLocked: false → EXAMPLE role. Seeded once so you have editable roles to
//     test custom-role behaviour; the seed adds missing permissions but never
//     prunes, so hand edits survive.

// Every resource that is master/config data — used for "read all masters".
const MASTER_RESOURCES = [
  'brand', 'color', 'stain', 'damage_type', 'item_category', 'service',
  'customer_label', 'order_label', 'customer_discount_group', 'process_step',
  'service_category', 'item', 'region', 'cluster', 'store', 'price_list',
  'price_list_item', 'cluster_price_list', 'store_price_override',
  'store_service_mapping', 'service_item_mapping', 'service_process_mapping',
  'additional_charge_master', 'customer_type_master', 'gst_tax_configuration',
  'delivery_type_configuration', 'wallet_configuration', 'bag',
];

// Permission-string builders. Each returns a flat array of "resource:action".
const crud = (r: string) => [`${r}:create`, `${r}:read`, `${r}:update`, `${r}:delete`];
const cru = (r: string) => [`${r}:create`, `${r}:read`, `${r}:update`];
const cr = (r: string) => [`${r}:create`, `${r}:read`];
const ru = (r: string) => [`${r}:read`, `${r}:update`];
const ro = (r: string) => [`${r}:read`];
const readAll = (resources: string[]) => resources.map(r => `${r}:read`);
const flat = (...groups: string[][]) => [...new Set(groups.flat(Infinity as 1))] as string[];

// '*' is a sentinel expanded to every seeded permission at run time.
const ALL = '*' as const;

interface RoleSeed {
  value: string;
  label: string;
  description: string;
  isLocked: boolean;
  loginAccess: boolean;
  permissions: string[] | typeof ALL;
}

const ROLES: RoleSeed[] = [
  // ── System roles (locked) ──────────────────────────────────────────────
  {
    value: 'super_admin',
    label: 'Super Admin',
    description: 'Full access to everything. Bypasses all permission checks.',
    isLocked: true,
    loginAccess: true,
    permissions: ALL,
  },
  {
    value: 'manager',
    label: 'Store Manager',
    description: 'Runs a store — full operations, staff, store-level config, reads all masters.',
    isLocked: true,
    loginAccess: true,
    permissions: flat(
      readAll(MASTER_RESOURCES),
      cru('store_service_mapping'),
      cru('store_price_override'),
      crud('order'), crud('garment'), crud('customer'), crud('approval'), crud('family_group'),
      cru('bag'),
      cr('customer_recharge'),
      cr('employee'),
      cr('file_upload'),
      ru('profile'),
      ro('audit'),
    ),
  },
  {
    value: 'asm',
    label: 'Area Sales Manager',
    description: 'Oversight across stores. Approves returns; read-only on operations and masters.',
    isLocked: true,
    loginAccess: true,
    permissions: flat(
      readAll(MASTER_RESOURCES),
      ro('order'), ro('garment'), ro('customer'),
      cru('approval'),
      ro('customer_recharge'),
      ro('employee'),
      ro('audit'),
      cr('file_upload'),
      ru('profile'),
    ),
  },
  {
    value: 'store_exec',
    label: 'Store Executive',
    description: 'Front-desk operations — take and update orders, intake garments, raise approvals.',
    isLocked: true,
    loginAccess: true,
    permissions: flat(
      readAll(['service', 'item', 'item_category', 'service_category', 'brand', 'color',
        'store', 'price_list', 'additional_charge_master', 'delivery_type_configuration', 'bag']),
      cru('order'), cru('garment'), cru('customer'),
      cr('approval'), cr('family_group'), cr('customer_recharge'),
      cr('file_upload'),
      ru('profile'),
    ),
  },
  {
    value: 'finance',
    label: 'Finance',
    description: 'Payments, wallet recharges, tax and wallet configuration, audit.',
    isLocked: true,
    loginAccess: true,
    permissions: flat(
      cru('order'),        // order:create records a payment, order:update is club-pay
      ro('customer'),
      cr('customer_recharge'),
      crud('wallet_configuration'),
      crud('gst_tax_configuration'),
      ro('delivery_type_configuration'),
      ro('audit'),
      cr('file_upload'),
      ru('profile'),
    ),
  },
  {
    value: 'customer',
    label: 'Customer',
    description: 'Customer web/app account — own profile, orders and wallet.',
    isLocked: true,
    loginAccess: true,
    permissions: flat(
      ru('profile'),
      cr('customer_recharge'),
      ro('order'),
      cr('file_upload'),
    ),
  },

  // ── Example roles (editable) ───────────────────────────────────────────
  {
    value: 'counter_staff',
    label: 'Counter Staff',
    description: 'Example editable role — cashier who books orders and takes payments.',
    isLocked: false,
    loginAccess: true,
    permissions: flat(
      readAll(['service', 'item', 'item_category', 'service_category', 'brand', 'color',
        'store', 'price_list', 'additional_charge_master', 'delivery_type_configuration', 'bag']),
      cru('order'), cru('garment'), cru('customer'),
      cr('approval'), cr('customer_recharge'),
      cr('file_upload'),
      ru('profile'),
    ),
  },
  {
    value: 'workshop_operator',
    label: 'Workshop Operator',
    description: 'Example editable role — processes garments through the workshop steps.',
    isLocked: false,
    loginAccess: true,
    permissions: flat(
      ru('garment'),
      ro('order'),
      ro('process_step'),
      ro('service_process_mapping'),
      cr('file_upload'),
      ru('profile'),
    ),
  },
];

export async function seed() {
  const app = new presstoBackendApplication();
  await app.boot();
  await app.start();

  const permRepo = await app.getRepository(PermissionsRepository);
  const roleRepo = await app.getRepository(RolesRepository);
  const rolePermRepo = await app.getRepository(RolePermissionsRepository);
  const userRolesRepo = await app.getRepository(UserRolesRepository);

  // ── 0. Optional RBAC reset (`npm run seed -- --reset`) ─────────────────
  // Clears ONLY the role/permission tables so a messy prior seed can be rebuilt
  // cleanly. It never touches masters, customers, orders or the users table, and
  // it deliberately keeps any role that is still assigned to a user so nobody
  // (e.g. the existing super_admin) loses their login.
  const RESET = process.argv.includes('--reset');
  if (RESET) {
    console.log('Reset: clearing role/permission data (masters & users preserved)…');

    // 1. All role→permission links — fully rederivable below, so safe to drop.
    const allLinks = await rolePermRepo.find();
    for (const l of allLinks) await rolePermRepo.deleteById(l.id);
    console.log(`  cleared ${allLinks.length} role-permission link(s)`);

    // 2. Permissions no longer in the master list (their links are already gone).
    const wantedPerm = new Set(PERMISSIONS.map(p => p.permission));
    const existingPerms = await permRepo.find();
    let staleP = 0;
    for (const p of existingPerms) {
      if (wantedPerm.has(p.permission)) continue;
      await permRepo.deleteById(p.id);
      staleP++;
    }
    console.log(`  removed ${staleP} stale permission(s)`);

    // 3. Roles no longer defined here — but only if no user is assigned to them.
    const wantedRole = new Set(ROLES.map(r => r.value));
    const existingRoles = await roleRepo.find();
    let strayDeleted = 0;
    let strayKept = 0;
    for (const r of existingRoles) {
      if (wantedRole.has(r.value)) continue;
      const uses = await userRolesRepo.count({rolesId: r.id});
      if (uses.count === 0) {
        await roleRepo.deleteById(r.id);
        strayDeleted++;
      } else {
        console.warn(`  kept stray role "${r.value}" — still assigned to ${uses.count} user(s)`);
        strayKept++;
      }
    }
    console.log(`  removed ${strayDeleted} stray role(s); kept ${strayKept} in use`);
  }

  // ── 1. Permissions ─────────────────────────────────────────────────────
  let permInserted = 0;
  let permSkipped = 0;

  for (const entry of PERMISSIONS) {
    const exists = await permRepo.findOne({where: {permission: entry.permission}});
    if (exists) {
      permSkipped++;
      continue;
    }
    await permRepo.create({
      ...entry,
      isActive: true,
      isDeleted: false,
    });
    permInserted++;
  }

  console.log(`Permissions — inserted: ${permInserted}, skipped: ${permSkipped}`);

  // ── 2. Roles + role→permission links ───────────────────────────────────
  // Build a permission-string → id lookup once.
  const allPerms = await permRepo.find();
  const permIdByKey = new Map(allPerms.map(p => [p.permission, p.id]));
  const allPermStrings = allPerms.map(p => p.permission);

  let rolesInserted = 0;
  let rolesUpdated = 0;
  let linksInserted = 0;
  let linksRemoved = 0;

  for (const def of ROLES) {
    // Upsert the role by its stable `value`.
    const fields = {
      label: def.label,
      value: def.value,
      description: def.description,
      isLocked: def.isLocked,
      loginAccess: def.loginAccess,
      isActive: true,
      isDeleted: false,
    };

    let role = await roleRepo.findOne({where: {value: def.value}});
    if (!role) {
      role = await roleRepo.create(fields);
      rolesInserted++;
    } else {
      // Keep system-role metadata authoritative (label/desc/isLocked/loginAccess).
      await roleRepo.updateById(role.id, {
        label: def.label,
        description: def.description,
        isLocked: def.isLocked,
        loginAccess: def.loginAccess,
      });
      rolesUpdated++;
    }

    // Resolve the wanted permission ids, warning on any that don't exist.
    const wantedStrings = def.permissions === ALL ? allPermStrings : def.permissions;
    const wantedIds = new Set<string>();
    for (const ps of wantedStrings) {
      const id = permIdByKey.get(ps);
      if (!id) {
        console.warn(`  ⚠ role "${def.value}": unknown permission "${ps}" — skipped`);
        continue;
      }
      wantedIds.add(id);
    }

    const existingLinks = await rolePermRepo.find({where: {rolesId: role.id}});
    const existingIds = new Set(existingLinks.map(l => l.permissionsId));

    // Add any missing links.
    for (const pid of wantedIds) {
      if (existingIds.has(pid)) continue;
      await rolePermRepo.create({
        rolesId: role.id,
        permissionsId: pid,
        isActive: true,
        isDeleted: false,
      });
      linksInserted++;
    }

    // Locked (system) roles are authoritative: prune links not in the set so the
    // role's access always matches this file. Editable roles keep hand-added ones.
    if (def.isLocked) {
      for (const link of existingLinks) {
        if (wantedIds.has(link.permissionsId)) continue;
        await rolePermRepo.deleteById(link.id);
        linksRemoved++;
      }
    }

    console.log(
      `  • ${def.value.padEnd(18)} ${def.isLocked ? '[system]' : '[custom]'} — ${wantedIds.size} permission(s)`,
    );
  }

  console.log(
    `Roles — inserted: ${rolesInserted}, updated: ${rolesUpdated}; ` +
      `links added: ${linksInserted}, pruned: ${linksRemoved}`,
  );

  await seedMasters(app);

  console.log('Seed complete.');
  await app.stop();
  process.exit(0);
}

async function seedMasters(app: presstoBackendApplication) {
  const seedFile = path.join(__dirname, '../src/data/seed-masters.json');
  if (!fs.existsSync(seedFile)) {
    console.log('No master seed file found at', seedFile);
    return;
  }
  const mastersData = JSON.parse(fs.readFileSync(seedFile, 'utf8'));

  const repoMapping = [
    { table: 'region', repoClass: Repos.RegionRepository },
    { table: 'cluster', repoClass: Repos.ClusterRepository },
    { table: 'store', repoClass: Repos.StoreRepository },
    { table: 'item_category', repoClass: Repos.ItemCategoryRepository },
    { table: 'item', repoClass: Repos.ItemRepository },
    { table: 'service_category', repoClass: Repos.ServiceCategoryRepository },
    { table: 'service', repoClass: Repos.ServiceRepository },
    { table: 'brand', repoClass: Repos.BrandRepository },
    { table: 'color', repoClass: Repos.ColorRepository },
    { table: 'stain', repoClass: Repos.StainRepository },
    { table: 'damage_type', repoClass: Repos.DamageTypeRepository },
    { table: 'customer_label', repoClass: Repos.CustomerLabelRepository },
    { table: 'order_label', repoClass: Repos.OrderLabelRepository },
    { table: 'customer_discount_group', repoClass: Repos.CustomerDiscountGroupRepository },
    { table: 'process_step', repoClass: Repos.ProcessStepRepository },
    { table: 'price_list', repoClass: Repos.PriceListRepository },
    { table: 'price_list_item', repoClass: Repos.PriceListItemRepository },
    { table: 'cluster_price_list', repoClass: Repos.ClusterPriceListRepository },
    { table: 'store_price_override', repoClass: Repos.StorePriceOverrideRepository },
    { table: 'store_service_mapping', repoClass: Repos.StoreServiceMappingRepository },
    { table: 'service_item_mapping', repoClass: Repos.ServiceItemMappingRepository },
    { table: 'service_process_mapping', repoClass: Repos.ServiceProcessMappingRepository },
    { table: 'additional_charge_master', repoClass: Repos.AdditionalChargeMasterRepository },
    { table: 'customer_type_master', repoClass: Repos.CustomerTypeMasterRepository },
    { table: 'gst_tax_configuration', repoClass: Repos.GstTaxConfigurationRepository },
    { table: 'delivery_type_configuration', repoClass: Repos.DeliveryTypeConfigurationRepository },
    { table: 'wallet_configuration', repoClass: Repos.WalletConfigurationRepository },
    { table: 'bag', repoClass: Repos.BagRepository },
  ];

  for (const { table, repoClass } of repoMapping) {
    if (!mastersData[table] || mastersData[table].length === 0) continue;
    console.log(`Seeding master: ${table} (${mastersData[table].length} records)`);
    try {
      const repo = (await app.getRepository(repoClass as any)) as any;
      
      // Build a mapping from lowercase DB column names to correct camelCase TS properties
      const properties = repo.entityClass.definition.properties;
      const keyMapping: Record<string, string> = {};
      for (const propName of Object.keys(properties)) {
        keyMapping[propName.toLowerCase()] = propName;
      }

      for (const record of mastersData[table]) {
        try {
          // Map the parsed JSON keys to correct casing
          const mappedRecord: any = {};
          for (const [key, value] of Object.entries(record)) {
            const mappedKey = keyMapping[key] || key;
            mappedRecord[mappedKey] = value;
          }

          const exists = await repo.findOne({where: {id: mappedRecord.id}});
          if (!exists) {
            await repo.create(mappedRecord);
          }
        } catch (err: any) {
          console.error(`Failed to seed record in ${table} (id: ${record.id}):`, err.message);
        }
      }
    } catch (err: any) {
      console.error(`Failed to get repository for ${table}:`, err.message);
    }
  }
}

seed().catch(err => {
  console.error('Seed failed:', err);
  process.exit(1);
});
