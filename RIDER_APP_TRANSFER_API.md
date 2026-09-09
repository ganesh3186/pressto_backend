# Rider App — Inter-store Transfer Integration Guide

For the rider app team. Covers a bag of garments moving store → store
(not customer pickup/delivery — see `RIDER_APP_PICKUP_API.md` /
`RIDER_APP_DELIVERY_API.md` for those). All in
`rider-transfer.controller.ts`.

**Auth**: same as pickup/delivery — sign in via `POST /auth/rider/send-otp`
→ `POST /auth/rider/verify-otp` (phone + OTP), returning a JWT whose role is
`rider`. Every endpoint below requires `Authorization: Bearer <jwt>` and is
gated purely by having the `rider` role — an inactive rider account gets a
`403` on every call ("This rider account is inactive").

---

## 1. Lifecycle

```
sent → rider_assigned → in_transit → received
                                    ↘ discrepancy → resolved
```
A `Transfer` is created already `sent` from the source store (admin panel,
scan bag + scan items). An admin then assigns a rider
(`POST /transfers/{id}/assign-rider`, admin-side) — rider assignment is
mandatory, a transfer can no longer be received straight out of `sent`.
From there:

- The **rider's own leg** is just one action: mark yourself in transit (§3).
- The **destination store** does the actual receive/discrepancy check
  (`POST /transfers/{id}/receive`, admin-side) — there is no "delivered"
  action here, matching how the rider's job ends at handing over the bag,
  not verifying its contents.

`discrepancy` → `resolved` also happens store-side
(`POST /transfers/{id}/resolve-discrepancy`) — a rider never touches that
transition.

---

## 2. The rider's own assigned transfers

```
GET /rider/transfers?tab=pending|completed
GET /rider/transfers?status=<exact status>
```
Two ways to filter, `status` takes priority if both are sent (send only
one):

- `tab=pending` (**default** — same as sending nothing): the rider still
  has the bag — `rider_assigned` or `in_transit`.
- `tab=completed`: the destination store has already acted on it —
  `received`, `discrepancy`, or `resolved`. Either way the rider's own leg
  is done, regardless of whether the store's count matched.
- `status=<value>`: one exact status by name, if you need a narrower slice
  than a tab.

**Response `200`**
```json
{
  "transfers": [
    {
      "id": "uuid",
      "transitId": "TR-STR1-STR2-2008-4",
      "transferOrderNumber": "TO-202608-00014",
      "status": "rider_assigned",
      "fromStoreId": "uuid",
      "toStoreId": "uuid",
      "bagId": "uuid",
      "riderId": "uuid",
      "riderName": "Rohan Sharma",
      "riderAssignedAt": "2026-08-22T09:00:00.000Z",
      "itemCount": 12,
      "discrepancyCount": 0,
      "sentAt": "2026-08-22T08:45:00.000Z"
    }
  ]
}
```
`itemCount` is the manifest size — use it for a badge/count without a
separate call. Ordered `riderAssignedAt DESC`.

---

## 3. Transfer detail — the items in the bag

```
GET /rider/transfers/{id}
```
`{id}` accepts either the real uuid **or** the human-readable `transitId`
(e.g. `TR-STR1-STR2-2008-4`) — whichever the app has on hand, no need to
resolve one to the other client-side. `404` if not found, `403`
("This transfer is not assigned to you.") if it belongs to another rider.

**Response `200`**
```json
{
  "transfer": { "...same shape as §2's list entries..." },
  "items": [
    {
      "id": "uuid",
      "garmentId": "uuid",
      "garmentTagNumber": "TAG-000123",
      "orderId": "uuid",
      "scanStatus": "scanned"
    }
  ],
  "bags": [
    { "id": "uuid", "bagNumber": 1042 }
  ]
}
```
`scanStatus` starts `scanned` for every line (set when the source store
built the manifest); it only ever changes to `missing` — and only from the
**destination store's** receive step, never from the rider app.

`bags` is every bag belonging to this transfer, with its real `bagNumber`
— this is the checklist the rider scans against before calling §4. Match
each scan locally against this list and collect the `id`s; there's no
separate per-scan API call.

---

## 4. Mark yourself in transit

```
PATCH /rider/transfers/{id}/status
```
```json
{"status": "in_transit", "bagIds": ["uuid-of-bag-1", "uuid-of-bag-2"]}
```
`{id}` here must be the real path param the app already has from §2/§3 —
same dual uuid/transitId acceptance as §3. Riders may only ever set this one
value (`400` — `"Riders can only set status to in_transit."` — for
anything else). The transfer must currently be `rider_assigned` (`400`
naming the current status otherwise — this call is a one-time "I've picked
up the bag" action, not repeatable).

`bagIds` must cover **every** bag from §3's `bags[]` — scan each physical
bag and collect its `id` before calling this. Missing any of them fails
with `400` naming the still-unscanned bag number(s): `"Scan every bag in
this transfer before starting transit — still missing: 1042, 1043."`
Don't let the rider skip a bag; there is no partial/force option.

**Response `200`**: `{ "message": "Transfer marked in transit." }`

There's no separate "arrived" or "handed over" call — the destination
store's own `receive()` action is what closes out the rider's leg. Once
you've called this, just wait for the transfer to show up under
`tab=completed` (§2).

---

## Typical flow, end to end

1. `GET /rider/transfers?tab=pending` → see transfers currently assigned to you and awaiting pickup/in-transit.
2. `GET /rider/transfers/{id}` → confirm the bag's contents (item count, tag numbers) and get the list of bags to scan before leaving the source store.
3. Scan every bag in `bags[]`, then `PATCH /rider/transfers/{id}/status {status: "in_transit", bagIds: [...]}` → mark yourself on the road. Rejected until every bag is scanned.
4. Hand the bag to the destination store — no rider-app call for this; the store's own receive step (admin panel) closes it out.
5. `GET /rider/transfers?tab=completed` → confirm it moved to `received` (or check `discrepancy`/`resolved` if the store's count didn't match).

Everything here is immediately visible to the admin Interstore Transfer
screens (see `INTERSTORE_TRANSFER_API.md`) under the same transfer.
