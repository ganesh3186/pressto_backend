# Rider Pickup Dropdowns — API Reference

Six read-only endpoints that back every dropdown on the rider app's "create
pickup request" screen — three brand new (category, service, store), three
already live. All role-gated to `rider`, same as the rest of the rider
surface.

- **Auth**: JWT, `Authorization: Bearer <token>`
- **Role**: `rider`
- **Controller**: `src/controllers/rider-pickup.controller.ts`

## Contents

- [Getting a token](#getting-a-token)
- [New — master-data dropdowns](#new--master-data-dropdowns)
  - [GET /rider/item-categories](#get-riderdrop-item-categories)
  - [GET /rider/services](#get-riderservices)
  - [GET /rider/stores](#get-riderstores)
- [Already available](#already-available)
  - [GET /rider/pickup-slots](#get-riderpickup-slots)
  - [GET /rider/customers/{customerId}/addresses](#get-ridercustomerscustomeridaddresses)
  - [GET /rider/customers](#get-ridercustomers)
- [Field → endpoint map](#field--endpoint-map)
- [Fixed-choice fields](#fixed-choice-fields)
- [On errors](#on-errors)

---

## Getting a token

Every endpoint below needs a rider JWT. Two calls, no password — OTP over SMS.

**`POST /auth/rider/send-otp`**
Body: `{ phone, countryCode }`. Sends a 6-digit OTP to the rider's registered phone.

**`POST /auth/rider/verify-otp`**
Body: `{ phone, countryCode, otp }`. Returns the JWT to send as
`Authorization: Bearer <token>` on every call below.

---

## New — master-data dropdowns

Back `itemCategoryEstimate[].itemCategoryId`, `itemCategoryEstimate[].serviceId`
and the top-level `storeId` on the pickup-request form. Each returns only
active, non-deleted rows.

### GET /rider/item-categories

Every garment category a customer can hand over — Shirt, Bedsheet, Curtain,
and so on. Feeds one row per line in `itemCategoryEstimate`.

**Response fields**

| Field | Type |
|---|---|
| `id` | uuid |
| `name` | string |
| `code` | string |
| `sequence` | number |
| `isActive` | boolean |

**Sample response**

```json
[
  {
    "id": "23172343-a279-47dc-96c6-4c200ab45d52",
    "name": "Shirt",
    "code": "SHIRT",
    "sequence": 1,
    "isActive": true
  }
  // … 19 more
]
```

### GET /rider/services

Every service offered — Dry Clean, Press, Alter, and so on. Optional per
category line; the real service gets confirmed at in-store inspection, not
on the doorstep.

**Response fields**

| Field | Type |
|---|---|
| `id` | uuid |
| `name` | string |
| `code` | string |
| `sequence` | number |
| `isActive` | boolean |

**Sample response**

```json
[
  {
    "id": "c84dfe93-f45f-48bc-86d3-4710264eb200",
    "name": "Alter Large",
    "code": "ALT-LG",
    "sequence": 4,
    "isActive": true
  }
  // … 146 more
]
```

### GET /rider/stores

Every store, unfiltered — riders aren't scoped to one store, they cover a
pincode radius. Only required when `pickupNow=false` — the run isn't
already anchored to a store's queue.

**Response fields**

| Field | Type |
|---|---|
| `id` | uuid |
| `name` | string |
| `code` | string |
| `city` | string |
| `pincode` | string |
| `isActive` | boolean |

**Sample response**

```json
[
  {
    "id": "79e1ea9d-2484-4350-be9c-a32b85eb5d44",
    "name": "Babulnath",
    "code": "BBN",
    "city": "Mumbai",
    "isActive": true
  }
  // … 69 more
]
```

---

## Already available

Cover the rest of the form's dropdowns — nothing to build, listed here so
the whole form's data needs are in one place.

### GET /rider/pickup-slots

Query params: `?type&date`

Time windows for `slotId` — e.g. "9:00 AM – 12:00 PM". Pass `date` to drop
slots already past cutoff for today.

| Field | Type |
|---|---|
| `id` | uuid |
| `label` | string |
| `startTime` / `endTime` | `"HH:mm"` |
| `type` | `pickup` · `delivery` · `both` |

### GET /rider/customers/{customerId}/addresses

A customer's saved addresses, for `addressId`. Empty for a walk-in with
nothing saved yet — send free-text `address` on the pickup-request instead.

| Field | Type |
|---|---|
| `id` | uuid |
| `addressName` | string, optional |
| `addressLine1` / `city` / `state` | string, optional |
| `pincode` | string — only required field |
| `isDefault` | boolean |

### GET /rider/customers

Query params: `?search`

Name/phone search, for `customerId` — matches first name, last name, email
or phone. Empty query returns nothing; no result list to page through.

---

## Field → endpoint map

Every dropdown-backed field on `POST /rider/pickup-requests`, at a glance.

| Form field | Required | Source |
|---|---|---|
| `customerId` | **required** | `GET /rider/customers` |
| `addressId` | optional | `GET /rider/customers/{id}/addresses` |
| `slotId` | **required** | `GET /rider/pickup-slots` |
| `itemCategoryEstimate[].itemCategoryId` | **required** | `GET /rider/item-categories` |
| `itemCategoryEstimate[].serviceId` | optional | `GET /rider/services` |
| `storeId` | required if `pickupNow=false` | `GET /rider/stores` |

---

## Fixed-choice fields

Not master data — small enough to hardcode as static picker options, no GET
needed.

**`handoverBy`** — who hands the garments over
- `self` — no `handoverPersonName` needed
- `family_member` — name required
- `household_help` — name required

**`itemCategoryEstimate[].deliverySpeed`** — estimate only, not binding
- `standard`
- `express`
- `lightning`

**`deliveryGroupingPreference`** — estimate only, not binding
- `together` — deliver everything at once
- `as_ready` — deliver as-and-when-ready

**`pickup-slots ?type` filter** — query param, not a body field
- `pickup`
- `delivery`
- `both` — always included regardless of filter

---

## On errors

Every endpoint above throws the same shape as the rest of the API on
failure:

```json
{ "error": { "statusCode": 0, "name": "", "message": "" } }
```

A rider JWT without an active `Rider` record gets a **403**, not a 401 —
the token is valid, the account just isn't rider-registered or has been
deactivated.

---

*pressto_backend · rider-pickup.controller.ts · item-categories, services
and stores added for dropdown integration.*
