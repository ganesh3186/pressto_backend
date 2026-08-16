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
  // Finance Approvals screen UI-gate (approval:create/read/update already
  // exist — this is just the new nav/route visibility key for that screen)
  {permission: 'finance_approval:read', description: 'View the Finance Approvals screen'},
  // Pickup Request (see PickupRequestController) — Manual Assign's pickup
  // side. order:update (already granted) covers the separate delivery-
  // assignment endpoints on Order, so no new order-scoped permission here.
  {permission: 'pickup_request:create', description: 'Create a pickup request'},
  {permission: 'pickup_request:read',   description: 'View pickup requests'},
  {permission: 'pickup_request:update', description: 'Update / assign / transition a pickup request'},
  {permission: 'pickup_request:delete', description: 'Delete a pickup request'},
  // Rider Pincode Mapping (see RiderPincodeMappingController)
  {permission: 'rider_pincode_mapping:create', description: 'Map a pincode to a rider'},
  {permission: 'rider_pincode_mapping:read',   description: 'View rider pincode mappings'},
  {permission: 'rider_pincode_mapping:update', description: 'Update a rider pincode mapping'},
  {permission: 'rider_pincode_mapping:delete', description: 'Delete a rider pincode mapping'},
  // Interstore Transfer (see TransferController) — send and receive share
  // one permission (transfer:create), since both are the same day-to-day
  // counter workflow. transfer:update is separate and narrower: it only
  // gates resolve-discrepancy, an exception/write-off action, not routine
  // send/receive. No delete — transfers are permanent once created.
  {permission: 'transfer:create', description: 'Send or receive an interstore transfer'},
  {permission: 'transfer:read',   description: 'View interstore transfers and their custody trail'},
  {permission: 'transfer:update', description: 'Resolve a discrepant transfer and release its bag'},
  // Pickup/Delivery Slot master (see PickupDeliverySlotController) — dispatch
  // config, not daily front-desk work. Customer/rider self-service reads
  // (GET /profile/customer/pickup-slots, rider pickup creation) are
  // role-gated directly, not by this permission.
  {permission: 'pickup_delivery_slot:create', description: 'Create a pickup/delivery slot'},
  {permission: 'pickup_delivery_slot:read',   description: 'View pickup/delivery slots'},
  {permission: 'pickup_delivery_slot:update', description: 'Update a pickup/delivery slot'},
  {permission: 'pickup_delivery_slot:delete', description: 'Delete a pickup/delivery slot'},
  // POS Shift (see ShiftController) — open/close is the same day-to-day
  // counter workflow, granted together. No shift:delete — no delete
  // endpoint this pass, shifts are permanent once opened.
  {permission: 'shift:create', description: 'Open a POS shift'},
  {permission: 'shift:read',   description: 'View POS shifts'},
  {permission: 'shift:update', description: 'Close a POS shift'},
  // Delivery (see DeliveryController, order.controller.ts's assignDelivery)
  // — created only when Dispatch supplies a bagId. No delivery:create —
  // creation happens inside order:update-gated assignDelivery, not a
  // standalone admin action.
  {permission: 'delivery:read',   description: 'View deliveries and their order/custody detail'},
  {permission: 'delivery:update', description: 'Cancel an unstarted delivery and release its bag'},
  // Rider Cash Handover (see RiderCashHandoverController) — the store-side
  // half of a rider handing back cash collected at delivery. No :create —
  // creation is rider-role-gated (POST /rider/cash-handovers), not admin.
  {permission: 'rider_cash_handover:read',   description: 'View rider cash-pending summary and handover history'},
  {permission: 'rider_cash_handover:update', description: 'Confirm receipt of a rider cash handover batch'},
  // Coupon (see CouponController) — coupon:read also gates the validate-
  // only preview endpoint (POST /coupons/validate), a pure read/query
  // with no side effects, same posture as pickup_request:read gating
  // GET /pickup-requests/count.
  {permission: 'coupon:create', description: 'Create a coupon'},
  {permission: 'coupon:read',   description: 'View coupons, redemption history, and validate a coupon code'},
  {permission: 'coupon:update', description: 'Update a coupon, and manage its individually-targeted customers'},
  {permission: 'coupon:delete', description: 'Delete a coupon'},
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
      // Pickup Request: managers run the day-to-day front-desk/call-center
      // intake + rider assignment, and can also remove a mistaken entry.
      'pickup_request:create', 'pickup_request:read', 'pickup_request:update', 'pickup_request:delete',
      // Rider Pincode Mapping: dispatch-config, not a daily front-desk task —
      // managers get full control.
      'rider_pincode_mapping:create', 'rider_pincode_mapping:read',
      'rider_pincode_mapping:update', 'rider_pincode_mapping:delete',
      // Interstore Transfer: the scan-and-send/scan-and-receive counter
      // workflow, plus resolving a discrepancy — an exception/write-off
      // call reserved for a manager, not front-desk staff.
      'transfer:create', 'transfer:read', 'transfer:update',
      // Pickup/Delivery Slot master: dispatch config, full control.
      'pickup_delivery_slot:create', 'pickup_delivery_slot:read',
      'pickup_delivery_slot:update', 'pickup_delivery_slot:delete',
      // POS Shift: managers run the counter too, and can open/close/view
      // same as store_exec.
      'shift:create', 'shift:read', 'shift:update',
      // Delivery: full control, including cancelling an unstarted run —
      // an exception action reserved for a manager, matching
      // transfer:update's posture.
      'delivery:read', 'delivery:update',
      // Rider Cash Handover: managers can view and confirm receipt too.
      'rider_cash_handover:read', 'rider_cash_handover:update',
      // Coupon: full control — a marketing/ops lever managers own outright,
      // same posture as Pickup/Delivery Slot master.
      'coupon:create', 'coupon:read', 'coupon:update', 'coupon:delete',
    ],
  },
  {
    roleValue: 'store_exec',
    permissions: [
      'customer_address:create', 'customer_address:read', 'customer_address:update',
      'customer_phone:create', 'customer_phone:read', 'customer_phone:update',
      // Pickup Request: front-desk logs intake and assigns riders, but
      // deletion is reserved for a manager.
      'pickup_request:create', 'pickup_request:read', 'pickup_request:update',
      // Read-only visibility into which rider covers which pincode.
      'rider_pincode_mapping:read',
      // Interstore Transfer: same counter workflow as manager.
      'transfer:create', 'transfer:read',
      // Pickup/Delivery Slot master: needs to see slots when logging a
      // call-in pickup request, but not edit the master list.
      'pickup_delivery_slot:read',
      // POS Shift: this is literally who opens/closes a shift day to day.
      'shift:create', 'shift:read', 'shift:update',
      // Delivery: read-only — assigning one happens via order:update on
      // assignDelivery, not this permission; cancelling stays manager-only.
      'delivery:read',
      // Rider Cash Handover: confirming a rider's cash handover is the
      // same front-desk counter action store_exec already owns for
      // Transfer receive.
      'rider_cash_handover:read', 'rider_cash_handover:update',
      // Coupon: read-only — needs to see/validate a coupon a customer
      // presents at the counter, not author one.
      'coupon:read',
    ],
  },
  {
    roleValue: 'counter_staff',
    permissions: [
      'customer_address:create', 'customer_address:read', 'customer_address:update',
      'customer_phone:create', 'customer_phone:read', 'customer_phone:update',
      // Coupon: same reason as store_exec — validates a coupon code
      // during order creation, doesn't author coupons.
      'coupon:read',
    ],
  },
  {roleValue: 'asm', permissions: ['customer_address:read', 'customer_phone:read', 'coupon:read']},
  {
    roleValue: 'finance',
    permissions: [
      'customer_address:read', 'customer_phone:read',
      // Finance Approvals screen: cheque/PDC payment approvals (via the
      // generic ApprovalRequest system) and credit-note approvals (which
      // finance already reaches via order:update, granted in seed.ts).
      'approval:create', 'approval:read', 'approval:update', 'finance_approval:read',
    ],
  },
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
