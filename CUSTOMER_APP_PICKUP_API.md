# Customer Web App — Pickup Request Integration Guide

For the customer web app team. Self-service pickup request creation:
address → slot → who's handing over the garments → optional item count,
plus preferences (§5) and home-screen offers (§6), added on request from
the frontend team's feedback pass. All added to
`customer-profile.controller.ts` alongside its existing
Addresses/Contacts/Phones sections.

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
GET /profile/customer/pickup-slots?date=<optional>
```
Returns active slots where `type` is `pickup` or `both`, ordered
`sortOrder ASC, startTime ASC` — render this list as the slot picker.

Slots are still the same fixed recurring time-of-day windows — there's no
per-date data. `date` only changes which of those same slots come back:
if `date` is **today**, any slot starting less than 90 minutes from now
is left out (so a customer can't pick a window that's effectively
already gone); any other date (up to however far ahead your date picker
allows) shows every active slot, unfiltered. Pass whatever date the
customer has selected in the date picker so far; omit it to see the
unfiltered list.

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
  "itemCountEstimate": 4,
  "itemCategoryEstimate": [
    {"itemCategoryId": "uuid-from-item-categories-list", "quantity": 3},
    {"itemCategoryId": "uuid-of-curtain-category", "quantity": 2}
  ],
  "remarks": "Please handle the silk saree gently, stain on the sleeve.",
  "mediaIds": ["uuid-from-file-upload-1", "uuid-from-file-upload-2"]
}
```
That's the whole form — address, slot, who's handing the garments over,
an optional item count (aggregate and/or per-category), and an optional
free-text note with optional attached photos/voice notes. Nothing else is
collected on this screen.

- `handoverBy` is always required — pick one of the three values.
- `handoverPersonName` is required **only** when `handoverBy` is
  `family_member` or `household_help` (`400` — "handoverPersonName is
  required unless handoverBy is \"self\"." — if omitted/blank in that
  case). Omit it entirely when `handoverBy` is `self`.
- `itemCountEstimate`, `itemCategoryEstimate`, `remarks`, and `mediaIds`
  are all optional.
- `itemCategoryEstimate` is a per-category breakdown (e.g. how many
  clothes vs curtains) — used by ops to size the pickup (bike vs van).
  Fetch the category list first via §2a below; each entry is
  `{itemCategoryId, quantity}`. `itemCountEstimate` (the plain aggregate
  number) still works on its own if you don't want to build category
  selection — send either, both, or neither.
- `remarks` is a plain string — this is the "special instructions" free-text
  field. It's already surfaced on the admin side (ops/store staff can see
  it against the pickup request today) — this endpoint just didn't accept
  it before.
- `mediaIds` is an array of media IDs for any photos or voice notes the
  customer attaches to their instructions. Upload each file **first** via
  the generic file service (see §2b below), collect the returned `id` for
  each, then pass the array here. There's no per-item granularity in this
  system's data model — one flat note + one flat set of attachments per
  pickup request, not per garment.
- If the customer has `applyInstructionsToAllOrders: true` saved in their
  preferences (§5) and this request omits `remarks` and/or `mediaIds`
  entirely, the server fills in the stored defaults automatically — per
  field independently. Send an explicit value (even an empty string) to
  override the stored default for this one request.

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
    "itemCategoryEstimate": [{"itemCategoryId": "uuid", "quantity": 3}],
    "remarks": "Please handle the silk saree gently, stain on the sleeve.",
    "mediaIds": ["uuid-from-file-upload-1", "uuid-from-file-upload-2"],
    "source": "web",
    "...": "..."
  }
}
```

---

## 2a. Item categories (for `itemCategoryEstimate` above)

```
GET /profile/customer/item-categories
```
No params. Returns active categories, ordered `sequence ASC, name ASC` —
render as checkboxes/steppers ("Shirts: 3", "Curtains: 2", etc.).

**Response `200`**
```json
[
  {"id": "uuid", "name": "Shirt", "code": "SHIRT", "sequence": 1, "isActive": true},
  {"id": "uuid", "name": "Curtain", "code": "CURTAIN", "sequence": 19, "isActive": true}
]
```

---

## 2b. Uploading photos/voice notes (for `mediaIds` above)

```
POST /files
```
Multipart form upload (any field name, one or more files). No auth header
needed — this is a shared, pre-existing file service already used by the
admin panel and rider app for the same purpose (e.g. order-level special
instruction photos).

**Response `200`**
```json
{
  "files": [
    {"id": "uuid", "fileUrl": "https://.../files/file/...", "fileName": "stain.jpg"}
  ],
  "fields": {}
}
```
Take each returned `id` and put it in the `mediaIds` array in §2. Upload
files before creating the pickup request — `mediaIds` only accepts IDs
that already exist.

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

## 5. Preferences ("apply to all my orders" + auto-approve choices)

A customer's stored defaults — special instructions to reuse on future
pickups, plus a handful of auto-approve-style choices for what happens
during in-store inspection. Every customer implicitly has default
preferences (all off / "ask every time") even before ever saving any.

```
GET /profile/customer/preferences
```
**Response `200`**
```json
{
  "id": "uuid",
  "customerId": "uuid",
  "applyInstructionsToAllOrders": false,
  "specialInstructions": null,
  "specialInstructionMediaIds": [],
  "stainAutoApprove": false,
  "damageAutoApprove": false,
  "colourBleedingChoice": "ask_every_time",
  "upgradeServiceChoice": "notify"
}
```

```
PATCH /profile/customer/preferences
```
Send only the fields you want to change — a partial body.
```json
{
  "applyInstructionsToAllOrders": true,
  "specialInstructions": "Please use cold water for all my orders.",
  "specialInstructionMediaIds": ["uuid-from-file-upload"],
  "colourBleedingChoice": "accept_risk_and_process"
}
```
- `colourBleedingChoice` — one of `ask_every_time` | `accept_risk_and_process` | `return_unprocessed`.
- `upgradeServiceChoice` — one of `auto` | `notify`.
- `stainAutoApprove` / `damageAutoApprove` — booleans.
- **Important — what these actually do right now**: `applyInstructionsToAllOrders` is the one preference with a real effect today (see §2 — it fills in `remarks`/`mediaIds` on a new pickup request when the request omits them). The auto-approve flags (`stainAutoApprove`, `damageAutoApprove`, `colourBleedingChoice`, `upgradeServiceChoice`) are **stored and returned, but not yet wired into the in-store approval workflow** — staff still see and decide every damage/stain/risk case during inspection; `colourBleedingChoice` is shown to staff as an informational note on the inspection screen. Auto-resolving real approval requests from these flags is a planned follow-up, not yet live — don't build UI copy that promises it skips staff review.
- Every change is written to an audit trail (who/when/old→new) — visible to ops on the admin side, not exposed to the customer app.

## 6. Home offers — active coupons for this customer

```
GET /profile/customer/coupons/active?storeId=<uuid>
```
Returns only coupons this specific customer currently qualifies for
(date-valid, usage available, and — if the coupon targets a customer
label or was individually granted — actually eligible). `storeId` is
optional; if omitted, the customer's saved `preferredStoreId` is used if
set. A coupon scoped to specific stores/clusters/regions is only
included if a resolvable `storeId` matches; a coupon with no geo scope
always shows regardless.

**Response `200`**
```json
[
  {
    "id": "uuid",
    "code": "FLAT50",
    "name": "Flat 50 off",
    "description": "50% off, up to ₹200, on your next order.",
    "colorTag": "#FF6B6B",
    "discountType": "percentage",
    "discountValue": 50,
    "maxDiscountAmount": 200,
    "endDate": "2026-09-30"
  }
]
```
Render as the home-screen offer cards — `name`/`code` as the title,
`description` as the T&Cs line, `endDate` as the expiry. This is a
preview list only; actually applying a code at checkout is a separate,
already-existing flow (`POST /coupons/validate` on the order-creation
side — not part of this doc, ask about order/checkout integration
separately).

---

## Also changed: `GET /profile/customer/orders`

Not part of this doc's original scope, but worth flagging: this
existing endpoint (and `/orders/summary`) now excludes `draft` orders —
a draft isn't really "the customer's" yet (nothing was ever confirmed),
so it never shows up in their order list or counts. No request/response
shape change, just fewer rows.

## Status values the customer app may see

```
requested → scheduled → rider_assigned → out_for_pickup → picked_up → received_at_store
                                                                              ↘ cancelled (from requested/scheduled/rider_assigned/out_for_pickup only)
```
Everything past `requested` is driven by the store/rider side (see
`LOGISTICS_ADMIN_API.md` / `RIDER_APP_PICKUP_API.md`) — nothing else for
the customer app to trigger beyond create (§2) and cancel (§4).
