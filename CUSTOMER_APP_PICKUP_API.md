# Customer Web App — Pickup Request Integration Guide

For the customer web app team. Self-service pickup request creation:
address → slot → who's handing over the garments → optional item count.
All new this pass, added to `customer-profile.controller.ts` alongside its
existing Addresses/Contacts/Phones sections.

**Auth**: sign in via the existing `POST /auth/customer/send-otp` →
`POST /auth/customer/verify-otp` flow (phone + OTP), which returns a JWT.
Every endpoint below just needs `Authorization: Bearer <jwt>` — no separate
permission grant, scoped automatically to whichever customer profile the
token belongs to (same pattern as every other `/profile/customer/*`
endpoint — addresses, contacts, phones, wallet).

---

## 0. Prerequisite: pick an address

A pickup request needs an existing saved address. If the customer has
none yet, add one first via the existing address endpoints:
```
GET  /profile/customer/addresses          // list saved addresses
POST /profile/customer/addresses          // add a new one
```
(See those addresses' own fields — `addressLine1`, `city`, `pincode`,
etc. — already documented/implemented; not part of this doc.)

---

## 1. List available pickup slots

```
GET /profile/customer/pickup-slots
```
No params. Returns active slots where `type` is `pickup` or `both`,
ordered `sortOrder ASC, startTime ASC` — render this list as the slot
picker.

**Response `200`**
```json
[
  {"id": "uuid", "label": "9:00 AM - 12:00 PM", "type": "pickup", "startTime": "09:00", "endTime": "12:00", "sortOrder": 1, "isActive": true}
]
```

---

## 2. Create a pickup request

```
POST /profile/customer/pickup-requests
```
```json
{
  "addressId": "uuid, required — one of the customer's own saved addresses",
  "slotId": "uuid, required — from §1's list",
  "requestedDate": "2026-08-15",
  "handoverBy": "self | family_member | household_help, required",
  "handoverPersonName": "required unless handoverBy is 'self'",
  "itemCountEstimate": 4
}
```
That's the whole form — address, slot, who's handing the garments over,
and an optional item count. Nothing else is collected on this screen.

- `handoverBy` is always required — pick one of the three values.
- `handoverPersonName` is required **only** when `handoverBy` is
  `family_member` or `household_help` (`400` — "handoverPersonName is
  required unless handoverBy is \"self\"." — if omitted/blank in that
  case). Omit it entirely when `handoverBy` is `self`.
- `itemCountEstimate` is the one genuinely optional field.

The server resolves the address into a frozen text snapshot (so a later
address edit never rewrites this request's history) and the slot into its
display label; both come back on the created object. `pincode` is also
carried over from the address automatically — used by the admin side for
pincode-based rider grouping (see `LOGISTICS_ADMIN_API.md`).

**Response `200`**
```json
{
  "message": "Pickup request created.",
  "pickupRequest": {
    "id": "uuid",
    "status": "requested",
    "address": "12, Sample Society, Andheri, Mumbai, Maharashtra, 400072",
    "pincode": "400072",
    "slot": "9:00 AM - 12:00 PM",
    "pickupSlotId": "uuid",
    "handoverBy": "family_member",
    "handoverPersonName": "Rohan Sharma",
    "itemCountEstimate": 4,
    "source": "web",
    "...": "..."
  }
}
```

**Error cases:**
| Status | Cause |
|---|---|
| `404` | no customer profile for this login (shouldn't happen for a real customer session) |
| `403` | `addressId` doesn't belong to the calling customer |
| `400` | `slotId` not found or inactive |
| `400` | `handoverPersonName` missing when required |

---

## 3. Track pickup requests

```
GET /profile/customer/pickup-requests            // own requests, newest first
GET /profile/customer/pickup-requests/{id}        // one request's detail
```
Both scoped to the caller automatically — a `{id}` belonging to someone
else returns `403`, not the record.

---

## 4. Cancel a pickup request

```
PATCH /profile/customer/pickup-requests/{id}/cancel
```
No body. Only works while the request is still `requested` or
`scheduled` — once a rider is assigned (`rider_assigned` or later), it's
`400` ("Cannot cancel a pickup request that is already X.") and the
customer needs to contact the store instead.

**Response `200`**: `{ "message": "Pickup request cancelled." }`

---

## Status values the customer app may see

```
requested → scheduled → rider_assigned → out_for_pickup → picked_up → received_at_store
                                                                              ↘ cancelled (from requested/scheduled/rider_assigned/out_for_pickup only)
```
Everything past `requested` is driven by the store/rider side (see
`LOGISTICS_ADMIN_API.md` / `RIDER_APP_PICKUP_API.md`) — nothing else for
the customer app to trigger beyond create (§2) and cancel (§4).
