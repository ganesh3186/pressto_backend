# M2 Frontend Screens — Backend Task List

## ⚠️ Status note (read first)

- These screens exist in `pressto-admin-panel` on the **`main`** branch (merged there via commit `4fdc1e9`, "Merge branch 'M2-GAN-DEV'", 2026-08-09). That merge happened **outside the normal `staging → main` workflow** — someone merged the `M2-GAN-DEV`/`M2-VEDASHRI-DEV` branches directly into `main`.
- **`staging` currently has none of this code** (verified: neither `M2-GAN-DEV` nor `M2-VEDASHRI-DEV` is an ancestor of `origin/staging`). Keep it that way until the backend below exists — **do not merge/cherry-pick any M2 screen into `staging`** until its backend is built and the frontend team has wired it up for real.
- Almost everything described below is **mock/localStorage-only today** — no camera scanning, no live GPS, no real persistence beyond the browser tab that touched it. A few pieces (rider roster, rider availability, rider attendance, some order-status transitions) already have real, working endpoints — those are called out explicitly per module so we don't rebuild what exists.
- This document is descriptive (what the frontend already assumes) + prescriptive (what backend work it implies). Every module ends with **open questions** — decisions to make together before writing models/endpoints, not things to silently decide.

## Module index

1. [POS Shift Open/Close](#1-pos-shift-openclose)
2. [Interstore Transfer](#2-interstore-transfer)
3. [Rider Management](#3-rider-management)
4. [Logistics (Pickup / Dispatch / Delivery Management)](#4-logistics)
5. [Order Delivery Dialog](#5-order-delivery-dialog)
6. [Cross-cutting endpoint summary](#6-cross-cutting-endpoint-summary)

---

## 1. POS Shift Open/Close

**Screens:** `Create Order → Shift Open` (`/dashboard/orders/shift/open`), `Shift Close` (`/dashboard/orders/shift/close`). No nav-menu entry — reached only by being gated into it from the New Order screen, or direct URL.

### Why it exists
A cashier can't create an order without an **open shift**. `requiresPosShift(roles)` gates the entire New Order screen behind `ShiftOpenView` for roles `store_exec | cce | cci`. Once open, a status banner with a live elapsed timer sits above the order screen; "Close shift" is reachable from there.

### Flow
1. **Open**: cashier sees 4 fixed reconciliation rows (Cash in Till, Banking, Petty Cash, Prepaid Vouchers) — each with a system-prefilled **Supposed** value and a required **Actual** (typed) value, plus required remarks (≤200 chars). Save opens the shift.
2. Cashier uses the order screen normally. No `shiftId` is attached to orders anywhere today.
3. **Close**: a much larger reconciliation form — Collections (cash/card/cheque/PGLink/PP voucher/wallet), Wallet Collections, Banking, Prepaid Vouchers, Petty Cash, Card & PGLink Settlement, PP Voucher, Register & Actual Cash in Till, plus a 4-brand (Pressto/Cobbler/PMU Plus/B2B) × 7-metric Revenue matrix and an identically-shaped Sales Return matrix. Only "remarks required" is validated — none of the ~40 numeric fields are.
4. Only the user who opened a shift can close it (client-side check only, today).

### Data model (frontend's exact shape — see full field list in the research notes; summarized here)
```
Shift {
  id, openingNo, closureNo, storeId, storeCode, storeName,
  userId, userName, status: 'open'|'closed', openedAt, closedAt,
  openingUserId/Name, closingUserId/Name,
  opening: { cashInTill, banking, pettyCash, prepaidVouchers: {supposed, actual, difference} each, remarks },
  closing: { collections, walletCollections, banking, prepaidV, pettyCash,
             cardPgSettlement, ppVoucher, register, actualCashInTill,
             revenue: {pressto,cobbler,pmuPlus,b2b} × {revenue,discount,taxes,totalSales,tickets,items,services},
             salesReturn: same shape as revenue, remarks }
}
```

### What's real today
Nothing. 100% `localStorage` (keys `pressto_pos_shift_v1`, `pressto_pos_shift_opening_no_v1`). Sequential numbering is a per-browser counter starting at 1744 — not usable once real.

### Backend task list
- [ ] `Shift` model — one open shift per (need to decide: user? store? terminal?) — see open questions.
- [ ] `POST /shifts` (open) — validate no other open shift exists for the same scope; server-computed "supposed" opening balances chained from the store's last closed shift (mirror `buildOpeningSupposedValues`, but server-authoritative).
- [ ] `POST /shifts/{id}/close` — accept the full closing form; recompute every "supposed"/derived field **server-side** rather than trusting client math (today `collections.total`, `pettyCash.balance`, `register.currSupCashInTill`, etc. are all client-computed from client-typed inputs).
- [ ] **Real "expected cash" computation** — none exists anywhere today. This needs actual order/payment data for the shift window: expected cash-in-till, expected card/PG settlement, expected wallet collections, expected revenue by brand. This is the single biggest real piece of new backend logic in this module (the current UI just lets the cashier type whatever they observed).
- [ ] `shiftId` FK on `Order` (or equivalent) if orders should be attributable to a shift — currently not linked at all.
- [ ] `GET /shifts?storeId=&status=` for ops/audit visibility (no such screen exists in the UI yet, but the underlying data should support building one).
- [ ] Sequential shift numbering per store (not a client counter).
- [ ] Decide/enforce: what happens to an order placed with no open shift (reject at API level, or trust the frontend gate)?
- [ ] Role mapping: frontend gates on `store_exec/cce/cci`; confirm these map to real backend role slugs (the finance-approvals work earlier used `finance`/`super_admin`/etc. — same `Roles`/`Permissions` system should back this).

### Open questions
1. Is a shift scoped to (user, store), or should it be per-terminal/register (today two cashiers at the same store can both have an "open shift" simultaneously — is that intended)?
2. Should force-close/handover (manager closes someone else's forgotten-open shift) be supported? Today only the opener can close.
3. Should variance beyond a tolerance threshold require an approval step (tie-in to the Finance Approvals screen we just built)?
4. Structured reason codes for large variances, or is freeform remarks enough?
5. `cardPgSettlement.difference` and the two "cumulativeDiff" fields are inconsistently computed/editable in the frontend (flagged as a likely frontend bug) — confirm intended formulas before backend mirrors them.

---

## 2. Interstore Transfer

**Screens (all under `/dashboard/transfer/*`):** All Transfers, Transfer Out (send), Receive, Assign (driver — stub), Transit Details, Item Tracking, Custody/Trail Report. Nav group "Transfer".

### Why it exists
Move garments between stores (e.g. a Junior/Society store sending items to Main for a service it can't perform) with bag-level physical custody tracking and a full audit trail.

### Flow
1. **Store A — Transfer Out**: scan/select a bag → scan items (or bulk-add a whole order's items via a dialog) → "Create transfer" atomically creates the transfer **already in `SENT` status** (no separate draft/dispatch step today) and marks the bag `IN_USE`.
2. **Store B — Receive**: scan the bag or transit ID → scan items in, one at a time → live reconciliation shows Matched/Missing/Extra/Incorrect → "Confirm receipt" sets status to `RECEIVED` (if fully clean) or `DISCREPANCY`, releasing the bag on a clean receive.
3. **Assign** (driver): UI-only stub — a button that shows a snackbar and persists nothing.
4. **Transit Details**: read-only — totals, return batches (partial shipments back to origin), per-order breakdown.
5. **Item Tracking**: single-garment view — current store/bag/transit/stage, timeline, remaining TAT, next action.
6. **Custody/Trail**: searchable log of every custody event (bag scanned → items mapped → sent out → received/discrepancy → bag released), keyed by garment tag or transfer order number.

### Data model
```
Transfer {
  id, transitId ('TR-{fromCode}-{toCode}-{ddmm}-{seq}'), transferOrderNumber ('TO-{ts}'),
  status: initiated|sent|dispatched(deprecated→sent)|in_transit|received|discrepancy|closed,
  reason, bagId, bagType: standard|express,
  fromParty/toParty: { type: store|van, id, name, code },
  items: [{ garmentId, garmentTagNumber, orderId, orderType, customerName, itemName, serviceName,
            destinationStoreId/Name, scanStatus: pending|scanned|received|removed, removedReason }],
  discrepancies: [{ garmentTagNumber, type: missing|extra, note }],
  initiatedAt/By, sentAt/By, receivedAt/By,
  events: [ custody event log — see below ]
}

Bag { id, bagNumber, status: available|in_use|full, bagType, maxCapacity(default 25),
      itemCount, currentStoreId/Name, currentTransferId }

CustodyEvent types: bag_scanned, items_mapped, sent_out, initiated, dispatched(deprecated),
      in_transit, received, discrepancy, wrong_scan_removed, bag_changed, bag_released, closed
```

### What's real today
**Nothing transfer-specific.** Zero `axiosInstance` calls anywhere in the module. The only real API traffic is *borrowed* from other masters: `GET /stores`, `GET /bags` (one-way synced into a **separate** local mock bag registry, never written back), `GET /store-service-mappings`, `GET /orders`. Bag QR encode/decode is a genuinely working client-side codec (`qrcode` npm package, custom `PTB1.` payload format) — that part transfers cleanly to a real implementation. Item/garment "scanning" is plain string matching against mock data, no QR structure.

Note: 3 files (`transfer-initiate-view.js`, `transfer-dispatch-view.js`, `transfer-status-view.js`) plus `src/routes/sections/interstore-transfer.js` are **dead code**, not reachable from any route — ignore them.

### Backend task list
- [ ] `Transfer` model + full lifecycle (`initiated→sent→in_transit→received|discrepancy→closed`) — decide whether "initiate" (draft) is a real distinct step or the atomic create-and-send behavior the frontend currently has is what we want.
- [ ] `Bag` custody fields (status/capacity/currentStoreId/currentTransferId) — decide whether this becomes a real property of the **existing** Bag Master entity (`pressto_backend` already has bags) rather than a separate transfer-local concept.
- [ ] `POST /transfers` (send out) — create + mark bag in-use, atomically.
- [ ] `POST /transfers/{id}/receive` — reconcile scanned vs manifest, set `received`/`discrepancy`, release bag on clean receive.
- [ ] `GET /transfers` (list, filterable by direction/status/date/type) + `GET /transfers/{id}` (detail).
- [ ] `GET /transfers/item/{garmentTag}` (item tracking) — current store/bag/transit/stage.
- [ ] `GET /custody-events?garmentTag=&transferId=` (Trail report) — decide if this should be a first-class queryable table (by store/date range too) rather than transfer-embedded.
- [ ] Server-side `transitId`/`transferOrderNumber` sequencing (today's client sequence is a hardcoded `1`, guaranteed to collide).
- [ ] Real bag QR validation server-side (reuse the frontend's `PTB1.` payload format or define a backend-authoritative one).
- [ ] Decide + build: driver/van assignment (currently a no-op stub) — or explicitly route this through the Rider module instead (see Module 3).
- [ ] Decide + build: return-batch / partial-return chaining (today fully hardcoded demo data with no real creation path).
- [ ] Real TAT/SLA computation (today hardcoded strings like "6h 15m").
- [ ] Real "All Transfers" summary stats (today static fake numbers).

### Open questions
1. Does a transfer need a real draft/pre-approval state, or is atomic create-and-send (today's behavior) the intended real flow?
2. Should the receiving store be able to pre-approve/reject an incoming transfer before dispatch?
3. What should happen operationally on a `discrepancy` result — does the bag stay locked to that shipment until manually resolved?
4. Should "wrong scan removed" items be void-with-reason (kept, flagged) rather than disappearing from every query, for audit purposes?
5. Does inter-store van/driver assignment belong here or should it reuse the Rider module (`pressto_backend` already has a `Rider` domain)?
6. Multi-destination single order (one order's items split across "kept at origin" + 2 other stores) — does this need an order-level fulfillment-location map, or is it reconstructed by querying transfers?
7. Should unregistered bags auto-create on first scan (today's behavior) or be rejected until pre-provisioned via Bag Master?

---

## 3. Rider Management

**Screens:** Manual Assign, Manage Rider, Rider Availability (+ Roster), Pincode Mapping, Track Rider (reached only via Manage Rider's row action), Raised CS / Rider Notification (pre-existing placeholders, unchanged, not in scope).

Rider basics (CRUD, roster, attendance, availability) **already have working backend endpoints** — this module is a mix of "already real" and "still mock," module by module below.

### 3.1 Manage Rider — mostly real already
- Real: `GET/POST /riders`, `GET /riders/{id}`, `PATCH /riders/{id}` (status-only), `GET /riders/count`.
- **Bug, not a backend gap**: editing an existing rider currently only updates local state — no `PATCH` is sent. **Task:** confirm the full-detail update payload shape and make sure `PATCH /riders/{id}` accepts a full-detail body (not just `{isActive}`) so this can be fixed frontend-side.

### 3.2 Rider Availability — real, polled every 30s
- Real: `GET /riders/availability` → `{riders: [{riderId, riderCode, name, riderType, phone, countryCode, status: available|on-break|off-duty, lastUpdatedAt, location}]}`.
- **Task:** confirm/implement server-side derivation of `status` from attendance punch-state + active roster entry (leave/break/week-off) "as of now" — this logic doesn't exist in the frontend, it's presented as if the backend already computes it.
- **Open question:** should `location` become real lat/lng for a live map, or stay a display string?

### 3.3 Rider Roster — real CRUD already
- Real: `GET /rider-rosters` (filtered/paginated), `GET /riders/{id}/rosters`, `POST /rider-rosters`, `GET/PATCH /rider-rosters/{id}`, `DELETE` (registered, unreachable from UI by design).
- `rosterType` enum: `leave | permission | work | other | break | week-off`.
- **Task:** confirm exact response envelope for `GET /riders/{id}/rosters` — frontend code defensively handles two different possible shapes (`{rosters: [...]}` vs raw LoopBack array), meaning this wasn't nailed down when it was built.

### 3.4 Rider Attendance — real, read-only
- Real: `GET /riders/{id}/attendance?from=&to=` → punch-in/out timestamps, selfie URLs (server-resolved), lat/lng, status `punched_in`/`punched_out`.
- Assumes punch-in/out is captured by a separate rider-facing (mobile?) surface — nothing admin-side writes attendance. **Open question:** does ops need a manual override/correction action?

### 3.5 Rider Tracking — 100% mock, biggest gap in this module
No API calls at all. 10 hardcoded riders each generate 2 fake "trips" with stops (`store_start|pickup|delivery|transfer_pickup|transfer_delivery|store_return`), fake distances, and a Google Maps iframe pointed at a static address string (no live GPS).
- [ ] **Task:** decide if this needs a real Trip/Ride entity (rider → ordered stops → distance, built from real pickup/delivery/transfer assignments) or if live GPS tracking is a separate, larger ask. The mock's stop taxonomy is a reasonable starting schema either way.
- [ ] `GET /riders/{id}/trips?from=&to=` once the data model exists.

### 3.6 Manual Assign — mostly mock
Only the rider picker (`GET /riders`) is real; the order list is 6 hardcoded demo orders, and "Assign selected" writes to in-memory state only — nothing persists.
- [ ] **Task:** a real "bulk-assign rider + delivery slot to N orders" endpoint if this is meant to go live. Slot capacity ("assigned"/"free" counts) is currently decorative — needs to be computed if kept.

### 3.7 Pincode Mapping — 100% localStorage
Entire CRUD (`rider ↔ pincodes[]`) lives in the browser; pincode universe is a hardcoded 21-item Bengaluru list; "one rider per pincode" is validated client-side only.
- [ ] **Task:** real `rider-pincode-mapping` table + CRUD API.
- [ ] **Open question:** should the pincode list come from an existing Region/Pincode master instead of being hardcoded?

### Backend task list (module-wide)
- [ ] Fix `PATCH /riders/{id}` to accept full-detail edits (3.1).
- [ ] Server-side `status` derivation for Rider Availability (3.2).
- [ ] Confirm `GET /riders/{id}/rosters` response envelope (3.3).
- [ ] Decide + design Trip/Ride entity for Rider Tracking, or scope it out for now (3.5).
- [ ] Bulk order-assignment endpoint for Manual Assign, if going live (3.6).
- [ ] `rider-pincode-mapping` CRUD (3.7).
- [ ] Permission gaps: `Manual Assign`, `Pincode Mapping`, `Raised CS`, `Rider Notification` nav items currently have **no** permission gate at all (unlike Manage Rider / Availability which require `rider:read`) — confirm whether these need RBAC before going live.

### Open questions (module-wide)
See inline per-screen above; the big one is **3.5 (Rider Tracking scope)** since it's the only piece here requiring genuinely new architecture rather than "wire up a CRUD endpoint."

---

## 4. Logistics

**Screens:** Pickup Management, Dispatch Management, Delivery Management (all under Orders → Logistics, now live — was previously commented out of the nav).

### 4.1 Pickup Management — mostly mock
Blends real orders (`GET /orders`, filtered to pickup-type) with manually-logged pickup requests (phone/WhatsApp intake) that live **only in `localStorage`**. Rider assignment ("assign rider & create ride") generates a fake `RIDE-{timestamp}` id and never calls an API.
- Status enum: `requested | scheduled | rider_assigned | out_for_pickup | picked_up | received_at_store | cancelled`.
- Source enum: `web | call | whatsapp`.
- [ ] **Task:** real Pickup/Ride entity with create + assign + status-transition endpoints.

### 4.2 Dispatch Management — partially real
Reads real orders in dispatch-relevant statuses, **and** the one real write in this whole cluster:
```
POST /orders/{id}/status   { status: 'out_for_delivery', remarks: '...' }
```
already works (pre-existing endpoint). Rider assignment itself, though, comes from the `localStorage` delivery plan (Module 5), not a server-persisted assignment.
- **Found bug-shaped gap**: "garment readiness" (`readyGarments`/`totalGarments`) is hardcoded to always show 100% ready — there's no real per-garment readiness signal wired in.
- [ ] **Task:** decide if real garment-level readiness should gate dispatch, and if so wire it from actual garment/process status.

### 4.3 Delivery Management — partially real
Same pattern: real orders + `POST /orders/{id}/status {status:'delivered'}` already works. **No real proof-of-delivery** — the "proof" field is a hardcoded string (`'Delivery confirmed by store'` / `'OTP pending'`), no OTP entry, no signature, no photo upload anywhere in this screen or Module 5's dialog.
- Status enum: `assigned | out_for_delivery | attempted | delivered | failed | rescheduled | returned` — only `out_for_delivery`→`delivered` is reachable from the UI today; `attempted/failed/rescheduled/returned` have no triggering action.
- [ ] **Task, pending product decision**: if OTP/signature/photo proof-of-delivery is required, this is net-new work on both sides — nothing exists today.
- [ ] **Task**: UI actions for failed/rescheduled/returned deliveries, if those states are meant to be reachable.

### Backend task list
- [ ] Pickup/Ride entity + endpoints (4.1).
- [ ] Decide real garment-readiness signal for Dispatch gating (4.2).
- [ ] Decide + build proof-of-delivery capture if required (4.3) — coordinate with Module 5, since the actual "assign rider/schedule delivery" UI lives there.
- [ ] Decide whether Pickup/Dispatch/Delivery should be genuinely new `Pickup`/`Ride`/`Dispatch` entities, or should hang entirely off `Order` fields (current naming convention on `PATCH /orders/{id}`'s new delivery fields suggests the latter was the original intent) — the three screens are currently inconsistent about which model they lean on.

### Open questions
1. Same Pickup/Ride-vs-Order-fields modeling question as above — pick one consistently across Modules 2 (transfer driver assignment), 3 (rider trips), 4 (pickup rides), and 5 (delivery assignment) rather than deciding it four separate times.
2. Is OTP/signature/photo proof-of-delivery in scope for this pass or a later one?

---

## 5. Order Delivery Dialog

**Where:** Order Status / Order Details screens, opened via a delivery-truck action once an order is Ready/Out for Delivery.

### Why it exists
Lets a store user choose how an order gets to the customer: **store pickup** (hands off into the existing, unchanged `OrderHandoverDialog` flow) or **home delivery** (schedule date/slot, pick a rider, pick/add a customer address, add remarks).

### The most important finding in this whole document
The frontend **already calls a real endpoint** for this, and the code explicitly handles the possibility that the backend doesn't fully support it yet:
```
PATCH /orders/{id}
  { deliveryMethod, deliveryDate, deliverySlot, assignedRiderId, assignedRiderName,
    deliveryAddress, deliveryStatus, deliveryInstructions, instructions, remarks }
```
If this call fails, the frontend **silently retries** with only `{ deliveryDate, instructions, remarks }` — fields it assumes definitely persist — and shows a different ("saved locally, not yet backed by this API deployment") message to the user. Everything is *also* written to `localStorage` regardless, as a safety net.

**This means: confirm today, precisely, what `PATCH /orders/{id}` currently accepts and persists for these fields.** This is the one place in all of M2 where the frontend already assumes a contract — we should either confirm it already works, or extend the endpoint to actually accept and store:
```
deliveryMethod:   'store_pickup' | 'home_delivery'
deliveryStatus:   'ready' | 'assigned' | 'scheduled' | 'out_for_delivery' | 'delivered'
deliveryDate, deliverySlot (one of 6 fixed string ranges, not a slot ID),
assignedRiderId, assignedRiderName,
deliveryAddress (currently a denormalized display string, not an address FK — worth reconsidering),
deliveryInstructions/instructions/remarks (same text sent 3x under different keys defensively)
```

### Backend task list
- [ ] Confirm/extend `PATCH /orders/{id}` to accept and persist the full delivery-field set above.
- [ ] Decide whether `deliveryAddress` should be a real FK to the customer's address book (it already exists as a master — `useGetCustomerAddresses` is real and pre-existing) rather than a denormalized string.
- [ ] Tie this into Module 4's Dispatch/Delivery Management once real — today the assignment made here only reliably survives via `localStorage`, and Dispatch/Delivery Management reads that same local cache.
- [ ] No proof-of-delivery capture exists here either — same open question as Module 4.3.

### Open questions
1. Is `deliveryAddress` meant to become a real address FK now, or is a denormalized string acceptable long-term?
2. Should `deliverySlot` become a real slot/capacity concept (tie-in to Manual Assign's decorative slot capacity, Module 3.6) rather than a free string?

---

## 6. Cross-cutting endpoint summary

### Already real — do not re-spec these
| Endpoint | Method | Used by |
|---|---|---|
| `/riders` | GET / POST | Manage Rider |
| `/riders/{id}` | GET | Manage Rider, Roster |
| `/riders/{id}` | PATCH `{isActive}` | Manage Rider status toggle |
| `/riders/count` | GET | pagination |
| `/riders/availability` | GET | Rider Availability (polled) |
| `/riders/{id}/attendance` | GET | Rider Attendance |
| `/rider-rosters` | GET / POST | Roster list / create |
| `/riders/{id}/rosters` | GET | Roster per-rider tab |
| `/rider-rosters/{id}` | GET / PATCH / DELETE | Roster edit (delete hidden in UI) |
| `/orders` | GET | Pickup/Dispatch/Delivery row sourcing |
| `/orders/{id}` | PATCH | Order Delivery Dialog (needs field-support confirmation) |
| `/orders/{id}/status` | POST | Dispatch → `out_for_delivery`, Delivery → `delivered` |
| `/stores`, `/bags`, `/store-service-mappings` | GET | Transfer module dropdowns/candidates (borrowed, not transfer-specific) |
| Customer addresses | existing | Order Delivery Dialog |

### Genuinely new, no backend or frontend real-endpoint exists yet
- POS Shift (open/close/expected-cash computation)
- Interstore Transfer (everything — transfers, custody events, bag-in-transfer state)
- Rider Tracking / Trips
- Manual Assign (order bulk-assignment)
- Pincode Mapping
- Pickup/Ride entity for Pickup Management
- Proof-of-delivery (OTP/signature/photo) — appears nowhere in M2 at all, front or back

### Cross-module modeling decision to make once, not four times
Rider/driver "assignment" shows up independently in **Transfer** (driver assign stub), **Rider Tracking** (trips), **Pickup Management** (ride creation), and **Order Delivery Dialog** (rider + slot). Decide one consistent shape — e.g. a single `Assignment`/`Ride` concept keyed by `(riderId, context: transfer|pickup|delivery, contextId)` — rather than bolting a slightly different rider-assignment model onto each feature.
