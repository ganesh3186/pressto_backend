# Rider App — Delivery + Cash Handover Integration Guide

For the rider app team. Covers the opposite leg of the lifecycle from
`RIDER_APP_PICKUP_API.md`: a finished order going back out to the customer.
When admin assigns a bag + rider to one or more ready orders (Dispatch), a
`Delivery` is created — this is the "delivery request" the rider taps into,
single or multiple orders at once. At the door the rider collects any
remaining balance (cash or wallet), then later batches up collected cash
and hands it to the store. All new this pass (`rider-delivery.controller.ts`,
`rider-cash-handover.controller.ts` is the admin-side counterpart).

**Auth**: same as pickup — `Authorization: Bearer <jwt>` from the existing
rider OTP login, gated purely by the `rider` role. An inactive rider account
gets `403` ("This rider account is inactive") on every call below.

---

## 1. Enums

```
DeliveryStatus: assigned | out_for_delivery | completed | cancelled
RiderCashHandoverStatus: pending | confirmed
PaymentMode (relevant subset): cash | wallet
```

A `Delivery` never has an independent "is this done" flag beyond `status` —
completion is always derived from whether every order on it has reached
`delivered`/`returned`. There's no rider-settable status besides
`out_for_delivery` (§4); `completed`/`cancelled` are system/admin-driven.

---

## 2. The rider's own assigned deliveries

```
GET /rider/deliveries?status=<optional>
```
Without `status`, returns only the active ones (`assigned` or
`out_for_delivery`) — the working list, "delivery requests" waiting at the
store. Pass `status` explicitly (e.g. `completed`) to see history instead.
Ordered `assignedAt DESC`.

---

## 3. Delivery detail

```
GET /rider/deliveries/{id}
```
`403` ("This delivery is not assigned to you.") if it isn't the calling
rider's. Returns `{delivery, orders}` — `orders` is one entry per order on
the delivery (single order → array of 1; multiple → several), each enriched
at read time with live data so the app never has to make a second call per
order:

```json
{
  "orderId": "uuid",
  "orderNumber": "ORD0102",
  "customerName": "...",
  "customerMobile": "...",
  "orderStatus": "out_for_delivery",
  "deliveryAddress": "...",
  "itemCount": 4,
  "balanceDue": 350,
  "isOnAccount": false
}
```

**`isOnAccount: true`** means this order is on deferred B2B billing — the
app should skip the payment-collection UI for it entirely and go straight
to marking it delivered (§5 accepts no payment for these anyway).
**`balanceDue`** is the live, split-aware amount still owed (handles
partially-paid parent/child order splits correctly) — always use this over
any locally-cached total.

---

## 4. Start the delivery run

```
PATCH /rider/deliveries/{id}/status
```
```json
{"status": "out_for_delivery"}
```
Only legal call a rider can make here (`400` for anything else). Requires
`delivery.status === assigned` (`400` naming the current status otherwise).
Cascades every linked order still `ready`/`partially_dispatched` to
`out_for_delivery`. Call this once per delivery, before delivering any of
its orders — §5 rejects an order that isn't `out_for_delivery` yet.

---

## 5. Deliver an order + collect payment

```
POST /rider/deliveries/{id}/orders/{orderId}/deliver
```
```json
{
  "paymentMode": "cash",
  "amount": 350,
  "walletAmount": 0,
  "transactionReference": "optional — wallet/UPI ref",
  "remarks": "optional"
}
```
This is the write path behind the "Handover Cash" screen for a single
order. Requires `order.status === out_for_delivery` (`400` naming the
current status otherwise) and the order to actually belong to this delivery
(`404` — "This order is not on this delivery.").

### Payment rule

- **`order.isOnAccount === true`**: skip the payment body entirely — no
  amount is collected or required, the call goes straight to marking the
  order delivered.
- **Otherwise**: full balance is required at the door, **no partial
  handover accepted**. `amount + walletAmount` must cover the live
  `balanceDue` (§3) or the call fails:
  ```json
  {"error": {"message": "Full payment of ₹350 is required at delivery for this order."}}
  ```
  Split `amount` (cash) and `walletAmount` (wallet) however the customer
  actually pays — both settle in the same call. Wallet payments settle
  instantly; cash stays recorded against the rider (see §6) until they hand
  it to the store.

**Response `200`**:
```json
{"message": "Order delivered.", "deliveryCompleted": false}
```
`deliveryCompleted: true` once *every* order on this delivery has reached
`delivered`/`returned` — at that point the delivery itself flips to
`completed` and its bag is released server-side automatically. If you're
showing a multi-order delivery, keep calling this endpoint per order and
watch this flag to know when the whole run is done — no separate "complete
the delivery" call exists or is needed.

---

## 6. Cash handover — the "Handover Cash" screen

Every `cash` payment collected via §5 is tagged against the rider and
starts life as `with_rider`. It settles the order immediately either way —
this tracking is bookkeeping for getting the physical cash back to the
store, it never blocks or reverses the order.

### 6a. Pending items (not yet submitted)

```
GET /rider/cash-handovers/pending-items
```
**Response**: `{items: [{id, orderId, orderNumber, amount, paymentDate}]}`
— every `with_rider` cash collection, newest first. This is the
selectable list on the screen.

### 6b. Submit a batch

```
POST /rider/cash-handovers
```
```json
{"paymentTransactionIds": ["id1", "id2"], "remarks": "optional"}
```
Select several (or one) pending items and submit as one batch — matches
the screenshot's checkbox-select-then-submit flow. `400` if any id isn't
yours or isn't still `with_rider` (e.g. already submitted). On success,
every selected item moves `with_rider → submitted` and is locked into a new
`RiderCashHandover` batch (visible to the store on the admin Cash Received
→ Cash Pending screen). Submitting does **not** clear the item from your
own history (§6c) — it just changes its status.

**Response**: `{message: "Cash handover submitted.", handover: {...}}`

### 6c. Your handover history

```
GET /rider/cash-handovers?status=<optional>
```
`{handovers: [{..., items: [...]}]}` — your own batches, newest first,
each with its line items nested. Use this for the screen's "Completed" tab
(filter client-side on `status === 'confirmed'`, or pass
`?status=confirmed`) versus a submitted-but-not-yet-confirmed batch
(`status === 'pending'` — store hasn't confirmed receipt yet, see below).

**Store-side confirmation** (`POST /rider-cash-handovers/{id}/confirm`,
admin panel only, not a rider-app call) flips a batch's items to
`handed_over` once the store physically counts and accepts the cash — the
rider app has no action to take here, just reflect the status.

---

## Typical flow, end to end

1. `GET /rider/deliveries` → see today's delivery requests (single or
   multiple orders each).
2. Tap one → `GET /rider/deliveries/{id}` → see every order on it,
   `balanceDue`/`isOnAccount` per order.
3. `PATCH .../{id}/status {status: "out_for_delivery"}` → heading out.
4. At each stop: `POST .../orders/{orderId}/deliver` with the payment
   split (skip payment fields for on-account orders). Watch
   `deliveryCompleted` — once `true`, that delivery's bag is already
   released, nothing further to do for it.
5. Back at the store, periodically: `GET /rider/cash-handovers/pending-items`
   → select some/all → `POST /rider/cash-handovers` → wait for the store to
   confirm (reflected via `GET /rider/cash-handovers`).

Everything created here is immediately visible to admin under Logistics →
Dispatch (the delivery + its orders) and Invoices → Cash Received → Cash
Pending (handover batches, per-rider).
