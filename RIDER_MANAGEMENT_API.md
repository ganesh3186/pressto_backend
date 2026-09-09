# Rider Management — Frontend Integration Guide

Backend for the M2 Rider Management screens (Pickup Requests / Manual Assign,
Order delivery assignment, Rider Availability, Pincode Coverage). Shipped on
`pressto_backend`'s **`main`** branch.

**Scope note:** Rider CRUD (`rider.controller.ts`), rider login/OTP
(`rider-auth.controller.ts`), attendance punch-in/out
(`rider-attendance.controller.ts`), and roster/leave management
(`rider-roster.controller.ts`) already existed before this pass and aren't
re-documented here. This doc covers only what was added for M2: **Pickup
Requests**, **Order delivery assignment**, the **Rider Availability**
endpoint's new `on-delivery` state, and **Rider Pincode Mapping**.

All routes require `Authorization: Bearer <jwt>`.

| Permission | Who has it | Gates |
|---|---|---|
| `pickup_request:create` | `manager`, `store_exec` | Create a pickup request |
| `pickup_request:read` | `manager`, `store_exec` | List/view pickup requests |
| `pickup_request:update` | `manager`, `store_exec` | Update, status transitions, rider assignment |
| `pickup_request:delete` | `manager` only | Soft-delete a pickup request |
| `rider_pincode_mapping:create` | `manager` only | Map pincodes to a rider |
| `rider_pincode_mapping:read` | `manager`, `store_exec` | View pincode coverage |
| `rider_pincode_mapping:update` | `manager` only | Edit/deactivate a mapping |
| `rider_pincode_mapping:delete` | `manager` only | Remove a mapping |
| `order:update` | (existing) | Delivery-leg assignment on Order |
| `rider:read` | (existing) | `GET /riders/availability` |

---

## 1. Pickup Requests (call/WhatsApp/web intake, before any Order exists)

A `PickupRequest` represents "send a rider to collect a customer's items" —
this happens **before** an `Order` is created. Once the rider brings the
items back to the store, staff build the real Order there (services, item
pricing, inspection). There is no automatic pickup-request → order
conversion yet — `convertedOrderId` on the model is a placeholder field for
a future flow, nothing writes to it today.

**Enums**

```
PickupRequestSource: web | call | whatsapp
PickupRequestStatus: requested | scheduled | rider_assigned | out_for_pickup | picked_up | received_at_store | cancelled
```
Transitions:
```
requested       → scheduled | cancelled
scheduled       → rider_assigned | cancelled
rider_assigned  → out_for_pickup | cancelled
out_for_pickup  → picked_up | cancelled
picked_up       → received_at_store
received_at_store, cancelled → (terminal)
```
`rider_assigned` is normally reached via the bulk `/pickup-requests/assign`
endpoint (§1.5), not a manual status PATCH, but both paths are valid.

### 1.1 Create

```
POST /pickup-requests
```
```json
{
  "customerId": "uuid (optional — omit for a call-in with no CRM record yet)",
  "customerName": "required",
  "customerCountryCode": "+91 (optional, defaults to +91)",
  "customerMobile": "required",
  "address": "required",
  "pincode": "optional",
  "requestedDate": "2026-08-12",
  "slot": "required, free string — no slot master exists, use whatever labels the UI already shows elsewhere",
  "storeId": "uuid (optional at creation — a call-center intake often doesn't know the destination store yet)",
  "source": "web | call | whatsapp",
  "itemCountEstimate": 5,
  "remarks": "optional"
}
```
**Response `200`**: `{ "message": "Pickup request created.", "pickupRequest": {...} }`, `status` starts at `requested`.

### 1.2 List / Count / Detail

```
GET /pickup-requests?filter={...}        // standard LB4 Filter (where/order/limit/skip)
GET /pickup-requests/count?where={...}
GET /pickup-requests/{id}                // includes assignedRider, customer, store relations
```

### 1.3 Update (details or a status transition)

```
PATCH /pickup-requests/{id}
```
Send only the fields changing. Include `status` to transition it — invalid
transitions return `400` with the current/target status named. Any other
field (`address`, `slot`, `remarks`, etc.) can be patched independent of
status.

### 1.4 Delete

```
DELETE /pickup-requests/{id}
```
Soft-delete only. Blocked (`400`) once the request is past `scheduled` —
i.e. you can delete a mistaken `requested`/`scheduled`/`cancelled` entry,
but not one that's already `rider_assigned` or further along (cancel it
via a status PATCH instead).

### 1.5 Bulk-assign to a rider (one trip, many pickups)

```
POST /pickup-requests/assign
```
```json
{
  "pickupRequestIds": ["uuid", "..."],
  "riderId": "uuid",
  "storeId": "uuid",
  "scheduledDate": "2026-08-12",
  "slot": "required",
  "remarks": "optional"
}
```
Covers the "rider can pick up multiple orders in one go" case. All listed
requests must currently be `requested` or `scheduled` (`400` naming any
that aren't already further along). On success, every request in the batch
moves to `rider_assigned`, gets a shared `runId` (groups them as one trip in
the UI — there's no separate "PickupRun" table, `runId` is just a shared
tag), and records `assignedRiderId`/`assignedAt`/`assignedBy`.

**Response `200`**: `{ "message": "Pickup requests assigned.", "runId": "uuid", "assignedCount": 3 }`

**Error cases:**
| Status | Cause |
|---|---|
| `404` | rider or store not found |
| `400` | rider inactive |
| `404` | one or more `pickupRequestIds` not found |
| `400` | one or more already `rider_assigned`/`out_for_pickup`/`picked_up`/`received_at_store` — lists their statuses |

---

## 2. Order Delivery Assignment (finished order → customer, home delivery leg)

Not to be confused with Pickup Requests — this is the **opposite end** of
the lifecycle: a finished `Order` being sent home to the customer, not raw
items being collected. New `OrderDeliveryMethod` enum:
```
store_pickup | home_delivery
```

This deliberately reuses the **existing** `Order.status` machine
(`READY → OUT_FOR_DELIVERY → DELIVERED`) — assigning a rider does **not**
change `status` by itself; dispatching still goes through the existing
`POST /orders/{id}/status` call, separately.

### 2.1 Single order — via the existing order PATCH

```
PATCH /orders/{id}
```
New optional fields alongside the order's other existing patchable fields:
```json
{
  "assignedRiderId": "uuid",
  "deliveryMethod": "home_delivery",
  "deliverySlot": "free string",
  "deliveryAddressId": "uuid"
}
```
- `assignedRiderId` → server resolves and denormalizes `assignedRiderName`
  onto the order (`400` if the rider doesn't exist or is inactive).
- `deliveryAddressId` → server resolves the `CustomerAddress` and freezes a
  text snapshot onto `Order.deliveryAddress` (address line, floor/flat,
  society, landmark, city, state, country, pincode — joined,
  comma-separated). A later edit/delete of that address never rewrites this
  order's history. `400` if the address isn't found.
- Blocked (`400`) on an order that's already `delivered`, `cancelled`, or
  `returned` — same guard as every other order-field PATCH.

### 2.2 Bulk delivery assignment (Manual Assign — delivery side)

```
POST /orders/delivery-assignment
```
```json
{
  "orderIds": ["uuid", "..."],
  "riderId": "uuid",
  "deliverySlot": "required",
  "deliveryDate": "2026-08-12T00:00:00.000Z",
  "remarks": "optional"
}
```
Assigns one rider + slot/date to several orders in one call — the "several
ready orders, one rider run" case.

**Preconditions (all server-enforced):**
- Every order must currently be `READY` or `PARTIALLY_DISPATCHED` — `400`
  listing offending statuses otherwise.
- All orders in one call must belong to the **same store** — `400`
  otherwise ("All orders in one assignment must belong to the same
  store"). This exists because `Rider` has no store relation today, so
  it's the only cross-store guard available; keep the picker single-store
  in the UI to avoid hitting it.
- Rider must exist and be active.

**Response `200`**: `{ "message": "Orders assigned for delivery.", "assignedCount": 4 }`

---

## 3. Rider Availability (live dashboard)

```
GET /riders/availability
```
No params — returns every active rider's current computed status. This
endpoint already existed; this pass adds the `on-delivery` value, derived
(not stored) from **both** an active pickup run (rider_assigned/
out_for_pickup on a `PickupRequest`) and an active delivery leg (an `Order`
assigned to this rider, still queued or already out for delivery) — one
shared value covering either case, since the practical question is just
"can I hand this rider a new job right now."

**Response `200`**
```json
{
  "riders": [
    {
      "riderId": "uuid",
      "riderCode": "RD001",
      "name": "First Last",
      "riderType": "...",
      "phone": "9876543210",
      "countryCode": "+91",
      "status": "available",
      "lastUpdatedAt": "2026-08-10T09:00:00.000Z",
      "location": null
    }
  ]
}
```
`status` precedence (top wins): `off-duty` (on leave/week-off, or never
punched in today) → `on-break` → `on-delivery` → `available`.
`location` is a placeholder (rider's stored address, not live GPS) — live
GPS tracking is a separate, not-yet-built feature ("Rider Tracking"),
don't wire a map to this field expecting it to move.

---

## 4. Rider Pincode Mapping (which rider covers which area)

One rider can cover several pincodes; a pincode can only be actively
covered by **one** rider at a time (enforced server-side, not by a DB
constraint — attempting to double-map returns `409`).

### 4.1 Create (bulk pincodes → one rider)

```
POST /rider-pincode-mappings
```
```json
{ "riderId": "uuid", "pincodes": ["400001", "400002"] }
```
Fans out into one row per pincode. Each must be a valid 6-digit pincode
(`400 Bad Request` naming the invalid one) and not already actively mapped
to someone else (`409 Conflict`, names the rider it's already mapped to).

**Response `200`**: `{ "message": "Pincodes mapped.", "mappings": [{...}, {...}] }`

### 4.2 List / Detail

```
GET /rider-pincode-mappings?filter={...}   // includes `rider` relation
GET /rider-pincode-mappings/{id}
```

### 4.3 Rider-detail-panel shortcut

```
GET /riders/{id}/pincodes
```
**Response `200`**: `{ "riderId": "uuid", "pincodes": ["400001", "400002"] }` —
active mappings only, flattened to the shape a rider-detail panel wants
directly (no need to filter the general list endpoint client-side).

### 4.4 Update

```
PATCH /rider-pincode-mappings/{id}
```
```json
{ "pincode": "400003", "isActive": false }
```
Changing `pincode` re-validates format and the one-rider-per-pincode rule
(excluding this row itself). Setting `isActive: false` frees that pincode
up for another rider to claim, without deleting the historical row.

### 4.5 Delete

```
DELETE /rider-pincode-mappings/{id}
```
Soft-delete.

---

## Not implemented this pass

- **Pickup-request → Order conversion** — `PickupRequest.convertedOrderId`
  exists on the model as a placeholder but nothing writes to it. When a
  rider brings items to a store today, staff create the Order as a normal,
  separate flow — there's no "convert this pickup request into an order"
  button/endpoint yet.
- **Rider Tracking (live GPS)** — `riders/availability`'s `location` field
  is a static address, not a live position feed. Deferred, no endpoint
  exists.
- **Slot master** — `slot`/`deliverySlot` are free strings everywhere
  above; there's no slot-definition table anywhere in the system to
  validate against.

If any of these become the next priority, flag it and we'll scope it the
same way as the rest of this module.
