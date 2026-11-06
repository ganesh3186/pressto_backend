# Rider App — Cash Handover Integration Guide

For the combined cash and order handover guide, see
[`RIDER_APP_HANDOVER_API.md`](./RIDER_APP_HANDOVER_API.md).

For the rider app team. Covers the "Handover Cash" screen end to end — all
in `rider-delivery.controller.ts` (submission + own history) and
`rider-cash-handover.controller.ts` (store-side confirm, admin panel only,
included here for completeness).

**Auth**: same as pickup/delivery — sign in via `POST /auth/rider/send-otp`
→ `POST /auth/rider/verify-otp` (phone + OTP), returning a JWT whose role is
`rider`. Every endpoint below requires `Authorization: Bearer <jwt>` and is
gated purely by having the `rider` role — an inactive rider account gets a
`403` on every call ("This rider account is inactive").

This doc replaces §6 of `RIDER_APP_DELIVERY_API.md`, which only covered the
store-only version of this flow before the "Handover To" picker existed.

---

## 1. Where the cash comes from

Cash collected at the door stays "with the rider" until submitted as a batch.
Wallet and non-cash payments never appear here — only `paymentMode: cash`
collected via `POST
/rider/deliveries/{id}/orders/{orderId}/deliver` (see
`RIDER_APP_DELIVERY_API.md` §5) create a handover-eligible
`PaymentTransaction`, tagged `riderHandoverStatus: 'with_rider'`.

```
GET /rider/cash-handovers/pending-items
```
Cash the calling rider currently holds for **delivered orders** and hasn't yet
submitted. A later full return does not make it ineligible. A payment remains
ineligible if its order was never delivered. The submission endpoint applies
the same rule.

**Response `200`**
```json
{
  "items": [
    {
      "id": "uuid",
      "orderId": "uuid",
      "orderNumber": "ORD-00001234",
      "amount": 450,
      "paymentDate": "2026-08-20T14:32:00.000Z"
    }
  ]
}
```
This is the source for the item-selection screen with the running total —
sum the `amount` of whatever the rider checks off, then pass their `id`s to
§2.

---

## 2. Who it's going to

The app's "Handover To" modal offers four options — they collapse onto two
underlying target types:

| App UI option | `handoverToType` | Target id field | Resolves against |
|---|---|---|---|
| Washing Facility | `store` | `handoverToStoreId` | `Store` (same picker as `GET /rider/stores`, see `RIDER_APP_PICKUP_API.md`) |
| Nearby Store | `store` | `handoverToStoreId` | `Store` — same field, Washing Facility and Nearby Store are not distinguished server-side; both are just a `Store` record |
| Van | `rider` | `handoverToRiderId` | `Rider` where `riderType: 'van-rider'` |
| Rider | `rider` | `handoverToRiderId` | `Rider` where `riderType: 'rider'` |

Use the shared rider target endpoint to populate either rider picker:

```
GET /rider/handover-riders?type=rider|van-rider
```

Omit `type` to return both types. The calling rider is excluded; inactive and
deleted riders are never returned.

**Response `200`**

```json
{
  "riders": [
    {
      "id": "uuid",
      "riderCode": "RID002",
      "name": "Ravi Kumar",
      "riderType": "rider"
    }
  ]
}
```

Use the selected rider's `id` as `handoverToRiderId` when submitting cash or
an order handover. `type` accepts only `rider` or `van-rider`; another value
returns `400`.

Sending `handoverToType: 'store'` without `handoverToStoreId` (or `'rider'`
without `handoverToRiderId`) is a `400`. Sending your own rider id as
`handoverToRiderId` is also a `400` ("Cannot hand cash over to yourself.").

---

## 3. Submit the handover

```
POST /rider/cash-handovers
```
```json
{
  "paymentTransactionIds": ["uuid-from-pending-items", "..."],
  "handoverToType": "store",
  "handoverToStoreId": "uuid-of-target-store",
  "remarks": "optional"
}
```
or, for a rider/van target:
```json
{
  "paymentTransactionIds": ["uuid-from-pending-items", "..."],
  "handoverToType": "rider",
  "handoverToRiderId": "uuid-of-target-rider",
  "remarks": "optional"
}
```
Bundles the listed pending items into one batch. `400` if any id isn't the
calling rider's own, or was already submitted. The API only accepts cash for
orders currently marked delivered or whose history shows they were delivered
before a later full return.

**Response `200`**
```json
{
  "message": "Cash handover submitted.",
  "handover": {
    "id": "uuid",
    "handoverNumber": "CH-RID001-2008-14",
    "status": "pending",
    "riderId": "uuid",
    "riderName": "Rohan Sharma",
    "riderCode": "RID001",
    "totalAmount": 1200,
    "itemCount": 3,
    "handoverToType": "store",
    "handoverToStoreId": "uuid",
    "handoverToRiderId": null,
    "handoverToName": "Andheri Store",
    "submittedAt": "2026-08-22T10:05:00.000Z",
    "submittedBy": "uuid",
    "remarks": null
  }
}
```
`handoverToName` is resolved and stored server-side (the target store's
name, or the target rider's `firstName lastName`) — never trust a
client-sent label. Each submitted transaction moves from
`with_rider` → `submitted`.

---

## 4. Your own handover history

```
GET /rider/cash-handovers?status=<optional>
```
The rider's own batches, each with its line items attached. `status` is
`pending` or `confirmed` — omit for everything.

**Response `200`**
```json
{
  "handovers": [
    {
      "id": "uuid",
      "handoverNumber": "CH-RID001-2008-14",
      "status": "confirmed",
      "totalAmount": 1200,
      "handoverToType": "store",
      "handoverToName": "Andheri Store",
      "confirmedAt": "2026-08-22T11:00:00.000Z",
      "items": [
        {"id": "uuid", "orderNumber": "ORD-00001234", "customerName": "Priya Verma", "amount": 450}
      ]
    }
  ]
}
```

---

## 5. Receiving cash handed to YOU by another rider

Only relevant if this rider is ever picked as a "Rider"/"Van" target by
someone else (§2). A store-targeted handover is confirmed by store staff on
the admin panel instead — it never appears in this section.

```
GET /rider/cash-handovers/incoming?tab=pending|completed
```
`pending` (default): batches directed at you, awaiting your confirmation.
`completed`: ones you've already confirmed. Same tab shape as
`GET /rider/pickup-requests?tab=`.

**Response `200`**: same shape as §4's list, one entry per handover.

```
POST /rider/cash-handovers/{id}/confirm
```
No body. `403` ("This handover was not directed to you.") if the handover
isn't targeted at the calling rider. `400` if it isn't `pending` anymore.
Use this when you already have the batch's `id` from §4's incoming list —
i.e. a tap-to-confirm from a list you're already looking at.

```
POST /rider/cash-handovers/confirm
{ "code": "482913" }
```
Same effect as the `{id}` route above, but resolves the batch by its
6-digit `handoverCode` instead — for confirming by **scanning the sender's
QR** cold, without the batch already being in front of you in the incoming
list. Same `403`/`400` behavior as above; `404` if no batch matches the
code. This is the route to use for an actual QR scan.

**Response `200`** (either route): `{ "message": "Cash handover confirmed received." }`

**Important — this is not a final settlement.** Confirming reassigns each
underlying `PaymentTransaction` to *you* (`riderId` + back to
`riderHandoverStatus: 'with_rider'`) rather than closing it out — you're a
new custodian, not the final destination, so the cash immediately reappears
in **your own** `GET /rider/cash-handovers/pending-items` (§1), ready to be
handed off again (to another rider, or eventually a store). Only a
store-targeted handover ever marks a transaction truly settled
(`handed_over`).

---

## Typical flow, end to end

**Handing cash to a store (most common):**
1. `GET /rider/cash-handovers/pending-items` → pick items, running total.
2. `POST /rider/cash-handovers` with `handoverToType: "store"` and the chosen `handoverToStoreId`.
3. Store staff confirm it later via the admin panel — nothing further for the rider app to do.

**Handing cash to another rider/van (e.g. mid-route consolidation):**
1. `GET /rider/cash-handovers/pending-items` → pick items.
2. `POST /rider/cash-handovers` with `handoverToType: "rider"` and the chosen `handoverToRiderId`.
3. The **receiving** rider either scans the sender's QR and calls `POST /rider/cash-handovers/confirm` with the scanned `code`, or — if they're already looking at their own `GET /rider/cash-handovers/incoming?tab=pending` list — taps the entry and calls `POST /rider/cash-handovers/{id}/confirm` instead.
4. The cash now shows up in the receiving rider's own `pending-items` (§1) — they carry it forward from here, eventually handing it to a store the same way.

Everything here is immediately visible to the admin "Cash Pending" screen
(see `LOGISTICS_ADMIN_API.md`) for store-targeted handovers.
