# Delivery — End-to-End API Sequence

For the rider app team. A pure call-sequence walkthrough — which API to
call after which, with real request/response shapes at each step. For the
full field-by-field reference, see `RIDER_APP_DELIVERY_API.md`.

Unlike pickup, there's only one starting point: a `Delivery` run is always
created by a store dispatching already-finished orders (Dispatch
Management's "Assign rider" flow, admin panel) — a rider never creates one
themselves.

All calls: `Authorization: Bearer <rider JWT>`.

---

## 1 — See today's assigned runs

```
GET /rider/deliveries?status=<optional>
```
Omit `status` for the working list (`assigned`/`out_for_delivery`).

**Response `200`**
```json
{
  "deliveries": [
    {
      "id": "uuid-delivery",
      "deliveryNumber": "DL-STR1-2008-1",
      "status": "assigned",
      "storeId": "uuid",
      "bagId": "uuid",
      "deliverySlot": "2:00 PM - 5:00 PM",
      "orderCount": 4,
      "assignedAt": "2026-08-25T09:12:00.000Z"
    }
  ]
}
```

## 2 — See the orders on this run

```
GET /rider/deliveries/{id}
```
**Response `200`**
```json
{
  "delivery": { "...same shape as step 1's entries..." },
  "orders": [
    {
      "id": "uuid-deliveryOrder",
      "orderId": "uuid-order",
      "orderNumber": "ORD-00001234",
      "customerId": "uuid-customer",
      "customerName": "Priya Verma",
      "customerMobile": "9876543210",
      "status": "pending",
      "arrivedAt": null,
      "orderStatus": "out_for_delivery",
      "deliveryAddress": "12, Sample Society, Andheri, Mumbai, 400072",
      "itemCount": 6,
      "balanceDue": 450,
      "isOnAccount": false
    }
  ]
}
```
`balanceDue` is the live figure — this is what step 5's payment must
match. `status`/`arrivedAt` here are this order's own "reached" state
(step 4), separate from `orderStatus` (the order's real lifecycle state).

## 3 — Start the run

```
PATCH /rider/deliveries/{id}/status
{"status": "out_for_delivery"}
```
**Response `200`**: `{"message": "Delivery started."}` — every linked
order that was `ready`/`partially_dispatched` is now `out_for_delivery`
server-side. Call this once for the whole run, not per order.

---

## Per stop, repeat steps 4–5 for each order on the manifest

## 4 — Mark reached (optional breadcrumb)

```
PATCH /rider/deliveries/{id}/orders/{orderId}/status
{"status": "arrived"}
```
**Response `200`**: `{"message": "Marked as reached."}` — doesn't touch
`Order.status`, not required before step 5, safe to skip if the app
doesn't need it.

## 5 — Fork: deliver, or mark it unsuccessful

**5a — Deliver + collect payment**
```
POST /rider/deliveries/{id}/orders/{orderId}/deliver
{
  "paymentMode": "cash",
  "amount": 450,
  "walletAmount": 0,
  "deliverTo": {"collectorType": "self"}
}
```
On-account orders (`isOnAccount: true` from step 2) send no payment
fields at all — deferred billing. `deliverTo` is optional; see
`RIDER_APP_DELIVERY_API.md` §5 for all 6 `collectorType` values
(`self`/`contact`/`family_member`/`other`/`guard`/`at_door` — the last two
need `photoMediaId` instead of a name).

**Response `200`**
```json
{"message": "Order delivered.", "deliveryCompleted": false}
```

**5b — Mark it unsuccessful instead**
```
POST /rider/deliveries/{id}/orders/{orderId}/delivery-unsuccessful
{"reasons": ["customer_not_answering"]}
```
**Response `200`**
```json
{"message": "Delivery marked unsuccessful — order returned to store.", "deliveryCompleted": false}
```
The order reverts to `ready` (`deliveryAttemptCount` incremented) —
someone redispatches it later, same as any other ready order. This
order's own leg on *this* run is done either way.

## 6 — Check `deliveryCompleted`

`true` on either 5a or 5b's response means this was the last unresolved
order on the manifest — the whole `Delivery` auto-completed and its bag
was released. Nothing further to call for this run; otherwise, go back to
step 4 for the next order on the manifest.

---

## 7 — Afterwards: hand over collected cash

Once cash/UPI has piled up from one or more stops (step 5a), submit it as
a batch — to a store, or to another rider/van. Full detail (including
receiving cash handed to *you* by another rider):
**`RIDER_APP_CASH_HANDOVER_API.md`**.

```
GET /rider/cash-handovers/pending-items
POST /rider/cash-handovers {"paymentTransactionIds": [...], "handoverToType": "store", "handoverToStoreId": "..."}
```
**Response `200`** (submit call)
```json
{"message": "Cash handover submitted.", "handover": {"id": "uuid", "handoverCode": "458697", "totalAmount": 450, ...}}
```
Store staff (or the receiving rider, if `handoverToType: "rider"`) resolve
`handoverCode` and confirm receipt from there — no further rider-app call
for *this* delivery run.
