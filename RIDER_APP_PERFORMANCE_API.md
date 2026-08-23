# Rider App — Work Summary & Performance Integration Guide

For the rider app team. Covers the "Work Summary" and "Performance"
screens. Both in `rider-performance.controller.ts` — pure read/aggregate
views over data already tracked elsewhere (`PickupRequest`/`Delivery`/
`PaymentTransaction`/handover batches). Nothing new is recorded to support
these; there's no distance, time-worked, or rating data anywhere in this
system, so those aren't available.

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
