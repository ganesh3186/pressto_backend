# Rider Pickup API — Reference

Everything the rider app needs to create walk-in customers, look up
addresses/preferences, populate every dropdown on the pickup-request
form, list the rider's own pickups (Pending / Completed), create a
pickup request, and drive it through to `received_at_store`.

- **Source**: `src/controllers/rider-pickup.controller.ts`
- **Auth**: JWT, `Authorization: Bearer <token>` — get one via
  `POST /auth/rider/send-otp` then `POST /auth/rider/verify-otp`
  (`rider-auth.controller.ts`).
- **Role**: `rider` — a 403 (not 401) means the token is valid but the
  account isn't rider-registered, or has been deactivated.
- **Errors**: every endpoint below fails in the same shape:
  ```json
  { "error": { "statusCode": 400, "name": "BadRequestError", "message": "..." } }
  ```

## Contents

- [Customers](#customers)
- [Addresses](#addresses)
- [Preferences](#preferences)
- [Dropdowns](#dropdowns)
- [Pickup requests](#pickup-requests)
- [Bags](#bags)
- [Enums](#enums)

---

## Customers

### `POST /rider/customers` — create a walk-in customer

Body:

```json
{
  "firstName": "Priya",
  "lastName": "Shah",
  "phone": "9876543210",
  "countryCode": "+91",
  "email": "priya@example.com"
}
```

`firstName`, `lastName`, `phone` required. Fails with `409 Conflict` if
the phone/email already belongs to an existing account — search first
(below) rather than assuming this always succeeds.

Response:

```json
{
  "message": "Customer created.",
  "customer": {
    "id": "b628bf80-325a-4460-a540-e169995f5074",
    "userId": "af016c2e-7be2-41da-a5c7-a2da1269174e",
    "customerCode": "CUST0142",
    "firstName": "Priya",
    "lastName": "Shah",
    "email": "priya@example.com"
  },
  "address": { "id": "3b1c...", "pincode": "422009", "...": "saved default address, or null" },
  "availableStores": [ { "id": "...", "name": "...", "...": "same shape as GET /rider/stores/by-pincode stores[]" } ]
}
```

`availableStores` lists the stores serving the address's pincode, for
the pickup's store picker. It is `[]` when no `address` was sent.

### `GET /rider/customers?search=<name, phone, or email>`

Empty/missing `search` returns `[]` — no full-list fallback.

```json
[
  {
    "id": "b628bf80-325a-4460-a540-e169995f5074",
    "customerCode": "CUST0142",
    "firstName": "Priya",
    "lastName": "Shah",
    "email": "priya@example.com",
    "user": { "id": "af016c2e-...", "phone": "9876543210", "countryCode": "+91" }
  }
]
```

---

## Addresses

### `GET /rider/customers/{customerId}/addresses`

```json
[
  {
    "id": "3b1c...",
    "customerId": "b628bf80-...",
    "addressName": "Home",
    "addressLine1": "N-9-D 60/3, Tulja Bhavani Marg",
    "city": "Nashik",
    "state": "Maharashtra",
    "pincode": "422009",
    "isDefault": true
  }
]
```

Only `pincode` is actually required to have saved an address — the
rest can be blank on an older or half-filled record.

### `GET /rider/customer-addresses/{id}` — one address by its own id

Same object shape as above, not wrapped in an array.

### `POST /rider/customers/{customerId}/addresses` — save a new one

Body requires `addressLine1`, `city`, `state`, `pincode`; optional:
`addressType`, `addressName`, `addressLine2`, `doorFloorFlat`,
`societyName`, `landmark`, `country`, `latitude`, `longitude`,
`isDefault`. Response: the created `CustomerAddress` object (same
shape as above).

---

## Preferences

"Do this for all my orders" defaults — created lazily with defaults on
first read, so this never 404s for a customer who's never set any.

### `GET /rider/customers/{customerId}/preferences`

```json
{
  "id": "8f2a...",
  "customerId": "b628bf80-...",
  "applyInstructionsToAllOrders": false,
  "specialInstructions": "",
  "specialInstructionMediaIds": [],
  "stainAutoApprove": false,
  "damageAutoApprove": false,
  "colourBleedingChoice": "ask_every_time",
  "upgradeServiceChoice": "notify"
}
```

### `PATCH /rider/customers/{customerId}/preferences`

Send only the fields being changed:

```json
{ "applyInstructionsToAllOrders": true, "specialInstructions": "Leave with neighbour if not home" }
```

Response: the full updated preferences object (same shape as GET).
When `applyInstructionsToAllOrders` is `true`, a pickup request that
omits `remarks`/`mediaIds` inherits `specialInstructions`/
`specialInstructionMediaIds` from here automatically.

---

## Dropdowns

Every id-shaped field on the pickup-request form has a real backing
list. All four return only active, non-deleted rows.

| Field it backs | Endpoint |
|---|---|
| `itemCategoryEstimate[].itemCategoryId` | `GET /rider/item-categories`, with `GET /rider/service-categories` as a fallback — see note below |
| `itemCategoryEstimate[].serviceId` | `GET /rider/services` |
| `slotId` | `GET /rider/pickup-slots?type&date` |
| `storeId` | `GET /rider/stores/by-pincode?addressId=` — stores serving the selected address's pincode (see below); stores from `GET /rider/stores/nearby?pincode=` are accepted too |
| `addressId` | `GET /rider/customers/{customerId}/addresses` (above) |
| `customerId` | `GET /rider/customers?search=` (above) |

**Older `itemCategoryId` values can resolve against two different tables** —
the admin panel previously saved a *service* category under its "item category"
picker. New pickups use real item-category IDs. When rendering an existing
pickup's `itemCategoryEstimate`, try `GET /rider/item-categories` first;
if the id isn't in that list, fall back to `GET /rider/service-categories`.
Rider-created pickups (via `POST /rider/pickup-requests` below) should
keep sending real item-category ids from the first list — this fallback
exists to correctly *display* older pickups, not to change
what riders themselves send.

### `GET /rider/item-categories`

```json
[
  { "id": "23172343-a279-47dc-96c6-4c200ab45d52", "name": "Shirt", "code": "SHIRT", "sequence": 1, "isActive": true }
]
```

### `GET /rider/service-categories`

```json
[
  { "id": "8a1f...", "name": "Dry Clean", "code": "DRYCLEAN", "isActive": true }
]
```

### `GET /rider/services`

```json
[
  { "id": "c84dfe93-f45f-48bc-86d3-4710264eb200", "name": "Alter Large", "code": "ALT-LG", "sequence": 4, "isActive": true }
]
```

### `GET /rider/stores`

```json
[
  { "id": "79e1ea9d-2484-4350-be9c-a32b85eb5d44", "name": "Babulnath", "code": "BBN", "city": "Mumbai", "isActive": true }
]
```

### `GET /rider/stores/by-pincode?addressId=<id>` — store picker for the pickup

The store list to show once the rider has picked the pickup address.
It returns only active stores whose pincode-coverage record has a measured
distance within the configured radius, nearest first. A store merely having
the same pincode is not enough without that measurement. Send one of:

- `addressId`: a saved address. Use this for an existing customer, or for a new
  customer after their address is saved.
- `pincode`: the 6-digit pincode of an inline, unsaved address.

```json
{
  "pincode": "400001",
  "radiusKm": 15,
  "serviceable": true,
  "stores": [
    {
      "id": "79e1ea9d-2484-4350-be9c-a32b85eb5d44",
      "name": "Babulnath",
      "storeId": "79e1ea9d-2484-4350-be9c-a32b85eb5d44",
      "storeName": "Babulnath", "code": "BBN",
      "address": "...", "city": "Mumbai", "state": "Maharashtra", "pincode": "400007",
      "phone": "...", "latitude": 18.96, "longitude": 72.81,
      "centroidDistanceKm": 2.1, "pctOfPincodeInRange": 100,
      "matchedBy": "coverage"
    }
  ]
}
```

`radiusKm` comes from the API's `STORE_ASSIGNMENT_RADIUS_KM` environment
variable. Rider and customer clients should use this response value instead of
defining their own distance limit.

`matchedBy` is `coverage` (from the pincode coverage table). Every returned
store has a measured `centroidDistanceKm` within `radiusKm`.
`serviceable: false` with an empty `stores` list means
no store serves this pincode. If `storeId` is left out on create, the
address coordinates select an active store within the configured radius;
pincode coverage is used only when usable coordinates are unavailable. With
no coordinates, the first measured in-radius store in this list is selected.

Flow:

| Customer | Steps |
|---|---|
| Existing | `GET /rider/customers?search=` → `GET /rider/customers/{id}/addresses` → pick an address → `GET /rider/stores/by-pincode?addressId=` → pick a store → `POST /rider/pickup-requests` with `addressId` + `storeId` |
| New | `POST /rider/customers` with `address`. The response includes `address.id` and `availableStores` (the same list), so no extra call is needed → pick a store → `POST /rider/pickup-requests` with `addressId` + `storeId`. A customer created without an address: `POST /rider/customers/{id}/addresses` first, then call this endpoint with that address's id. |

### `GET /rider/pickup-slots?type=pickup&date=2026-08-25`

`type` is `pickup` | `delivery` | `both` (rows tagged `both` always
included regardless of filter). `date` drops slots already past
cutoff for that day.

```json
[
  { "id": "5c1a...", "label": "9:00 AM - 11:00 AM", "type": "both", "startTime": "09:00", "endTime": "11:00" }
]
```

---

## Pickup requests

### `GET /rider/pickup-requests?tab=pending|completed&date=<optional>`

The app's two tabs:

| `tab` | Statuses included |
|---|---|
| `pending` (or omit both `tab` and `status`) | `rider_assigned`, `out_for_pickup`, `arrived_at_pickup`, `pickup_unsuccessful` |
| `completed` | `picked_up`, `received_at_store` |

`?status=<exact value>` still works if a specific single status is
ever needed instead of a bucket (e.g. `cancelled`).

`?date=2026-08-25` restricts to pickups **requested** for that one day
(`requestedDate`, not `assignedAt`) — combines with `tab`/`status`, doesn't
replace them. Useful for a day-picker view instead of one long list.
Without it, every matching pickup is returned regardless of date, same as
before.

```json
[
  {
    "id": "3ebc03e9-1157-4db1-a217-b997258374a2",
    "pickupNumber": "PU000005",
    "customerId": "b628bf80-...",
    "customerName": "Priya Shah",
    "customerMobile": "9876543210",
    "address": "N-9-D 60/3, Tulja Bhavani Marg, Nashik, 422009",
    "pincode": "422009",
    "requestedDate": "2026-08-25",
    "slot": "9:00 AM - 11:00 AM",
    "storeId": "01ee37da-75db-41e2-a83a-97bbcfe2c4a4",
    "status": "rider_assigned",
    "bagNumber": null,
    "itemCountEstimate": 4,
    "runId": "9f2c...",
    "assignedRiderId": "014e7f42-...",
    "assignedAt": "2026-08-21T11:52:29.224Z"
  }
]
```

`bagNumber` is `null` until a bag is assigned. Completed pickups also return
`actualItemsByService[].bagNumber` for each service line. This response does
not expose bag IDs; the pickup confirmation request still uses `bagId`.

### `POST /rider/pickup-requests` — create

Required: `customerId`, `slotId`, `requestedDate`, `pickupNow`. Plus
either `addressId` (a saved address) or free-text `address`.

```json
{
  "customerId": "b628bf80-325a-4460-a540-e169995f5074",
  "addressId": "3b1c...",
  "slotId": "5c1a...",
  "requestedDate": "2026-08-25",
  "pickupNow": false,
  "storeId": "01ee37da-75db-41e2-a83a-97bbcfe2c4a4",
  "handoverBy": "self",
  "itemCountEstimate": 4,
  "itemCategoryEstimate": [
    { "itemCategoryId": "23172343-a279-47dc-96c6-4c200ab45d52", "quantity": 3, "serviceId": "c84dfe93-...", "deliverySpeed": "standard" },
    { "quantity": 1 }
  ],
  "deliveryGroupingPreference": "together",
  "remarks": "Leave with security if not home"
}
```

Notes:
- **`itemCategoryEstimate[]`** — only `quantity` is required per
  entry; `itemCategoryId`/`serviceId`/`deliverySpeed` are optional
  extra detail, purely estimate metadata for the store exec (nothing
  downstream reads them as binding).
- **`pickupNow`** — controls whether this self-assigns to the creating
  rider, not just how it's grouped:
  - `true` → the rider is picking this up themselves, right now.
    Self-assigns to them. Attaches to their current `out_for_pickup`
    run if they have one; otherwise creates a standalone
    `rider_assigned` request (`storeId` required in that case).
  - `false` → a request for later, **not** for the creating rider.
    Created **unassigned** (`status: requested`, no `assignedRiderId`)
    so it shows up on the admin panel for someone to schedule to
    whichever rider makes sense — `storeId` required.
- **`handoverBy`**: `self` | `family_member` | `household_help` — if
  not `self`, `handoverPersonName` is required.
- **`storeId`** must be active and either one of the stores
  `GET /rider/stores/by-pincode` returns for the address's pincode, or a
  store `GET /rider/stores/nearby?pincode=` lists for that pincode (within
  the configured radius of the pincode's centre). Only while the pincode
  lookup is down is the radius measured from the address's coordinates.
  Otherwise the request fails with `400`, and the message lists the valid stores.
  If no store serves the pincode, any active `storeId` is still
  accepted as a manual override. Leaving out `storeId` auto-assigns
  an active store within the configured radius when coordinates are available,
  which can be a store outside the pincode coverage list. Without usable
  coordinates it selects from that list. When `pickupNow` attaches the pickup
  to the rider's active run, the run's store is used and `storeId` is ignored.

Response (attached to a run):

```json
{ "message": "Pickup request created and attached to the current run.", "pickupRequest": { "...": "same shape as the list above, status: out_for_pickup" } }
```

Response (standalone, `pickupNow: true`):

```json
{ "message": "Pickup request created.", "pickupRequest": { "...": "same shape, status: rider_assigned" } }
```

Response (`pickupNow: false` — unassigned, for admin scheduling):

```json
{ "message": "Pickup request created — awaiting rider assignment.", "pickupRequest": { "...": "same shape, status: requested, assignedRiderId: null" } }
```

### `PATCH /rider/pickup-requests/{id}/status` — advance the rider's own pickup

A rider may only move a pickup through:
`rider_assigned → out_for_pickup → arrived_at_pickup → picked_up → received_at_store`.

**`out_for_pickup` / `arrived_at_pickup` / `received_at_store`** — just the status:

```json
{ "status": "out_for_pickup" }
```

```json
{ "message": "Pickup request status updated." }
```

`arrived_at_pickup` is a pure "rider is physically at the customer's
location" breadcrumb — set it the moment the rider reaches the address,
before actually confirming the pickup:

```json
{ "status": "arrived_at_pickup" }
```

**`picked_up`** — also requires the real per-service counts confirmed
at the doorstep, **each with its own bag**:

```json
{
  "status": "picked_up",
  "itemsByService": [
    { "serviceId": "c84dfe93-f45f-48bc-86d3-4710264eb200", "quantity": 3, "deliverySpeed": "express", "remarks": "2 shirts have a small stain near the collar", "mediaIds": ["7c2b...", "9f1a..."], "bagId": "a1b2..." },
    { "serviceId": "00354f2b-363f-4a8f-9e68-44cab7256c3a", "quantity": 1, "deliverySpeed": "standard", "bagId": "e5f6..." }
  ],
  "handoverBy": "family_member",
  "handoverPersonName": "Suresh"
}
```

`handoverBy` / `handoverPersonName` are **optional**. They record who
actually handed the clothes over at the doorstep: `self`, `family_member`
or `household_help`, plus the person's name, which is required unless
`self`. When sent, they replace the values the customer chose at booking.
That's what the admin pickup detail shows as "Handover by" / "Handover
person". When left out, the booking values stay. Ask the rider at the door
rather than carrying the booking value over blindly.

`bagId` is **required on every line** — one exclusive bag per service.
Scan a separate physical bag for each service before sending this; the
same bag cannot be reused across two service lines on the same pickup
(`400` if any line is missing a `bagId`, or if the same `bagId` appears
on more than one line). Each `bagId` comes from the bag lookup below —
scan the physical bag, don't let the rider type a bag number blind.

`deliverySpeed` per line is **optional but strongly recommended** —
`standard` | `express` | `lightning`. This is what the store actually
builds the real order against once the pickup arrives (see
`RIDER_APP_PICKUP_HANDOVER_API.md`); it's separate from — and takes
priority over — the pre-arrival `itemCategoryEstimate[].deliverySpeed`
guess collected at booking time, which can be stale by the time the
rider is at the door. Confirm the speed with the customer before
sending this, don't just carry over the estimate blind.

`remarks` per line is optional free text — a rider's note against that
specific service (condition, a count caveat, anything worth flagging to
the store before they build the order). Shown as a tooltip on the
service chip in the store's Receive Items screen.

`mediaIds` per line is optional — photo(s) backing that line's remark
(e.g. proof of a pre-existing stain/damage noticed at the doorstep).
Upload each photo first via `POST /files` (multipart, see
`FileUploadController`), which returns `{ files: [{ id, fileUrl, ... }] }`
per file — collect the `id`s and send them here alongside the remark,
don't upload after confirming pickup.

```json
{ "message": "Pickup confirmed." }
```

**`pickup_unsuccessful`** — the pickup couldn't be completed. Reachable
from `out_for_pickup` or `arrived_at_pickup`. Requires structured,
multi-select `reasons`:

```json
{
  "status": "pickup_unsuccessful",
  "reasons": ["customer_not_answering", "denied_pickup"],
  "otherReason": "required when reasons includes \"other\""
}
```
```json
{ "message": "Pickup marked unsuccessful." }
```
Reason values: `customer_not_answering` · `not_approving_entry` ·
`denied_pickup` · `other`. Still shows up in `GET /rider/pickup-requests?tab=pending`
(the rider still needs to act on it) and still counts as "active" for
availability — see below to send it back out.

### `POST /rider/pickup-requests/{id}/reprocess` — retry an unsuccessful pickup

No body. Only valid when the pickup's current status is
`pickup_unsuccessful` (`400` otherwise). Sends it back to
`rider_assigned` — same rider, no reassignment — and bumps
`reprocessCount` (a plain display counter, doesn't gate anything).

```json
{ "message": "Pickup request sent back out for another attempt." }
```

---

## Bags

### `GET /rider/bags/lookup?q=<bag number or uuid>`

Scan (or type) a bag to confirm it's real and available before using
it in the `picked_up` status update above.

```json
{ "id": "a1b2c3d4-...", "bagNumber": 482, "status": "available", "maxCapacity": 30 }
```

Fails with `409 Conflict` if the bag is already `full`/`in_use`, or
`400` if inactive.

---

## Enums

**`handoverBy`** — `self` · `family_member` · `household_help`

**`itemCategoryEstimate[].deliverySpeed`** (estimate only, not
binding) — `standard` · `express` · `lightning`

**`deliveryGroupingPreference`** (estimate only, not binding) —
`together` · `as_ready`

**`source`** (set automatically by this controller, not sent by the
app) — always `web` for rider-originated requests.

**Pickup request lifecycle** — `requested → scheduled → rider_assigned
→ out_for_pickup → arrived_at_pickup → picked_up → received_at_store`,
with `cancelled` as an early exit and `pickup_unsuccessful` a detour from
`out_for_pickup`/`arrived_at_pickup` back to `rider_assigned` via
`POST .../reprocess`. A rider only ever drives the last five transitions
(see the status-update endpoint above); `requested`/`scheduled` belong
to the call-center/admin intake flow.

**`pickupUnsuccessfulReasons`** — `customer_not_answering` ·
`not_approving_entry` · `denied_pickup` · `other`.

**Preference choices** —
`colourBleedingChoice`: `ask_every_time` · `accept_risk_and_process` ·
`return_unprocessed`.
`upgradeServiceChoice`: `auto` · `notify`.

---

*pressto_backend · rider-pickup.controller.ts*
