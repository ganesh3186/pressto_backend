# Rider App — Work Summary, Performance & Dashboard Integration Guide

For the rider app team. Covers the "Work Summary", "Performance", and
"Dashboard" screens. All three in `rider-performance.controller.ts` — pure
read/aggregate views over data already tracked elsewhere (`PickupRequest`/
`Delivery`/`Transfer`/`PaymentTransaction`/handover batches). Nothing new
is recorded to support these; there's no distance, time-worked, or rating
data anywhere in this system, so those aren't available.

**Auth**: `Authorization: Bearer <jwt>` with the `rider` role, same as the
rest of the rider app.

**Dates**: both endpoints take `fromDate`/`toDate` as `YYYY-MM-DD`. Omit
either (or both) and it defaults to **today** — matches the app's own date
pickers, which start pre-filled to today. Range is capped at 366 days
(`400` beyond that); `fromDate` after `toDate` is also `400`.

---

## 1. Work Summary — one row per day

```
GET /rider/work-summary?fromDate=2026-08-01&toDate=2026-08-23&search=<optional>
```
`search` matches against each row's display date (`dd-mm-yyyy` or the raw
`yyyy-mm-dd`) — there's no customer/order-level text on a day-aggregate
row to search by, only the date itself.

**Response `200`**
```json
{
  "fromDate": "2026-08-01",
  "toDate": "2026-08-23",
  "days": [
    {
      "date": "2026-08-23",
      "pickupsCompleted": 3,
      "deliveriesCompleted": 2,
      "cashCollected": 1250,
      "cashHandoversSubmitted": 1,
      "pickupHandoversSubmitted": 0
    }
  ]
}
```
One entry per calendar day in range (including zero days), newest first.
- `pickupsCompleted` — this rider's own pickups with status `picked_up` or
  `received_at_store`, bucketed by `requestedDate`.
- `deliveriesCompleted` — deliveries with status `completed`, bucketed by
  `deliveryDate`.
- `cashCollected` — sum of cash/in-person `PaymentTransaction.amount` this
  rider personally collected that day (bucketed by `paymentDate`) —
  counted once, regardless of later handover status.
- `cashHandoversSubmitted` / `pickupHandoversSubmitted` — count of
  `RiderCashHandover` / `PickupHandover` batches this rider submitted that
  day (see `RIDER_APP_CASH_HANDOVER_API.md` / `RIDER_APP_PICKUP_HANDOVER_API.md`).

---

## 2. Performance — completion counts + rate

```
GET /rider/performance?type=pickup&fromDate=2026-08-01&toDate=2026-08-23
GET /rider/performance?type=delivery&fromDate=2026-08-01&toDate=2026-08-23
```
`type` is required — matches the screen's Pickup/Delivery tab toggle.

**Response `200`**
```json
{
  "type": "pickup",
  "fromDate": "2026-08-01",
  "toDate": "2026-08-23",
  "assigned": 42,
  "completed": 38,
  "cancelled": 2,
  "completionRate": 90.48
}
```
- `assigned` — everything assigned to this rider in range, any status
  (`requestedDate` for pickups, `deliveryDate` for deliveries).
- `completed` — pickups: `picked_up` or `received_at_store`; deliveries:
  `completed`.
- `cancelled` — status `cancelled` on either.
- `completionRate` — `completed / assigned * 100`, rounded to 2 decimals;
  `0` when `assigned` is `0` (not a divide-by-zero error).

---

## 3. Dashboard — single-date snapshot across every activity

```
GET /rider/dashboard?date=2026-08-24
```
`date` is `YYYY-MM-DD`, optional, defaults to **today**. Unlike the two
endpoints above this is a single day, not a range — built for a home-screen
"today" tile view, not a history/trend screen.

**Response `200`**
```json
{
  "date": "2026-08-24",
  "completedPickupsCount": 5,
  "pendingPickupsCount": 2,
  "completedDeliveriesCount": 8,
  "pendingDeliveriesCount": 3,
  "completedStoreTransfersCount": 1,
  "pendingStoreTransfersCount": 0,
  "handoverOrdersCount": 4,
  "handoverCashCount": 2
}
```
- **Pickups** — this rider's own `PickupRequest`s, bucketed by
  `requestedDate`. `completed` = `picked_up`/`received_at_store`; `pending`
  = `rider_assigned`/`out_for_pickup`/`arrived_at_pickup`/
  `pickup_unsuccessful`. `cancelled` pickups aren't counted in either
  bucket.
- **Deliveries** — this rider's own `Delivery` rows, bucketed by
  `deliveryDate`. `completed` = `completed`; `pending` = `assigned`/
  `out_for_delivery`. `cancelled` isn't counted in either bucket.
- **Store transfers** — `Transfer`s with `riderId` = this rider, bucketed
  by `riderAssignedAt` (the one transfer timestamp this rider actually
  authors — `receivedAt` is set by the destination store, not the rider).
  `completed` = `received`/`discrepancy`/`resolved`; `pending` =
  `rider_assigned`/`in_transit`.
- `handoverOrdersCount` — total pickup orders inside the rider's
  `PickupHandover` batches submitted that day, by `submittedAt`.
- `handoverCashCount` — total cash transactions inside the rider's
  `RiderCashHandover` batches submitted that day. These are item counts;
  the Work Summary fields above intentionally count submitted batches.
