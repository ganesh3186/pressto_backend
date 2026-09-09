# Pickup — End-to-End API Sequence

For the rider app team. This is a pure call-sequence walkthrough — which
API to call after which, with real request/response shapes at each step.
For the full field-by-field reference on any individual endpoint, see
`RIDER_PICKUP_API.md` / `RIDER_APP_PICKUP_HANDOVER_API.md`.

Two starting points, same fulfillment tail:

- **Flow A** — the pickup request already exists (booked by the customer
  on the customer-web app, or entered by admin/call-center) and gets
  assigned to a rider. The rider's job starts at "see it on my list."
- **Flow B** — the rider is standing at a door and a neighbour/walk-in
  customer also wants a pickup. The rider creates the customer, the
  address, and the pickup request themselves, on the spot.

Flow B ends by merging into Flow A's fulfillment steps (§A.2 onward) —
once a `PickupRequest` exists, doesn't matter who created it.

All calls: `Authorization: Bearer <rider JWT>`.

---

## Flow A — Fulfilling an existing pickup request

### A.1 — See it on the assigned list

```
GET /rider/pickup-requests?tab=pending
```
**Response `200`**
```json
[
  {
    "id": "3ebc03e9-1157-4db1-a217-b997258374a2",
    "pickupNumber": "PU000005",
    "customerId": "b628bf80-325a-4460-a540-e169995f5074",
    "customerName": "Priya Shah",
    "customerMobile": "9876543210",
    "address": "N-9-D 60/3, Tulja Bhavani Marg, Nashik, 422009",
    "requestedDate": "2026-08-25",
    "slot": "9:00 AM - 11:00 AM",
    "storeId": "01ee37da-75db-41e2-a83a-97bbcfe2c4a4",
    "status": "rider_assigned",
    "itemCountEstimate": 4,
    "assignedRiderId": "014e7f42-...",
    "assignedAt": "2026-08-25T05:00:00.000Z"
  }
]
```
Whether this row came from customer-web self-booking or an admin/
call-center intake makes no difference here — both land as
`status: "rider_assigned"`, indistinguishable at this point. Take the `id`
from whichever row the rider taps.

### A.2 — Head out

```
PATCH /rider/pickup-requests/{id}/status
{"status": "out_for_pickup"}
```
**Response `200`**: `{"message": "Pickup request status updated."}`

### A.3 — Arrived at the address

```
PATCH /rider/pickup-requests/{id}/status
{"status": "arrived_at_pickup"}
```
**Response `200`**: `{"message": "Pickup request status updated."}`

### A.4 — Fork: confirm pickup, or mark it unsuccessful

**A.4a — Confirm pickup** (scan the bag first)
```
GET /rider/bags/lookup?q=482
```
**Response `200`**
```json
{"id": "a1b2c3d4-...", "bagNumber": 482, "status": "available", "maxCapacity": 30}
```
```
PATCH /rider/pickup-requests/{id}/status
{
  "status": "picked_up",
  "bagId": "a1b2c3d4-...",
  "itemsByService": [{"serviceId": "c84dfe93-...", "quantity": 3}]
}
```
**Response `200`**: `{"message": "Pickup confirmed."}`
→ continue at **A.5**.

**A.4b — Mark unsuccessful instead**
```
PATCH /rider/pickup-requests/{id}/status
{"status": "pickup_unsuccessful", "reasons": ["customer_not_answering"]}
```
**Response `200`**: `{"message": "Pickup marked unsuccessful."}`

To retry the same pickup:
```
POST /rider/pickup-requests/{id}/reprocess
```
**Response `200`**: `{"message": "Pickup request sent back out for another attempt."}`
→ status is back to `rider_assigned` — loop back to **A.2**.

To give up on it instead, an admin cancels it from the admin panel
(riders can't self-cancel from `pickup_unsuccessful`).

### A.5 — Get it to the store: two ways

**A.5a — Self-report directly** (simplest — one rider, one pickup)
```
PATCH /rider/pickup-requests/{id}/status
{"status": "received_at_store"}
```
**Response `200`**: `{"message": "Pickup request status updated."}` — bag
released automatically. **Done.**

**A.5b — Batch handover with a QR/code** (several pickups at once, or
handing off to another rider/van instead of walking them in yourself)
```
GET /rider/pickup-requests/handover-eligible
```
**Response `200`**: `{"pickupRequests": [ /* your own picked_up requests */ ]}`
```
POST /rider/pickup-handovers
{"pickupRequestIds": ["<id>"], "handoverToType": "store", "handoverToStoreId": "01ee37da-..."}
```
**Response `200`**
```json
{
  "message": "Pickup handover submitted.",
  "handover": {"id": "uuid", "handoverNumber": "PH-RID001-2508-3", "handoverCode": "954229", "status": "pending"}
}
```
Show `handoverCode` as text + QR. Store staff resolve and confirm it
(admin panel, not a rider-app call):
```
GET /pickup-handovers/lookup?code=954229   → preview the batch
POST /pickup-handovers/{id}/confirm        → each linked pickup request
                                              moves to received_at_store
```
Full detail on this path (including handing off to another rider/van
instead of a store): `RIDER_APP_PICKUP_HANDOVER_API.md`.

### A.6 — Beyond `received_at_store`

Building the real, priced `Order` (services, item inspection, pricing)
from a received pickup is currently a manual step store staff do in the
admin panel — `PickupRequest.convertedOrderId` exists as a placeholder
link but nothing writes to it automatically yet. Nothing further to call
from the rider app for this specific pickup once it's `received_at_store`.

---

## Flow B — Rider creates the pickup themselves

Typically triggered mid-run: "my neighbour also wants a pickup." Ends by
joining Flow A at **A.2** (or straight into `out_for_pickup` if
`pickupNow: true` and there's a run to attach to — see B.6).

### B.1 — Check if the customer already exists

```
GET /rider/customers?search=Ramesh
```
**Response `200`**: `{"customers": []}` — not found, so create one.

### B.2 — Create the walk-in customer

```
POST /rider/customers
{"firstName": "Ramesh", "lastName": "Kulkarni", "phone": "9812345678"}
```
**Response `200`**
```json
{"message": "Customer created.", "customer": {"id": "uuid-new-customer", "customerCode": "CUST0912", ...}}
```

### B.3 — Save their address

```
POST /rider/customers/{customerId}/addresses
{"addressType": "home", "addressLine1": "B-12, Sunrise Apartments", "pincode": "400072"}
```
**Response `200`**: `{"message": "Address saved.", "address": {"id": "uuid-new-address", ...}}`
(Or skip this and send free-text `address` inline on B.6 instead.)

### B.4 — Pick a slot

```
GET /rider/pickup-slots?type=pickup&date=2026-08-25
```
**Response `200`**: `{"slots": [{"id": "uuid-slot", "label": "2:00 PM - 4:00 PM", ...}]}`

### B.5 — Dropdowns for the estimate (optional detail)

```
GET /rider/item-categories   → {"itemCategories": [...]}
GET /rider/services          → {"services": [...]}   (independent services only)
```

### B.6 — Create the pickup request

```
POST /rider/pickup-requests
{
  "customerId": "uuid-new-customer",
  "addressId": "uuid-new-address",
  "slotId": "uuid-slot",
  "requestedDate": "2026-08-25",
  "pickupNow": true,
  "storeId": "01ee37da-...",
  "itemCategoryEstimate": [{"itemCategoryId": "uuid-cat", "quantity": 3}]
}
```
**Response `200`** — one of two shapes, depending on `pickupNow`:

Attached to the rider's current run (already `out_for_pickup`, they don't
have one going yet, or `pickupNow: false`):
```json
{"message": "Pickup request created and attached to the current run.", "pickupRequest": {"id": "uuid", "status": "out_for_pickup", ...}}
```
or, standalone (no run to attach to, or `pickupNow: false`):
```json
{"message": "Pickup request created.", "pickupRequest": {"id": "uuid", "status": "rider_assigned", ...}}
```

### B.7 — Join Flow A

- If the response's `status` is `out_for_pickup` → skip straight to **A.3**
  (already heading there, `pickupNow` fast-forwarded past the assignment
  step).
- If `status` is `rider_assigned` → continue at **A.2**.
