# Pickup — Changing the Processing Store

For the admin-panel and rider-app teams. Covers the "change which store a
pickup is processed at" ability: the single `PATCH` that moves it, exactly
when it's still allowed, what blocks it, and what it means for a rider who is
already on the pickup.

This is the admin/staff-driven *processing-store change*. It sits on top of
the earlier **store auto-assignment** work (nearest store by coordinates /
pincode at booking, and the suggested store on the booking form) — that
picks a store automatically; this lets a human override it afterwards.

---

## 1. The call

```
PATCH /pickup-requests/{id}
{ "storeId": "<new-store-uuid>" }
```

`storeId` is just one field on the normal pickup-update body — send it alone
to only move the store, or alongside other edits. The change is applied only
when the new `storeId` actually differs from the current one; otherwise it's
a no-op and skips every check below.

**Auth**: `super_admin` role + `pickup_request:update` permission (same as
every other pickup edit). A **store-scoped** caller may only move a pickup to
one of *their own* stores (see §3).

**Response `200`**: the updated `PickupRequest`.

---

## 2. When it's allowed — status window

The processing store can be changed only while the pickup is in one of these
statuses (`PROCESSING_STORE_CHANGEABLE_STATUSES` in
`pickup-request.controller.ts`):

| Status | Store changeable? |
|---|---|
| `requested` | ✅ |
| `scheduled` | ✅ |
| `rider_assigned` | ✅ (rider is notified-worthy — see §4) |
| `out_for_pickup` | ✅ |
| `arrived_at_pickup` | ✅ |
| `picked_up` | ✅ *unless a handover is pending* (§3) |
| `pickup_unsuccessful` | ✅ |
| `received_at_store` | ❌ bag is committed to the store |
| `not_serviceable` / terminal | ❌ |

The rule of thumb: **the store can move right up until the bag is committed
to a store.** Once the pickup is `received_at_store`, a home-pickup order
draft must match `pickup.storeId` (enforced on order submit), so the store is
frozen.

The admin panel mirrors this list as `STORE_CHANGEABLE_STATUSES` in
`store-dashboard-view.js` / `pickup-management-view.js`, so the "Change
processing store" action is only offered for changeable pickups — but the
server re-checks regardless.

---

## 3. What blocks the change (`assertProcessingStoreChangeable`)

Even inside the status window, the server rejects the change when:

| Cause | Status | Message |
|---|---|---|
| Pickup is past the window (received/terminal) | `400` | "The processing store cannot be changed once the pickup is {status}." |
| An order was already created from it (`convertedOrderId` / `convertedOrders`) | `400` | "The processing store cannot be changed after an order has been created from this pickup." |
| New store id not found | `404` | "Store not found." |
| Scoped caller moving it to a store they don't manage | `403` | "You can only move a pickup to a store you manage." |
| `picked_up` **and** a **pending** handover already names a destination store | `409` | "The rider has already started a handover for this pickup. Reject or complete that handover before changing the processing store." |

The handover check (last row) only runs for `picked_up` pickups: once the
rider has batched the bag into a *pending* `pickup_handover`, that handover
already points at a destination store, so the processing store can't be
re-pointed underneath it. Reject or confirm that handover first.

---

## 4. Rider implications

Changing the store is a back-office action, but it can change **where the
rider physically takes the bag**:

- **Before pickup** (`rider_assigned` → `arrived_at_pickup`): the rider's
  assigned run still points at the pickup; the destination store they'll
  hand the bag to is now the new store. The admin-panel dialog shows a
  warning in this case — *"The rider is already on this pickup. Let them know
  the bag now goes to the new store."* — because there's no automatic push to
  the rider app for an in-flight store change yet. **Tell the rider.**
- **After pickup** (`picked_up`, no handover yet): same — the bag in hand now
  belongs to the new store. Allowed, but coordinate with the rider.
- **Handover already started**: blocked (`409`) — see §3.

There is no rider-app endpoint to change the store; the rider only ever sees
the current `storeId` on their pickup. Keep that in mind when building
rider-side UI: the store can move out from under an assigned pickup, so read
it live rather than caching it at assignment time.

---

## 5. Admin-panel UI

`ChangeProcessingStoreDialog` (in `store-dashboard-view.js` and
`pickup-management-view.js`):

- Opened from the pickup's actions on the Pickup Management screen and the
  store dashboard, only for pickups in a changeable status.
- Shows the current store, then an autocomplete **"New processing store"**
  picker (searchable list of stores).
- Warns when a rider is already assigned (the §4 notice).
- **"Keep current store"** cancels; **"Change store"** submits the `PATCH`.
  The submit button is disabled until a *different* store is selected.

---

## 6. Related, earlier store-selection work

This override complements the automatic selection it overrides:

- **Nearest-store auto-assignment** — a pickup with no explicit `storeId` is
  assigned the nearest active store within `STORE_ASSIGNMENT_RADIUS_KM` when
  usable coordinates exist. Pincode coverage is used only without usable
  coordinates. See
  `RIDER_APP_PICKUP_API.md` §"Store auto-assignment" and the
  `/rider/customers/{id}/nearest-store` endpoint.
- **Suggested processing store on the booking form** — staff booking a pickup
  get a pre-selected processing store they can accept or change before the
  pickup is ever created.

Together: the system *picks* a sensible store up front, and this feature lets
staff *re-pick* it afterwards, safely, within the window above.
