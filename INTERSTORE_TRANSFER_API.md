# Interstore Transfer — Frontend Integration Guide

Backend for the M2 Interstore Transfer screens (Transfer Out, Receive, All
Transfers, Transit Details, Item Tracking, Custody/Trail). All endpoints live
in `transfer.controller.ts` on the `pressto_backend` **`main`** branch.

All routes require `Authorization: Bearer <jwt>` and are gated by one of
these permissions (same pattern as the rest of the app — a 403 means the
logged-in role isn't granted it):

| Permission | Who has it | Gates |
|---|---|---|
| `transfer:create` | `manager`, `store_exec` | Create, Receive, Return-batch |
| `transfer:read` | `manager`, `store_exec` | List, Detail, Stats, Item tracking, Custody trail |
| `transfer:update` | `manager` only | Resolve-discrepancy |

`store_exec` is store-scoped — every list/read endpoint below is
automatically filtered to stores that user has access to (`storeScope`),
so no `storeId` filter needs to be forced from the frontend for a scoped
user; it's a courtesy filter for `manager`/`super_admin` browsing across
stores.

---

## 1. Enums

**`TransferStatus`**
```
sent | received | discrepancy | resolved
```
Transitions: `sent → received | discrepancy`, `discrepancy → resolved`.
`received` and `resolved` are both terminal — `resolved` specifically means
"was discrepant, now closed out," so don't collapse it into `received` in
the UI; show it as its own state (e.g. a distinct badge/color).

**`TransferItemScanStatus`** (per garment, on one transfer's manifest)
```
scanned | received | missing | extra
```
`scanned` = on the manifest, in flight. `received`/`missing` = set at
receive time. `extra` = a garment that showed up at receive but wasn't on
the original manifest (via `extraGarmentTagNumbers`).

**`TransferCustodyEventType`** (audit trail entries)
```
bag_scanned | items_mapped | sent_out | received | discrepancy | bag_released | discrepancy_resolved
```

**`BagStatus`**
```
available | in_use | full
```

---

## 2. Bag fields (existing `Bag` model, extended)

The bag picker on Transfer Out / Return Batch should call the existing
`GET /bags` and filter/display using these fields (added this pass):

| Field | Meaning |
|---|---|
| `status` | `available` (pickable) / `in_use` / `full` (not pickable — show why) |
| `maxCapacity` | Default 25. Client should stop letting the user add more scanned garments than this once a bag is picked (server also enforces it — `400`) |
| `itemCount` | Current garment count if `in_use`/`full` |
| `currentStoreId` | Denormalized display only — not authoritative, don't build logic on it |
| `currentTransferId` | The open `Transfer` this bag is locked to, `null` when `available` |

A bag only becomes `available` again on a **clean** receive or a
resolve-discrepancy — see §7.

---

## 3. Create + Send a Transfer

```
POST /transfers
```

**Body — single bag** (unchanged, still works exactly as before):
```json
{
  "fromStoreId": "uuid",
  "toStoreId": "uuid",
  "bagId": "uuid",
  "garmentIds": ["uuid", "..."],
  "reason": "optional string",
  "remarks": "optional string"
}
```

**Body — multiple bags** (new): send `bags[]` instead of `bagId`, one entry
per bag with that bag's own `garmentIds`. `garmentIds` at the top level is
still required — send the flat union of every bag's items.
```json
{
  "fromStoreId": "uuid",
  "toStoreId": "uuid",
  "bags": [
    { "bagId": "uuid-bag-1", "garmentIds": ["uuid", "uuid"] },
    { "bagId": "uuid-bag-2", "garmentIds": ["uuid", "uuid", "uuid"] }
  ],
  "garmentIds": ["uuid", "uuid", "uuid", "uuid", "uuid"],
  "reason": "optional string",
  "remarks": "optional string"
}
```
An item may only appear under one bag — `400` if the same `garmentId`
shows up in more than one bag's `garmentIds`. If both `bagId` and `bags`
are omitted, `400`.

**Response `200`**
```json
{
  "message": "Transfer created and sent.",
  "transfer": {
    "...Transfer row, see §8...",
    "bagId": "uuid-bag-1",
    "bags": [
      { "bagId": "uuid-bag-1", "bagNumber": 1, "itemCount": 2 },
      { "bagId": "uuid-bag-2", "bagNumber": 2, "itemCount": 3 }
    ]
  },
  "items": [ { "...TransferItem row, now including bagId..." } ]
}
```
`transfer.bagId` is always the *first* bag — kept so anything reading the
old single-bag field still works. `transfer.bags` is the real breakdown;
use it for anything bag-count-aware (chips, "N bags" labels, per-bag item
lists).

Atomic — there is no draft state. One call scans-and-sends: server
generates `transitId` (`TR-{fromCode}-{toCode}-{ddMM}-{seq}`) and
`transferOrderNumber` (`TO-{yyyyMM}-{00001}`), creates the manifest (each
`TransferItem` tagged with which bag it's in), writes one `bag_scanned`
custody event **per bag** plus one `items_mapped` and one `sent_out` for
the whole transfer, and locks every bag involved (`in_use` or `full` if
that bag's own item count `>= maxCapacity`) — each bag's capacity is
checked independently.

**Error cases to handle in the UI:**
| Status | Cause | Suggested UI |
|---|---|---|
| `400` | `fromStoreId === toStoreId` | "From and To store must differ" |
| `404` | store or garment not found | shouldn't happen from a proper picker, but handle |
| `400` | bag inactive | "This bag is inactive" |
| `409` | bag already `in_use`/`full` | disable the bag in the picker (see §2), show conflict toast if a race occurs |
| `400` | a bag's `garmentIds.length > bag.maxCapacity` | client should already cap this per bag before submit |
| `400` | same garment assigned to two bags | "An item cannot be assigned to more than one bag" |
| `409` | garment already in an active transfer | "Already in an active transfer: GT0001, GT0002" — dedupe scan input against this |

---

## 4. Receive a Transfer

```
POST /transfers/{id}/receive
```

**Body**
```json
{
  "receivedGarmentIds": ["uuid", "..."],
  "extraGarmentTagNumbers": ["GT00000099"],
  "remarks": "optional string"
}
```
- `receivedGarmentIds`: which of the *manifest's* garments were actually
  scanned in at the destination. Anything on the manifest not in this list
  is marked `missing`.
- `extraGarmentTagNumbers` (optional): tags scanned that weren't on the
  manifest at all — becomes a new `extra` item on this transfer. An
  unresolvable tag (doesn't match any real garment) is **not** a hard
  failure — it comes back in `warnings` and everything else still commits.

**Response `200`**
```json
{
  "message": "Transfer received.",
  "transfer": { "...status is now 'received' or 'discrepancy'..." },
  "reconciliation": { "received": 2, "missing": 0, "extra": 0 },
  "warnings": ["\"NOT-A-REAL-TAG\" does not match any known garment — skipped."]
}
```

- Clean receive (`missing === 0 && extra === 0`) → `status: received`,
  every bag this transfer used (one or many) is released back to
  `available` immediately.
- Anything missing or extra → `status: discrepancy`, **all of this
  transfer's bags stay locked** until a manager resolves it (§6). Show this
  clearly — the frontend's "Assign driver"/bag-reuse flow should treat a
  `discrepancy` transfer's bags as unavailable, same as the backend does.

Receipt is still all-or-nothing for the whole manifest regardless of which
bag each item came from — there's no per-bag receive step; scan everything
in, across every bag, then confirm once.

Only callable while `status === sent`; only by someone scoped to the
`toStoreId`. `400` if already received/discrepancy/resolved.

---

## 5. Return-Batch (send part of a shipment back)

```
POST /transfers/{id}/return-batch
```
`{id}` = the **original** transfer (the one whose items are being sent back).

**Body**
```json
{
  "bagId": "uuid",
  "garmentIds": ["uuid", "..."],
  "reason": "optional string",
  "remarks": "optional string"
}
```
No `fromStoreId`/`toStoreId` — the server infers the reverse leg
automatically: `fromStoreId = original.toStoreId`, `toStoreId =
original.fromStoreId`.

**Response `200`** — identical shape to Create (§3); the returned
`transfer.returnOfTransferId` will equal the original transfer's `id`.

**Preconditions (all server-enforced, surface as toasts):**
- Original transfer must be `received` or `resolved` — `400` otherwise
  ("Cannot return items from a transfer that is still sent").
- Caller must be scoped to the original's `toStoreId` (they're the one
  physically holding the goods right now).
- Every `garmentId` must have been on the original manifest **and**
  currently `received` there — `400` listing any that aren't.
- A garment already sent back in an earlier return-batch for this same
  original transfer is blocked — `409 Conflict`, "Already covered by an
  earlier return batch: GT0001".
- Same bag-availability/capacity checks as Create.

This is a fully normal `Transfer` under the hood — it goes through Receive
(§4), Resolve-discrepancy (§6), everything, in the reverse direction. The
only special thing about it is the `returnOfTransferId` tag.

**On the original transfer's detail view**, fetch it via `GET
/transfers/{id}` (§8) — the response now includes a `returnBatches` array
so Transit Details can render real chained return shipments instead of the
old hardcoded demo data.

---

## 6. Resolve a Discrepancy (manager-only)

```
POST /transfers/{id}/resolve-discrepancy
```
Requires `transfer:update` — gate this action in the UI to manager role
only (a `403` will come back for anyone else, but hide the button too).

**Body**
```json
{
  "foundGarmentIds": ["uuid", "..."],
  "remarks": "required string — why/what was resolved"
}
```
`foundGarmentIds` (optional): any garments previously `missing` on this
transfer that have since turned up — they flip to `received`. Omit/empty if
nothing was found and the missing items are being written off as-is.

**Response `200`**
```json
{
  "message": "Discrepancy resolved. Bag released.",
  "transfer": { "...status is now 'resolved'..." },
  "itemsFound": 1,
  "remainingDiscrepancies": 1
}
```
Only callable while `status === discrepancy`. `remarks` is required
(`400` if blank). Frees the bag back to `available` regardless of whether
anything was found — this is the **only** way a discrepant transfer's bag
gets unlocked.

---

## 7. List Transfers

```
GET /transfers?direction=&status=&storeId=&dateFrom=&dateTo=
```
All query params optional.
- `direction`: `outgoing` | `incoming` — filters by the caller's scoped
  store(s) being the `from` or `to` side. Omit for "all involving my
  store(s)".
- `status`: any `TransferStatus` value.
- `storeId`: narrow further to one specific store (must be within the
  caller's scope; ignored/no-op for a store outside it).
- `dateFrom` / `dateTo`: ISO date strings, filters on `createdAt`.

**Response `200`**
```json
{ "transfers": [ { "...enriched Transfer row, see §8..." } ] }
```
Ordered `createdAt DESC`.

---

## 8. Transfer Detail

```
GET /transfers/{id}
```

**Response `200`**
```json
{
  "transfer": {
    "id": "uuid",
    "transitId": "TR-ST113-ST002-1008-1",
    "transferOrderNumber": "TO-202608-00001",
    "status": "sent",
    "fromStoreId": "uuid", "fromStoreName": "Babulnath", "fromStoreCode": "ST113",
    "toStoreId": "uuid",   "toStoreName": "Bandra",     "toStoreCode": "ST002",
    "bagId": "uuid", "bagNumber": 1,
    "bags": [
      { "bagId": "uuid", "bagNumber": 1, "itemCount": 2 }
    ],
    "reason": null, "remarks": null,
    "sentAt": "2026-08-10T10:00:00.000Z", "sentBy": "uuid",
    "receivedAt": null, "receivedBy": null,
    "itemCount": 2, "discrepancyCount": 0,
    "resolvedAt": null, "resolvedBy": null,
    "returnOfTransferId": null,
    "isDeleted": false, "createdAt": "...", "updatedAt": "..."
  },
  "items": [
    {
      "id": "uuid", "transferId": "uuid", "garmentId": "uuid",
      "garmentTagNumber": "GT00000033", "orderId": "uuid",
      "orderNumber": "ORD000123",
      "bagId": "uuid",
      "scanStatus": "scanned",
      "createdAt": "...", "updatedAt": "..."
    }
  ],
  "custodyEvents": [
    { "id": "uuid", "transferId": "uuid", "eventType": "bag_scanned", "bagId": "uuid", "performedBy": "uuid", "performedAt": "..." },
    { "id": "uuid", "transferId": "uuid", "eventType": "items_mapped", "performedBy": "uuid", "performedAt": "..." },
    { "id": "uuid", "transferId": "uuid", "eventType": "sent_out", "performedBy": "uuid", "performedAt": "..." }
  ],
  "returnBatches": [
    { "...enriched Transfer row for each return-batch chained off this one, newest first..." }
  ]
}
```
`custodyEvents` is ascending (`performedAt ASC`) — read top-to-bottom as a
timeline. `returnBatches` is descending (`createdAt DESC`) and will be `[]`
for any transfer that hasn't had anything returned against it yet (which is
all of them until `status` reaches `received`/`resolved`).

`404` (not `403`) if the transfer doesn't exist or the caller isn't scoped
to either store on it.

---

## 9. Summary Stats (All Transfers screen cards)

```
GET /transfers/stats
```
No params — automatically store-scoped the same way as List.

**Response `200`**
```json
{
  "stats": {
    "total": 12,
    "sent": 3,
    "received": 7,
    "discrepancy": 1,
    "resolved": 1,
    "sentToday": 2,
    "receivedToday": 4
  }
}
```
Replace the frontend's hardcoded stat cards with these. **There is no
"overdue"/"nearing deadline" count** — no SLA/TAT rule exists anywhere in
the system yet to define what "overdue" means, so that card should either
be removed for now or left out until a follow-up defines the business rule.

---

## 10. Item Tracking

```
GET /transfers/item/{garmentTag}
```
Looks up a garment by its tag number (e.g. `GT00000033`) and returns its
most recent transfer activity — useful for a lost-item / "where is this
garment right now" search.

**Response `200` (found)**
```json
{
  "tracked": true,
  "garmentTagNumber": "GT00000033",
  "currentStage": "scanned",
  "currentTransfer": { "...full Transfer row..." },
  "bag": { "...Bag row..." },
  "fromStore": { "...Store row..." },
  "toStore": { "...Store row..." },
  "orderId": "uuid",
  "orderNumber": "ORD000123"
}
```
**Response `200` (not found)**
```json
{ "tracked": false }
```
This is a **valid** response, not an error — render an empty/"no record"
state, don't treat it as a failure.

---

## 11. Custody / Trail Report

```
GET /transfer-custody-events?garmentTag=&transferId=&storeId=&dateFrom=&dateTo=
```
All params optional; combine freely.
- `garmentTag`: pulls in both that garment's own manifest-level history and
  the transfer-level events (`sent_out`/`received`/`bag_released`/etc.) for
  whichever transfer(s) it appears on — so a tag search shows the full
  story, not just item-level rows (there currently are no item-level event
  rows — `garmentTagNumber` on the event model is reserved for future use).
- `transferId`: restrict to one transfer's trail (same data as `detail`'s
  `custodyEvents`, but as a standalone endpoint for the trail/report view).
- `storeId` / `dateFrom` / `dateTo`: same filtering semantics as List.

**Response `200`**
```json
{ "events": [ { "...TransferCustodyEvent row...", "bagId": "uuid", "bagNumber": 2 } ] }
```
Ordered `performedAt DESC` (newest first — this is a trail/report view,
unlike the ascending order in the Detail endpoint's `custodyEvents`).
`bagId`/`bagNumber` are only set on the two bag-level event types
(`bag_scanned`, `bag_released`) — on a multi-bag transfer there's one of
each per bag. Every other event type (`items_mapped`/`sent_out`/
`received`/`discrepancy`/`discrepancy_resolved`) is whole-transfer and has
neither.

---

## Not implemented this pass

- **Driver/van assignment** — "Assign driver" should stay a frontend no-op;
  no backend endpoint exists for it yet.
- **"Overdue" / SLA metrics** — see §9. No business rule defined yet.
- **`bagType`** (standard/express) — not on the `Bag` model; nothing reads
  it server-side.

If any of these become the next priority, flag it and we'll scope it the
same way as the rest of this module.
