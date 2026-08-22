# Rider App — Delivery Integration Guide

For the rider app team. The counterpart to `RIDER_APP_PICKUP_API.md` for the
opposite leg of the lifecycle: a finished order going from store → customer,
instead of raw items going customer → store. All in `rider-delivery.controller.ts`.

**Auth**: same as pickup — sign in via `POST /auth/rider/send-otp` →
`POST /auth/rider/verify-otp` (phone + OTP), returning a JWT whose role is
`rider`. Every endpoint below requires `Authorization: Bearer <jwt>` and is
gated purely by having the `rider` role — an inactive rider account gets a
`403` on every call ("This rider account is inactive").

---

## 1. Enums

```
DeliveryStatus: assigned → out_for_delivery → completed
                              ↘ cancelled (from assigned only)
```
A `Delivery` is one rider's bagged run of orders for delivery — created when
a store assigns orders for delivery with a bag attached (Dispatch Management's
"Assign rider" flow). It carries no per-order status of its own; whether an
order is actually delivered is always read live off that **order's** own
status (`ready`/`out_for_delivery`/`delivered`), never duplicated onto the
delivery record — so the two can't drift apart.

---

## 2. The rider's own assigned deliveries

```
GET /rider/deliveries?status=<optional>
```
Without `status`, returns only the active ones (`assigned` or
`out_for_delivery`) — the working list. Pass `status` explicitly (e.g.
`completed`) to see history instead. Ordered `assignedAt DESC`.

**Response `200`**
```json
{
  "deliveries": [
    {
      "id": "uuid",
      "deliveryNumber": "DL-STR1-2008-1",
      "status": "assigned",
      "storeId": "uuid",
      "riderId": "uuid",
      "riderName": "Rohan Sharma",
      "bagId": "uuid",
      "deliverySlot": "2:00 PM - 5:00 PM",
      "deliverySlotId": "uuid",
      "deliveryDate": "2026-08-20T12:00:00.000Z",
      "orderCount": 4,
      "assignedAt": "2026-08-20T09:12:00.000Z",
      "assignedBy": "uuid",
      "startedAt": null,
      "completedAt": null,
      "remarks": null
    }
  ]
}
```
`orderCount` is the manifest size — use it for a badge/count without a
separate call. Use §3 to get the actual orders in one.

---

## 3. Delivery detail — the orders on this run

```
GET /rider/deliveries/{id}
```
`403` ("This delivery is not assigned to you.") if the delivery belongs to
another rider.

**Response `200`**
```json
{
  "delivery": { "...same shape as §2's list entries..." },
  "orders": [
    {
      "id": "uuid",
      "deliveryId": "uuid",
      "orderId": "uuid",
      "orderNumber": "ORD-00001234",
      "customerName": "Priya Verma",
      "customerMobile": "9876543210",
      "balanceDueAtAssignment": 450,
      "status": "arrived",
      "arrivedAt": "2026-08-22T13:40:00.000Z",
      "orderStatus": "out_for_delivery",
      "deliveryAddress": "12, Sample Society, Andheri, Mumbai, Maharashtra, 400072",
      "itemCount": 6,
      "balanceDue": 450,
      "isOnAccount": false
    }
  ]
}
```
- `status`/`arrivedAt` are this order's own "reached" breadcrumb (§4a) —
  `status: "pending"` and `arrivedAt: null` until the rider calls §4a for
  this stop. Distinct from `orderStatus`, which is the order's real
  lifecycle state.
- `balanceDueAtAssignment` is a display snapshot taken when the rider was
  assigned — use it only as a fallback. **`balanceDue` is the live figure**
  (recomputed from the order right now) and is what §5's payment collection
  must actually match — always prefer it.
- `isOnAccount: true` means this customer has deferred billing — §5 skips
  payment collection entirely for that order, so don't prompt for cash/wallet
  on it.
- `deliveryAddress` is a frozen text snapshot taken when the order's delivery
  address was set — safe to display as-is, never changes underfoot.

---

## 4. Start the delivery run

```
PATCH /rider/deliveries/{id}/status
```
```json
{"status": "out_for_delivery"}
```
Riders may only ever set this one value here (`400` for anything else —
`"Riders can only set status to out_for_delivery."`). Must currently be
`assigned` (`400` naming the current status otherwise — call this once per
run, not per order). On success, every linked order that's `ready` or
`partially_dispatched` is moved to `out_for_delivery` server-side — the
rider app doesn't need to touch order status directly.

**Response `200`**: `{ "message": "Delivery started." }`

---

## 4a. Mark reached at one stop

```
PATCH /rider/deliveries/{id}/orders/{orderId}/status
```
```json
{"status": "arrived"}
```
Purely a "rider is physically at this stop now" breadcrumb, per order on
the manifest — a run can have several stops, each reached at a different
time. Does **not** touch `Order.status` and is **not required** before §5's
`deliver` call; skip it if the app doesn't need the breadcrumb. `400` for
any value other than `arrived`. `404` if `orderId` isn't on this delivery's
manifest. Calling it again on an already-`arrived` stop just re-confirms —
no error.

**Response `200`**: `{ "message": "Marked as reached." }`

The order's `status`/`arrivedAt` fields then appear on that order's entry
in §3's delivery-detail response.

---

## 5. Deliver one order + collect payment

```
POST /rider/deliveries/{id}/orders/{orderId}/deliver
```
```json
{
  "paymentMode": "cash",
  "amount": 450,
  "walletAmount": 0,
  "transactionReference": "optional — UPI/card ref if not cash",
  "remarks": "optional"
}
```
Call this once per order as the rider hands each one over — not once for
the whole run. The target order must currently be `out_for_delivery` (`400`
naming the current status otherwise — call §4 first).

- **On-account orders (`isOnAccount: true`)** skip payment entirely — send
  the body without payment fields, or omit the body. Deferred billing, same
  posture as order creation elsewhere in the system.
- **Every other order must arrive paid in full** — no partial handover.
  `amount + walletAmount` must cover the live `balanceDue` from §3
  (`400` — `"Full payment of ₹X is required at delivery for this order."` —
  if short). `paymentMode` defaults to `cash` when omitted but `amount` is
  sent.
- `walletAmount` is a separate deduction from the customer's Pressto wallet,
  on top of whatever `paymentMode` amount is collected in person — send both
  if the customer is paying with a mix.
- If `due <= 0` already (nothing owed), sending no payment fields at all is
  fine — the order still moves to `delivered`.

**Response `200`**
```json
{"message": "Order delivered.", "deliveryCompleted": false}
```
`deliveryCompleted: true` means this was the last order on the run — the
whole `Delivery` auto-completed and its bag was released, no separate
"finish run" call needed. Keep calling this endpoint for each remaining
order on the manifest until every one reports it's delivered (or was
already `returned`, which also counts toward completion).

**Error cases:**
| Status | Cause |
|---|---|
| `404` | Delivery not found, or this order isn't on this delivery's manifest |
| `403` | This delivery is not assigned to the calling rider |
| `400` | Order isn't `out_for_delivery` yet |
| `400` | Payment short of the live balance due (non-on-account order) |

---

## 6. Cash handover (collected payments → store or another rider)

Cash/UPI collected at the door piles up "with the rider" until submitted as
a batch — to a store, or to another rider/van for consolidation. Wallet
payments never appear here — only `paymentMode: cash` (and similar in-person
modes) from §5 create a handover-eligible transaction.

Full detail, including the "Handover To" picker and receiving cash from
another rider, has moved to its own doc:
**`RIDER_APP_CASH_HANDOVER_API.md`**.

---

## Typical flow, end to end

1. `GET /rider/deliveries` → see today's assigned runs.
2. `GET /rider/deliveries/{id}` → see the orders on this run, addresses, and live balance due for each.
3. `PATCH .../{id}/status {status: "out_for_delivery"}` → start the run; linked orders flip to `out_for_delivery` automatically.
4. At each stop (optional): `PATCH .../{id}/orders/{orderId}/status {status: "arrived"}` (§4a) the moment the rider reaches the address, then `POST .../{id}/orders/{orderId}/deliver` with payment details (skip payment fields for on-account orders) → order marked `delivered`.
5. When the last order's `deliver` call reports `deliveryCompleted: true`, the run and bag are already closed out — nothing further to call.
6. Periodically (or at shift end): submit collected cash for handover — see `RIDER_APP_CASH_HANDOVER_API.md`.

Everything here is immediately visible to the admin Dispatch Management /
Logistics screens (see `LOGISTICS_ADMIN_API.md`) under the same delivery.
