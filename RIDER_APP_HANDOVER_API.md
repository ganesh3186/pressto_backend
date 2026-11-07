# Rider App — Cash and Delivery Order Handover API Reference

This guide covers two independent handover workflows:

1. **Cash handover** — transfer collected payment transactions to a store or
   another rider/Van Rider.
2. **Delivery order handover** — request to transfer selected undelivered
   customer orders to another rider/Van Rider. The recipient must accept
   before order assignment changes.

Cash and orders are separate operations. A cash transfer does not transfer an
order, and an order transfer does not transfer its cash transactions. Submit
and confirm each flow separately. Focused guides are available in
[`RIDER_APP_CASH_HANDOVER_API.md`](./RIDER_APP_CASH_HANDOVER_API.md) and
[`RIDER_APP_ORDER_HANDOVER_API.md`](./RIDER_APP_ORDER_HANDOVER_API.md).

## Authentication

Sign in through `POST /auth/rider/send-otp` and
`POST /auth/rider/verify-otp`. Send the returned rider JWT on every endpoint:

```http
Authorization: Bearer <rider-jwt>
```

The endpoints below require the `rider` role and an active rider account. The
backend resolves the sender from the authenticated JWT; do not send a sender
rider ID. An inactive rider account receives `403`.

All IDs in request bodies and paths are UUIDs unless otherwise shown. Send
JSON requests with `Content-Type: application/json`. `remarks` is optional.

## Shared recipient picker

Use this endpoint to find another rider or Van Rider for either handover:

```http
GET /rider/handover-riders?type=rider|van-rider
```

Omit `type` to return both rider types. The current rider, inactive riders,
and deleted riders are excluded. Other `type` values return `400`.

```json
{
  "riders": [
    {
      "id": "rider-uuid",
      "riderCode": "VAN001",
      "name": "Van Rider",
      "riderType": "van-rider"
    }
  ]
}
```

Use the selected `id` in `handoverToRiderId`. `riderType` is either `rider`
or `van-rider`; this same picker is used by cash and order handovers.

**Validation:** A type other than `rider` or `van-rider` returns `400`.
Inactive, deleted, and the calling rider are not returned. An empty `riders`
array means there is no eligible recipient of that type.

## Cash handover

### Find unsubmitted collected payments

```http
GET /rider/cash-handovers/pending-items
```

Returns the calling rider's cash transactions still marked `with_rider` for
orders that have been delivered. A later full return does not make that cash
ineligible. Cash for orders never delivered is excluded; submission enforces
the same rule.

```json
{
  "items": [
    {
      "id": "payment-transaction-uuid",
      "orderId": "order-uuid",
      "orderNumber": "ORD-1001",
      "amount": 450,
      "paymentDate": "2026-11-06T09:30:00.000Z",
      "store": {
        "id": "store-uuid",
        "name": "Example Store",
        "code": "ST01",
        "address": "Example address",
        "city": "Example City",
        "state": "Example State",
        "pincode": "400001",
        "phone": null
      }
    }
  ]
}
```

Wallet and non-cash payments are not included in this rider-held cash list.
An order must have reached `delivered`; a later full return does not make its
cash ineligible. Cash from orders never delivered, deleted orders, and
transactions no longer marked `with_rider` is omitted.

The `store` object is the store associated with the order, not necessarily
the rider's current location. It may be `null` if no store can be resolved.
Use the returned payment-transaction `id` when submitting the batch.

### Submit cash to a store or another rider

```http
POST /rider/cash-handovers
```

To hand cash to a store:

```json
{
  "paymentTransactionIds": ["payment-transaction-uuid"],
  "handoverToType": "store",
  "handoverToStoreId": "store-uuid",
  "remarks": "Optional note"
}
```

To hand cash to another rider or Van Rider:

```json
{
  "paymentTransactionIds": ["payment-transaction-uuid"],
  "handoverToType": "rider",
  "handoverToRiderId": "rider-uuid",
  "remarks": "Optional note"
}
```

Send one or more unique transaction IDs from the pending-items response.
Each transaction must belong to the calling rider and still be `with_rider`;
its order must be currently delivered or returned after a recorded delivery.
The API resolves and stores the target name; do not send a display name.

`handoverToType` is `store` or `rider`. For `store`, provide
`handoverToStoreId`; for `rider`, provide `handoverToRiderId`. The rider
target may be a normal rider or a Van Rider. The target must be active, not
deleted, and different from the sender.

**Successful response `200`:**

```json
{
  "message": "Cash handover submitted.",
  "handover": {
    "id": "handover-uuid",
    "handoverNumber": "CH-RID001-0611-14",
    "handoverCode": "482913",
    "status": "pending",
    "riderId": "sender-rider-uuid",
    "riderName": "Sender Name",
    "riderCode": "RID001",
    "totalAmount": 450,
    "itemCount": 1,
    "handoverToType": "rider",
    "handoverToStoreId": null,
    "handoverToRiderId": "recipient-rider-uuid",
    "handoverToName": "Recipient Name",
    "submittedAt": "2026-11-06T09:30:00.000Z",
    "submittedBy": "user-uuid",
    "remarks": null
  }
}
```

`handoverCode` is the six-digit code the recipient can scan or enter. On
submission, transactions move from `with_rider` to `submitted`; they are not
available for another batch while this handover is pending.

**Common errors:** `400` for invalid target details, self-handover, or
transactions that are not owned by the sender / no longer `with_rider`;
`404` if a transaction or target cannot be found; `409` if one or more orders
were never delivered or were deleted.

### Rider cash inbox and receipt confirmation

The sending rider can read their own submitted batches:

```http
GET /rider/cash-handovers?status=pending|confirmed
```

Omit `status` to return all of the sending rider's batches. The response is
`{ "handovers": [...] }`; each handover includes `items[]`. Results are sorted
newest submitted first. Use `pending` for batches awaiting recipient
confirmation and `confirmed` for completed batches.

The recipient rider can read incoming batches:

```http
GET /rider/cash-handovers/incoming?tab=pending|completed
```

`pending` is the default; `completed` returns confirmed incoming batches.
The response is `{ "handovers": [...] }`; each batch includes `items[]`.
Only rider-targeted handovers to the caller appear here. Store-targeted
batches are confirmed by store staff, not by a rider.

To confirm from the inbox:

```http
POST /rider/cash-handovers/{id}/confirm
```

No body is required. To confirm by scanning or entering the sender's
six-digit handover code:

```http
POST /rider/cash-handovers/confirm
Content-Type: application/json

{"code": "482913"}
```

The ID endpoint takes no body; the code endpoint takes `{"code":"482913"}`.
Only the addressed recipient can confirm, and both routes have the same
effect. Success returns:

```json
{"message": "Cash handover confirmed received."}
```

On recipient confirmation, transactions are assigned to the receiving rider
and reset to `with_rider`, so they appear in that rider's pending cash list
for a later transfer. This is custody transfer only; it does not settle the
cash. Store confirmation is a separate admin operation that marks the
transactions handed over.

**Common errors:** `404` if the handover/code does not exist; `403` if the
caller is not the addressed recipient; `400` if the batch is no longer
pending. Do not treat submission as acceptance; wait for recipient
confirmation.

## Delivery order handover

### Find eligible stops

```http
GET /rider/delivery-handover-eligible?deliveryId={deliveryId}
```

The delivery must be an active run (`assigned` or `out_for_delivery`) owned by
the calling rider. Provide the delivery UUID as `deliveryId`. Results contain
current stops that have not been reached or reserved. On an assigned run, the
order must be `ready` or `partially_dispatched`; on a started run, it must be
`out_for_delivery`. Reached, delivered, returned, stale, deleted-order, and
already-reserved stops are excluded.

```json
{
  "delivery": {
    "id": "delivery-uuid",
    "deliveryNumber": "DL-ST01-0611-1",
    "status": "assigned"
  },
  "orders": [
    {
      "id": "order-uuid",
      "deliveryOrderId": "delivery-order-uuid",
      "orderNumber": "ORD-1001",
      "customerName": "Customer Name",
      "status": "ready"
    }
  ]
}
```

`orders[].id` is the customer order ID used in the submit body;
`deliveryOrderId` identifies the delivery stop. They are different IDs. An
empty `orders` array means no stop is currently eligible.

**Common errors:** `400` if `deliveryId` is missing or the run is not active;
`403` if the run belongs to another rider; `404` if the delivery does not
exist.

### Submit selected orders

```http
POST /rider/delivery-handovers
```

```json
{
  "deliveryId": "delivery-uuid",
  "orderIds": ["order-uuid"],
  "handoverToRiderId": "recipient-rider-uuid",
  "remarks": "Optional note"
}
```

The sender must own the active delivery, select one or more unique customer
order IDs from that delivery, and choose a different active rider or Van
Rider. Do not pass stop IDs in `orderIds`. The API revalidates the run,
recipient, order status, stop eligibility, and current assignment at
submission time; the eligible-orders response is not a reservation.

On successful submission, the API atomically creates a pending handover and
its item rows, then reserves each selected stop as `handover_pending`. While
reserved, the sender cannot start the run or reach, deliver, or return those
orders. The selected orders remain assigned to the sender until acceptance.

```json
{
  "message": "Order handover submitted for recipient acceptance.",
  "handover": {
    "id": "handover-uuid",
    "deliveryId": "delivery-uuid",
    "riderId": "sender-rider-uuid",
    "handoverToRiderId": "recipient-rider-uuid",
    "itemCount": 1,
    "status": "pending"
  }
}
```

If the source run has a custody bag, every remaining open order must be
included in one handover; partial bagged-run transfers are rejected. Reached
orders cannot be selected, so a bagged run with a reached-but-undelivered
stop cannot currently be handed over through this endpoint.

**Common errors:** `400` for duplicate/empty order IDs, a stop that is not
current and eligible, a reached/closed/reserved stop, or an incomplete
bagged-run selection; `403` if the source delivery belongs to another rider;
`404` for a missing delivery, order, or recipient; `409` if an order's
status or eligibility changed before submission.

### Review outgoing and incoming requests

The sending rider can list their outgoing requests:

```http
GET /rider/delivery-handovers?tab=pending|completed
```

`pending` is the default. `completed` includes confirmed and cancelled
outgoing requests. The response is `{ "handovers": [...] }`; each handover
includes `items[]`. Items contain `orderId`, `orderNumber`, `customerName`,
`deliveryOrderId`, and the saved `previousStopStatus`.

The receiving rider can list their incoming requests:

```http
GET /rider/delivery-handovers/incoming?tab=pending|completed
```

`pending` is the default; `completed` returns confirmed incoming requests.
The response is `{ "handovers": [...] }`; each handover includes its order
items. Tabs accept only `pending` or `completed`; another value returns `400`.

### Accept a handover

Only the addressed recipient can accept:

```http
POST /rider/delivery-handovers/{id}/confirm
```

No body is required. Only the addressed recipient can accept. The API locks
the handover and selected orders, then rechecks that the handover is pending,
the source run is active, the stops are reserved, and the orders remain
assigned to the sender with eligible statuses.

On success, the API creates a **new delivery run** for the recipient,
inheriting the source store, scheduled date, and slot, then moves the selected
stops and order assignment to that run. It does not merge them into another
existing run. If the source run was already `out_for_delivery`, the new run
also starts in that state; otherwise it is `assigned`.

When no orders remain on the source run, it is marked `completed`. A custody
bag moves to the new run only when the handover includes every remaining
order from that bagged run.

```json
{
  "message": "Delivery order handover accepted.",
  "deliveryId": "recipient-delivery-uuid",
  "deliveryNumber": "DL-ST01-0611-Ha1b2c3d4",
  "orderIds": ["order-uuid"],
  "sourceDeliveryCompleted": true
}
```

`deliveryId` in the response is the new recipient delivery ID; use it for the
recipient's subsequent delivery operations. `sourceDeliveryCompleted` is
`true` only when no current open stops remain on the sender's source run.

**Common errors:** `403` if the caller is not the named recipient; `404` if
the handover does not exist; `400` if it is no longer pending; `409` if the
source run, order assignments, selected stops, or order statuses changed, or
if a bagged run would be split. A failed acceptance is rolled back; refresh
the inbox before retrying.

### Cancel a pending handover

The sending rider can cancel a pending request:

```http
POST /rider/delivery-handovers/{id}/cancel
```

No body is required. Only the sending rider can cancel a still-pending
request. The API restores selected stops to their saved previous states and
marks the handover `cancelled`; confirmed requests cannot be cancelled.
There is no recipient-decline endpoint; the sender may cancel a request that
remains pending.

**Common errors:** `403` if the caller is not the sender; `404` if the
handover does not exist; `400` if it is no longer pending.

## End-to-end flows

**Cash to another rider/van**

1. Select the recipient from `GET /rider/handover-riders`.
2. Load cash from `GET /rider/cash-handovers/pending-items`.
3. Submit the selected transaction IDs to `POST /rider/cash-handovers` with
   `handoverToType: "rider"` and `handoverToRiderId`.
4. The recipient reviews `GET /rider/cash-handovers/incoming` and confirms by
   handover ID or the six-digit code.
5. The received cash appears in the recipient's pending cash items.

**Orders to another rider/van**

1. Select the recipient from `GET /rider/handover-riders`.
2. Load eligible orders for a delivery with
   `GET /rider/delivery-handover-eligible`.
3. Submit selected order IDs to `POST /rider/delivery-handovers`.
4. The recipient reviews `GET /rider/delivery-handovers/incoming` and accepts
   with `POST /rider/delivery-handovers/{id}/confirm`.
5. The accepted orders appear on the recipient's newly created delivery run.

## Status reference and integration checklist

| Workflow stage | Cash batch | Order batch / stop |
|---|---|---|
| Before submission | Transaction `with_rider` | Stop `pending` or `out_for_delivery` |
| Submitted | Batch `pending`; transaction `submitted` | Handover `pending`; stop `handover_pending` |
| Recipient confirms | Batch `confirmed`; transaction owner becomes recipient and status returns to `with_rider` | Handover `confirmed`; stop and order assignment move to recipient's new run |
| Sender cancels | No rider cancellation endpoint | Handover `cancelled`; stop restored to saved status |

Implementation notes:

- Cash and order handovers are separate API requests, even if they share the
  same sender and recipient.
- Cash is selected by payment-transaction ID. Orders are selected by customer
  order ID and require the source delivery ID.
- A successful submit response means **pending recipient acceptance**, not a
  completed transfer. Update the UI after the recipient confirms.
- Cash sent to a store uses a separate store/admin confirmation path. Rider
  inbox and rider-confirm endpoints are only for rider-targeted cash batches.
- Order transfers always create a new delivery run for the recipient; they
  are not merged into an existing run.
