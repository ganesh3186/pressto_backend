# Rider App — Delivery Order Handover

For the combined cash and order handover guide, see
[`RIDER_APP_HANDOVER_API.md`](./RIDER_APP_HANDOVER_API.md).

This guide covers handing selected, unreached orders from one delivery rider
to another rider or Van Rider. The receiving rider must accept before delivery
assignment changes. Cash remains a separate handover; use
[`RIDER_APP_CASH_HANDOVER_API.md`](./RIDER_APP_CASH_HANDOVER_API.md) for
collected payment handover.

All endpoints require the rider JWT and an active rider account.

## 1. Find recipient riders

```http
GET /rider/handover-riders?type=rider|van-rider
```

Omit `type` to return both types. The current rider is excluded; inactive and
deleted riders are not returned.

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

## 2. Load eligible orders on a delivery

```http
GET /rider/delivery-handover-eligible?deliveryId={deliveryId}
```

The delivery must belong to the calling rider and be `assigned` or
`out_for_delivery`. Only current, undelivered stops that have not been reached
are returned. Orders already delivered, returned, reached, or in another
pending handover are not eligible.

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

An unstarted run can contain orders in `ready` or `partially_dispatched`
status. A started run can contain orders in `out_for_delivery` status.

## 3. Submit selected orders for handover

```http
POST /rider/delivery-handovers
```

```json
{
  "deliveryId": "delivery-uuid",
  "orderIds": ["order-uuid"],
  "handoverToRiderId": "recipient-rider-uuid",
  "remarks": "Optional handover note"
}
```

All IDs must refer to current eligible stops on the specified delivery. The
sender cannot select themselves as the recipient. The API reserves selected
stops as `handover_pending` so the sender cannot start, reach, deliver, or
return them while the recipient's decision is pending.

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

When the source delivery has a custody bag, all remaining orders on that run
must be included. This allows the bag to move with the complete order
handover, rather than being associated with two active runs.

## 4. Recipient inbox and acceptance

The sender can recover their submitted handovers with:

```http
GET /rider/delivery-handovers?tab=pending|completed
```

`pending` is the default. `completed` includes confirmed and cancelled
requests. Each row includes the selected order items and can be used to cancel
a still-pending handover.

```http
GET /rider/delivery-handovers/incoming?tab=pending|completed
```

`pending` is the default. The response is `{ "handovers": [...] }`; each
handover includes `items[]` with the order IDs, order numbers, and customer
names.

The recipient accepts a handover with:

```http
POST /rider/delivery-handovers/{handoverId}/confirm
```

No request body is required. Only the addressed rider can accept. On
acceptance, the API creates a new delivery run for the recipient, inheriting
the source store, scheduled date, and slot. The selected delivery stops and
order assignment move to that run. If the source run was already
`out_for_delivery`, the recipient's new run starts in that state; otherwise it
starts as `assigned`.

If all remaining orders leave the source run, it is marked `completed`. A
custody bag moves to the new run only when the handover includes every
remaining order from that bagged run.

**Response `200`**

```json
{
  "message": "Delivery order handover accepted.",
  "deliveryId": "recipient-delivery-uuid",
  "deliveryNumber": "DL-ST01-0611-Ha1b2c3d4",
  "orderIds": ["order-uuid"],
  "sourceDeliveryCompleted": true
}
```

## 5. Sender cancellation

While the handover is pending, the sending rider may cancel it:

```http
POST /rider/delivery-handovers/{handoverId}/cancel
```

No request body is required. The selected orders return to their previous
stop states. Only the sending rider can cancel, and a confirmed handover
cannot be cancelled.

## 6. Cash is separate

Order handover does not move cash transactions. Cash is handed over with the
existing `POST /rider/cash-handovers` API and its own recipient confirmation
flow. A rider may submit separate cash and order handovers to the same
recipient.
