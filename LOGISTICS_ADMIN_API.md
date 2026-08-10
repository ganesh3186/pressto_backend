# Pickup Management — Admin Panel Integration Guide

For the admin panel team (Pickup Management screen + the new Pickup/Delivery
Slot master). Covers the full `PickupRequest` admin surface — both what
already existed and what this pass added — plus the new Slot master CRUD.

All routes require `Authorization: Bearer <jwt>`.

| Permission | Who has it | Gates |
|---|---|---|
| `pickup_request:create` | `manager`, `store_exec` | Create a pickup request |
| `pickup_request:read` | `manager`, `store_exec` | List/view pickup requests |
| `pickup_request:update` | `manager`, `store_exec` | Update, status transitions, `assign` |
| `pickup_request:delete` | `manager` only | Soft-delete a pickup request |
| `pickup_delivery_slot:create` | `manager` only | Create a slot |
| `pickup_delivery_slot:read` | `manager`, `store_exec` | View slots |
| `pickup_delivery_slot:update` | `manager` only | Edit a slot |
| `pickup_delivery_slot:delete` | `manager` only | Delete a slot |

---

## 1. Pickup/Delivery Slot master

Time-window definitions (e.g. "9:00 AM – 12:00 PM") used everywhere a slot
needs to be picked — customer app, rider app, and this admin flow.

**Enum — `PickupDeliverySlotType`**: `pickup | delivery | both`

```
POST   /pickup-delivery-slots
GET    /pickup-delivery-slots?filter={...}   // standard LB4 Filter
GET    /pickup-delivery-slots/count?where={...}
GET    /pickup-delivery-slots/{id}
PATCH  /pickup-delivery-slots/{id}
DELETE /pickup-delivery-slots/{id}           // soft delete
```

**Slot fields**: `id, label, type, startTime ("HH:mm"), endTime ("HH:mm"),
sortOrder (default 0, for dropdown ordering), isActive (default true)`.

**Create body**
```json
{
  "label": "9:00 AM - 12:00 PM",
  "type": "pickup",
  "startTime": "09:00",
  "endTime": "12:00",
  "sortOrder": 1
}
```

List/detail have no permission gate beyond `pickup_delivery_slot:read` —
only `isDeleted: false` rows are ever returned, ordered `sortOrder ASC,
startTime ASC` by default.

---

## 2. Pickup Requests

**Enums**
```
PickupRequestSource: web | call | whatsapp
PickupRequestStatus: requested | scheduled | rider_assigned | out_for_pickup | picked_up | received_at_store | cancelled
PickupHandoverBy:    self | family_member | household_help   (customer-app-originated requests only)
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

### 2.1 Create (call/WhatsApp "generate request" from Pickup Management)

```
POST /pickup-requests
```
```json
{
  "customerId": "uuid (optional — omit if no CRM match)",
  "customerName": "required",
  "customerCountryCode": "+91 (optional, defaults to +91)",
  "customerMobile": "required",
  "address": "required",
  "pincode": "optional",
  "requestedDate": "2026-08-12",
  "slot": "required free string — used as-is unless slotId is also given",
  "slotId": "uuid (optional — if given, overrides slot with this slot's label)",
  "storeId": "uuid (optional at creation)",
  "source": "web | call | whatsapp",
  "itemCountEstimate": 5,
  "remarks": "optional"
}
```
This is the endpoint behind Pickup Management's "generate request" action
for phone/WhatsApp intake — no separate endpoint exists for that, it's the
same `create()` with `source: call` or `source: whatsapp`. Prefer sending
`slotId` (resolved against the new Slot master, §1) over a hand-typed
`slot` string going forward.

**Response `200`**: `{ "message": "Pickup request created.", "pickupRequest": {...} }`, `status` starts at `requested`.

### 2.2 List (with pincode grouping + suggested-rider hint)

```
GET /pickup-requests?filter={...}
```
Standard LoopBack `Filter` — e.g. group same-pincode requests before
assigning:
```
GET /pickup-requests?filter[where][pincode]=400001
```

**New this pass**: every row in the response now also carries a
`suggestedRiderId`/`suggestedRiderName`, resolved from the existing
`RiderPincodeMapping` (Rider Management's pincode coverage map) for that
row's `pincode`. Both are `null` when no active mapping covers that
pincode. **This is advisory only** — use it to pre-select/highlight a
rider in the assign dialog, but the admin can still assign a different
rider via §2.6; nothing is enforced server-side.

```json
[
  {
    "id": "uuid", "customerName": "...", "pincode": "400001", "status": "requested",
    "...rest of the PickupRequest fields...",
    "suggestedRiderId": "uuid-or-null",
    "suggestedRiderName": "Ravi Kumar-or-null"
  }
]
```

### 2.3 Count / Detail

```
GET /pickup-requests/count?where={...}
GET /pickup-requests/{id}     // includes assignedRider, customer, store relations
```

### 2.4 Update (details or a status transition)

```
PATCH /pickup-requests/{id}
```
Send only the fields changing; include `status` to transition it (`400`
naming the current/target status if the transition isn't in the table
above). Any other field (`address`, `slot`, `remarks`, etc.) can be patched
independent of status. Not yet updated to accept `slotId` — send the
resolved label directly in `slot` if changing it here.

### 2.5 Delete

```
DELETE /pickup-requests/{id}
```
Soft-delete only. Blocked (`400`) once the request is past `scheduled` —
delete a mistaken `requested`/`scheduled`/`cancelled` entry, cancel
anything further along via a status `PATCH` instead.

### 2.6 Bulk-assign to a rider (one trip, many pickups)

```
POST /pickup-requests/assign
```
```json
{
  "pickupRequestIds": ["uuid", "..."],
  "riderId": "uuid",
  "storeId": "uuid",
  "scheduledDate": "2026-08-12",
  "slot": "required free string — used as-is unless slotId is also given",
  "slotId": "uuid (optional — if given, overrides slot with this slot's label)",
  "remarks": "optional"
}
```
This is where the pincode-grouping workflow lands: select several
same-pincode requests from the enriched list (§2.2), pass their ids here
along with the rider (defaulting the picker to `suggestedRiderId` when
present). All listed requests must currently be `requested` or `scheduled`
(`400` naming any that aren't). On success, every request in the batch
moves to `rider_assigned` and gets a shared `runId` — the same tag the
rider app's "attach to current run" (`pickupNow`, see the rider-app doc)
later joins onto.

**Response `200`**: `{ "message": "Pickup requests assigned.", "runId": "uuid", "assignedCount": 3 }`

**Error cases:**
| Status | Cause |
|---|---|
| `404` | rider or store not found |
| `400` | rider inactive |
| `404` | one or more `pickupRequestIds` not found |
| `400` | one or more already `rider_assigned`/`out_for_pickup`/`picked_up`/`received_at_store` — lists their statuses |

---

## Notes for the frontend

- A pickup request created via the **customer web app** (source `web`,
  built separately — see the customer-app doc) will already have
  `handoverBy`/`handoverPersonName`/`itemCountEstimate` and a resolved
  `slot` — nothing extra to do on the admin side for those, they just show
  up in the list/detail like any other request.
- A pickup request created via the **rider app** (walk-in "neighbour also
  wants a pickup" case — see the rider-app doc) shows up here too,
  already `rider_assigned` or `out_for_pickup` and pre-linked to a
  `runId`/`storeId` — no action needed unless something needs correcting.
- `Order.deliverySlotId` (the equivalent slot reference for **finished-order
  home delivery**, not pickup) was also added this pass on
  `PATCH /orders/{id}` and `POST /orders/delivery-assignment` — same Slot
  master, different leg of the lifecycle. Not part of this doc's scope.
