# Rider App — Pickup Integration Guide

For the rider app team. Covers the "neighbour also wants a pickup" flow —
a rider already on the ground creating a brand-new customer and pickup
request, seeing their own assigned pickups, and moving one through its
status lifecycle. All new this pass (`rider-pickup.controller.ts`).

**Auth**: the rider app already signs in via `POST /auth/rider/send-otp` →
`POST /auth/rider/verify-otp` (phone + OTP, pre-existing —
`rider-auth.controller.ts`), returning a JWT whose role is `rider`. Every
endpoint below requires `Authorization: Bearer <jwt>` from that login and
is gated purely by having the `rider` role (not the admin permission
system) — an inactive rider account gets a `403` on every call
("This rider account is inactive").

---

## 1. Enums

```
PickupHandoverBy: self | family_member | household_help
PickupRequestStatus (rider-relevant subset — see §4):
  rider_assigned → out_for_pickup → picked_up → received_at_store
```

---

## 2. Create a walk-in customer

```
POST /rider/customers
```
```json
{
  "firstName": "required",
  "lastName": "required",
  "email": "optional",
  "phone": "required",
  "countryCode": "+91 (optional, defaults to +91)"
}
```
For the case where a neighbour of the current pickup also wants their
items collected and has no account yet. Creates a login, the `customer`
role, a `Customer` profile, and a wallet/security-deposit record — same
setup a self-registered customer gets.

**Response `200`**: `{ "message": "Customer created.", "customer": {...} }`

**Error cases — all `409 Conflict`, no retry-with-flag path (unlike the
admin/self-registration flows) since the rider app has no UI for a
confirm-and-link step:**
| Cause | Message |
|---|---|
| Phone/email belongs to a `super_admin`-class account | "That phone or email belongs to a protected system account." |
| Phone/email already belongs to an existing customer | "...already belongs to customer CUST0005 — search for them instead of creating a new one." → use §3 instead |
| Phone/email belongs to a non-customer login (e.g. staff) | "...Ask the store to add this customer instead." |

---

## 2a. Customer addresses

`POST /rider/pickup-requests` (§5) already accepts either a saved
`addressId` or free inline `address` text. These three let the rider app
actually resolve a saved address into a picklist, look one up directly,
and — for a brand-new customer — save a **real, reusable** address
instead of only ever sending inline text good for this one pickup.

```
GET /rider/customers/{customerId}/addresses
```
That customer's saved addresses (same shape as the admin/customer-app
`CustomerAddress` records). Empty array for a brand-new customer with
nothing saved yet.

```
GET /rider/customer-addresses/{id}
```
One address by id. `404` if it doesn't exist.

```
POST /rider/customers/{customerId}/addresses
```
```json
{
  "addressLine1": "required",
  "city": "required",
  "state": "required",
  "pincode": "required",
  "addressLine2": "optional",
  "doorFloorFlat": "optional",
  "societyName": "optional",
  "landmark": "optional",
  "addressName": "optional — e.g. \"Father's home\"",
  "latitude": "optional",
  "longitude": "optional",
  "isDefault": "optional"
}
```
This is the "for a new customer, the rider can add their address" call —
use it right after §2 creates the customer, instead of (or in addition
to) sending inline `address` text on the pickup request. The saved
address then shows up in §2a's list and is reusable on this customer's
next pickup, and is the same record the customer would see if they ever
log into the customer web app.

**Response `200`**: the created `CustomerAddress` object, same shape as
§2a's list entries.

---

## 3. Search existing customers

```
GET /rider/customers?search=<term>
```
Matches `firstName`/`lastName`/`email` (case-insensitive, partial). Empty
or missing `search` returns `[]` — no "browse all customers" mode. Each
result includes its linked `user` (id, phone, countryCode) so the rider
app can display a phone number without a second call. Capped at 20 results.

Use this **before** §2 — only create a new customer if search comes back
empty.

---

## 4. The rider's own assigned pickups

```
GET /rider/pickup-requests?status=<optional>
```
Without `status`, returns only the active ones (`rider_assigned` or
`out_for_pickup`) — the working list. Pass `status` explicitly to see
`picked_up`/`received_at_store`/etc. history instead. Ordered
`assignedAt DESC`.

---

## 4a. Pickup / delivery slots

```
GET /rider/pickup-slots?type=<optional>
```
The `slotId` §5 needs. No `type` → every active slot, of any type. Pass
`type=pickup` or `type=delivery` to filter to that type plus slots marked
`both` (same shape as the customer app's slot picker) — useful if the
screen shows separate pickup-time and expected-delivery-time pickers.

**Response `200`**
```json
[
  {"id": "uuid", "label": "9:00 AM - 12:00 PM", "type": "pickup", "startTime": "09:00", "endTime": "12:00", "sortOrder": 1, "isActive": true}
]
```

---

## 5. Create a pickup request (the walk-in flow)

```
POST /rider/pickup-requests
```
```json
{
  "customerId": "uuid, required",
  "addressId": "uuid — one of the customer's saved addresses",
  "address": "string — inline text, for a brand-new customer with nothing saved",
  "slotId": "uuid, required",
  "requestedDate": "2026-08-16",
  "handoverBy": "self | family_member | household_help (optional)",
  "handoverPersonName": "required if handoverBy is set and not 'self'",
  "itemCountEstimate": 3,
  "pickupNow": true,
  "storeId": "uuid — required only when pickupNow is false"
}
```
Provide **either** `addressId` (resolved + frozen as a text snapshot,
same as the customer app) **or** `address` (free text) — `400` if neither
is given, or if `addressId` doesn't belong to `customerId`.

### `pickupNow` — the two branches

- **`true`**: attaches to the rider's own **current ongoing run** — the
  most recent pickup request assigned to this rider that's currently
  `out_for_pickup`. The new request inherits that run's `runId` and
  `storeId` automatically and is created directly at `out_for_pickup`
  (skipping `rider_assigned` — it's already in hand). `400` ("No ongoing
  pickup run to attach to — assign yourself a pickup first") if the rider
  has nothing `out_for_pickup` right now — walk the existing pickup to
  `out_for_pickup` first (§6) before using `pickupNow: true` on a new one.
- **`false`**: a standalone new pickup, its own new `runId`, created at
  `rider_assigned`. `storeId` is **required** in this branch — there's no
  run to inherit it from.

**Response `200`**: `{ "message": "...", "pickupRequest": {...} }` — the
message differs slightly ("...and attached to the current run." vs plain
"created.") so the UI can distinguish which branch fired without parsing
the object.

---

## 6. Move a pickup through its lifecycle

```
PATCH /rider/pickup-requests/{id}/status
```
```json
{"status": "out_for_pickup"}
```
Riders may only ever set one of: `out_for_pickup`, `picked_up`,
`received_at_store` (attempting anything else, e.g. `cancelled`, is
`400` — "Riders cannot set status to X"; that stays an admin/manager
action). Must currently be assigned to the calling rider (`403` — "This
pickup request is not assigned to you." — otherwise), and the move must be
a legal transition per §1's chain (`400` naming the current/target status
if not, e.g. can't jump straight from `rider_assigned` to `picked_up`
without passing through `out_for_pickup`).

---

## Typical flow, end to end

1. `GET /rider/pickup-requests` → see today's assigned pickups.
2. `PATCH .../{id}/status {status: "out_for_pickup"}` → heading out.
3. On arrival, a neighbour also wants a pickup:
   a. `GET /rider/customers?search=...` → not found.
   b. `POST /rider/customers` → new customer created.
   c. `POST /rider/customers/{customerId}/addresses` → save their address for real (§2a) — or skip this and use inline `address` text on the next call.
   d. `GET /rider/pickup-slots` → pick a `slotId` (§4a).
   e. `POST /rider/pickup-requests {customerId, addressId, slotId, requestedDate, pickupNow: true}` → joins the same run, already `out_for_pickup`.
4. Back at the store: `PATCH .../{id}/status {status: "picked_up"}` for each, then `{status: "received_at_store"}` once handed off.

Everything created here is immediately visible to the admin Pickup
Management screen (see `LOGISTICS_ADMIN_API.md`) under the same `runId`.
