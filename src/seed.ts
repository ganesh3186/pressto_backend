import {presstoBackendApplication} from './application';
import {PermissionsRepository} from './repositories';

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

export async function seed() {
  const app = new presstoBackendApplication();
  await app.boot();
  await app.start();

  const permRepo = await app.getRepository(PermissionsRepository);

  let inserted = 0;
  let skipped = 0;

  for (const entry of PERMISSIONS) {
    const exists = await permRepo.findOne({where: {permission: entry.permission}});
    if (exists) {
      skipped++;
      continue;
    }
    await permRepo.create({
      ...entry,
      isActive: true,
      isDeleted: false,
    });
    inserted++;
  }

  console.log(`Seed complete — inserted: ${inserted}, skipped (already exists): ${skipped}`);
  await app.stop();
  process.exit(0);
}

seed().catch(err => {
  console.error('Seed failed:', err);
  process.exit(1);
});
