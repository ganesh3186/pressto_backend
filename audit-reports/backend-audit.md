# Pressto Backend — Production Readiness Audit (Agent 2: Backend / LoopBack 4)

Repo: `D:\karans_code_lab\pressto\pressto_backend` (branch `code-audit`)
Scope: AUDIT ONLY — no files edited, no DB/migrations run, no tests executed.
Uncommitted changes to `src/controllers/shift.controller.ts` and
`src/__tests__/shift-rider-cash.unit.ts` were left untouched and are not discussed
below as defects — they are the user's own in-progress performance fix.

## How this codebase reads

This backend shows clear signs of a prior, deliberate performance-remediation pass:
many files (`order.service.ts`, `dashboard.service.ts`, `pressto.datasource.ts`,
`ecosystem.config.js`, `whatsapp.service.ts`) carry inline comments documenting a
specific past incident (connection-pool exhaustion, event-loop-pinning wildcard
search, single-instance PM2) and the fix applied. Those already-fixed items are
**not** re-flagged as open findings below except where a fix is partial. The
findings below are the issues that survived that pass, plus endpoints that pass
appears not to have reached.

---

## A. Relation / response-payload audit

Grep for `include:[` across `src/controllers` and `src/repositories` found ~20
usages, almost all single-level (`{relation: 'region'}`, `{relation: 'roles'}`)
and several already using `scope: {fields: {...}}` projection
(`cluster-price-list.controller.ts:88,106`, `approval.controller.ts:130`). No
deeply-nested (2+ level) `include` chains or full-collection-via-include patterns
were found in controllers or repositories. **No Critical/High finding for area A** —
most list endpoints in this codebase build their response payload manually via
batched `find()` + in-memory joins (see area C) rather than via LB4 relation
`include`, which avoids the classic LB4 n-level-include over-fetch problem, but
introduces the N+1/unbounded-fetch problems documented under B and C instead.

- **BE-001 — `garment.controller.ts:373-411` `GET /garments` accepts a raw client-supplied LoopBack `where` filter**
  - Evidence: `const parsed = JSON.parse(filterStr); ... where = {...parsed.where, isDeleted: false};` (lines 384-388), then passed directly into `this.garmentRepository.find({where, limit: Math.min(Number(limit ?? 20), 200)})` (line 402-405).
  - Impact: a caller can shape `where` with arbitrary operators (`or`, `like`, nested `and`), which could be used to construct a deliberately expensive filter (e.g. unanchored `ilike` across a non-indexed text column) since there is no allow-list of filterable fields.
  - Severity: Low (query cost only; the `limit: 200` cap bounds result size and store-scope filtering is applied after, per the code's own comment at line 407-409). Confidence: Confirmed.
  - Recommendation: allow-list the fields `parsed.where` may touch, or replace the raw passthrough with named query params (as `order.controller.ts` does for `/orders`).
  - How to validate: attempt a `filter` payload with a non-indexed `ilike`/`or` combination against a large garments table and measure latency.

---

## B. API listing and pagination

### BE-002 — `GET /transfers` has no pagination at all (Critical, Confirmed)
- File: `src/controllers/transfer.controller.ts:899-937` (`find()`)
- Evidence:
  ```
  const transfers = await this.transferRepo.find({where: {and} as object, order: ['createdAt DESC']});
  return {transfers: await this.enrichTransfers(transfers)};
  ```
  No `limit`/`skip` parameters exist on the method signature at all (lines 901-909). With no filters supplied, this returns **every non-deleted transfer in the system**, then runs `enrichTransfers()` (line 936) which does two further `inq` batch queries sized to the full result set (`src/controllers/transfer.controller.ts:170-221`, e.g. `this.transferItemRepo.find({where: {transferId: {inq: transfers.map(t => t.id)}}})` at line 177-180 — an IN-list sized to every transfer ID returned).
  `GET /transfers/export` (line 948-960) explicitly reuses this same unpaginated `find()` ("Reuse the unpaginated listing query" — line 958), so there is no paginated path for this resource at all, not even for the main list UI.
- Measured impact: unbounded — grows linearly with the lifetime transfer count of the whole chain (inter-store transfers accumulate across all stores/clusters over the life of the business). No field projection on the primary `transferRepo.find()` either (full row returned).
- Why it's a bottleneck under concurrent traffic: every call to the "All Transfers" screen (and every export) does a full-table scan-equivalent plus two further IN-list queries proportional to table size, holding a pool connection (max 15/instance, see BE-0xx datasource note) for the whole duration; concurrent staff opening this screen can exhaust the pool.
- Severity: Critical. Confidence: Confirmed (code read directly).
- Recommendation: add `limit`/`skip` (and a hard max, matching the pattern already used in `reports.controller.ts` — `DEFAULT_LIMIT=100`, `MAX_LIMIT=500`, `clampLimit()`) to `/transfers`, apply them in the DB `find()`, and compute `total` via a separate `count()` rather than `transfers.length`.
- Dependencies/risk: the current UI may rely on getting "all" rows in one response (e.g. to compute client-side aggregates); check the admin-panel/customer-web consumer before truncating.
- How to validate later: `SELECT count(*) FROM transfer WHERE isdeleted=false;` in a read replica/staging to see current table size, and time the endpoint under that volume.

### BE-003 — `GET /deliveries` has the identical unpaginated pattern (High, Confirmed)
- File: `src/controllers/delivery.controller.ts:65-93`
- Evidence: `const deliveries = await this.deliveryRepo.find({where: {and} as object, order: ['createdAt DESC']}); return {deliveries: await this.enrichDeliveries(deliveries)};` — no `limit`/`skip` params on the method (lines 67-74).
- Same mechanism and risk profile as BE-002, on the `delivery` table (one row per dispatch run, high volume at scale).
- Severity: High (deliveries are created more frequently than transfers in most flows, though filters by `status`/`storeId`/date are available and commonly used, partially mitigating). Confidence: Confirmed.
- Recommendation: same as BE-002.

### BE-004 — Reports service fetches the full date-range result set unbounded by SQL `limit`, paginates in memory (High, Confirmed)
- File: `src/services/reports.service.ts`
  - `buildPendingPayments()` — `this.orderRepo.find({where: {...this.orderScopeWhere(params), status: {neq: CANCELLED}}, order: [...]})` with **no `limit`** (lines 854-860), full result enriched (`buildCollectedByOrder`, `buildDeliveryStatusByOrder`, `buildCustomerContext` — lines 864-869) over the entire matching set, then `enriched.slice(skip, skip + limit)` (line 899) — pagination applied only after fetch+enrichment.
  - `buildPendingTickets()` — identical pattern: unbounded `orderRepo.find` (lines 926-932), slice at line 965.
  - `buildOnAccountBilling()` — unbounded `orderRepo.find` (line 1031), slice at line 1090.
  - `buildSalesGst()` — unbounded `invoiceRepo.find` (candidateInvoices, line 1163), slice at line 1328.
  - `buildPettyCashExpense()` — similar unbounded fetch + `rows.slice(skip, skip + limit)` (line 2035).
- Window is bounded by `reports.controller.ts:12` `MAX_RANGE_DAYS = 366`, so the fetch is at least date-bounded (storeId + createdAt between), but **not row-count-bounded**: a chain-wide report over a full year pulls every matching order/invoice into Node memory and runs full per-row enrichment (extra batched queries) before the page is sliced out.
- Measured impact: enrichment cost (`buildCollectedByOrder`, `buildDeliveryStatusByOrder`, `buildCustomerContext`, `buildStoreContext`) scales with total matching rows, not with the requested page size (`limit`, capped at `MAX_LIMIT=500` in the controller) — so asking for page 1 of 500 costs the same as fetching the entire report.
- Why it's a bottleneck under concurrent traffic: these are the Finance/Ops reports screens (pending payments, pending tickets, on-account billing, sales GST, petty cash) — exactly the endpoints likely to be run concurrently by multiple back-office staff at shift-close/month-end, each holding a DB connection for a full-range scan + several follow-up batched queries.
- Severity: High. Confidence: Confirmed (code read directly for all five report builders).
- Recommendation: push `limit`/`skip` down to the initial `orderRepo.find`/`invoiceRepo.find` call where the business logic allows (status/delivery/customer-label filters that currently run in-memory after the fetch — `buildPendingPayments` lines 881-893 — would need to move into the SQL `where`, which is more invasive but is exactly what's blocking server-side pagination here). At minimum, cap total rows fetched (e.g. a hard ceiling with a "narrow your date range" error) independent of `MAX_RANGE_DAYS`.
- Dependencies/risk: `buildModeOfPayment()` additionally merges three different ledgers (payments, wallet top-ups, on-account invoices) into one sorted list before paging (service comment at lines 460-463 explains why DB-side limit/skip alone would be wrong) — any fix here needs to preserve that merge-then-page correctness, not just bolt on a SQL limit.
- How to validate later: run `buildPendingPayments`/`buildPendingTickets` for a full `MAX_RANGE_DAYS` window on the real store set and measure rows actually fetched vs. rows returned (`totalCount` in the response already reports this — compare it to a typical page size of 100).

### BE-005 — `GET /approval-requests` list is unbounded by default and, for store-scoped (non-global) callers, paginates fully in memory after an unbounded DB fetch (High, Confirmed)
- File: `src/controllers/approval.controller.ts:542-645`
- Evidence:
  - `limit`/`skip`/`page` are all optional with **no default and no max** (`@param.query.number('limit') limit?: number` at line 551 — contrast with `reports.controller.ts`'s `clampLimit()`).
  - Global-scope branch (lines 593-616): if `limit` is omitted, `resolvedLimit` is `undefined`, so `this.approvalRequestRepo.find({where, order: [...]})` (lines 597-602) runs with **no limit/skip at all** — every approval request matching `where` (which can itself be empty, i.e. every row in the table).
  - Store-scoped branch (lines 618-645) is worse unconditionally: `this.approvalRequestRepo.find({where, order: [...]})` (lines 618-621) is called **without ever passing `limit`/`skip` to the DB**, regardless of what the caller requested; scope filtering (`_filterByStoreScope`) and pagination (`inScope.slice(...)`, lines 626-631) both happen in memory after the full unbounded fetch.
  - Each returned row is then enriched via `Promise.all(requests.map(r => this.enrichRequest(r)))` (lines 604, 633). `enrichRequest()` (lines 141-230+) issues up to 4-5 **sequential** `findOne`/`find` calls per row (order, customer, rework order, active rework pickup, garments) — so the `Promise.all` fans out N parallel chains of ~3-5 sequential DB queries, N being the full unbounded/unfiltered row count, not the page size.
- Why it's a bottleneck under concurrent traffic: this is the most severe concurrency-risk finding in the audit. A store-scoped user hitting `/approval-requests` with no filters triggers one unbounded `find`, then a burst of `N × ~3` concurrent queries against the pool (max 15 connections/instance per `pressto.datasource.ts`), where N is the entire approval-request table (or whatever `type`/`status`/`entityType` narrows it to) rather than one page. Two or three staff hitting this screen at once could by itself exhaust the pool described in `pressto.datasource.ts`'s own incident comment.
- Severity: Critical for the store-scoped branch (no DB-level pagination at all, confirmed); High for the global-scope "omit limit" case.
- Confidence: Confirmed.
- Recommendation: push `limit`/`skip` into the store-scoped branch's `find()` call too (it currently ignores them entirely at the DB level), give `limit` a default and hard max exactly like `reports.controller.ts`'s `clampLimit`, and consider batching `enrichRequest`'s per-row lookups the way `order.service.ts`'s `listOrders` does (resolve all orders/customers/garments for the whole page in one batched `inq` query each, instead of per-row sequential calls).
- Dependencies/risk: store-scope filtering (`_filterByStoreScope`) currently needs the full row set in memory to filter correctly before paging; moving `storeId`-equivalent filtering into SQL would need the approval request to carry a resolvable store reference at the DB level (today it's resolved via the related order/garment, which is why it's done in memory) — this is a real design constraint, not just an oversight, and a fix needs to account for it.
- How to validate later: call `/approval-requests` with no query params against production-scale data (or a representative staging snapshot) and measure both the row count fetched and the number of DB round-trips (e.g. via query logging) for a single request.

### BE-006 — `GET /sales-returns` (`listAll`) has the same unbounded-fetch-then-in-memory-page pattern (High, Confirmed)
- File: `src/controllers/sales-return.controller.ts:901-981`
- Evidence: `limit`/`skip` are accepted as params (lines 912-914) but never passed to the DB call — `this.salesReturnRepo.find({where, order: ['createdAt DESC']})` (lines 938-941) fetches every matching row; `orderRepo.find({where: {id: {inq: orderIds}}})` (line 953) resolves orders for **every** fetched sales return, not just the page; only after store-scope filtering (lines 956-972) does `inScope.slice(resolvedSkip, resolvedSkip + resolvedLimit)` (lines 976-981) select the actual page, and customer/cashShift lookups (lines 983-1000) are at least correctly scoped to the final page.
- Severity: High. Confidence: Confirmed.
- Recommendation: same shape as BE-005 — move `status` filtering (already SQL-side, good) plus pagination fully into the initial query, and avoid resolving the orders join for rows outside the requested page.
- Note: unlike BE-005, this endpoint's controller-level `limit`/`skip` plumbing is otherwise correct (it does default `page=1` behavior); the gap is specifically "pagination applied after fetch and after one full-width join," not "pagination ignored."

### BE-007 — `listOrders`/`getOrderDetails` (`order.controller.ts` → `order.service.ts`) — reviewed, no new finding
- `src/services/order.service.ts:5223-5690` (`listOrders`) already caps `limit` at 100 (`Math.min(Number(params.limit ?? 20), 100)`, line 5257), uses exact `count()` only on the non-search path and a capped approximate count (`SEARCH_COUNT_CAP`) on the free-text search path (`searchOrderPage`, lines 5157-5221, with its own documented past incident about an unbounded customer IN-list), and resolves every related entity (customers, payments, labels, garments, approvals, riders, users, stores) via batched `inq` queries keyed off the **current page's** order IDs only (lines 5390-5476) — this is the pattern the rest of the codebase (BE-002/003/005/006) should be brought up to. No action needed here; cited as the in-repo reference implementation for recommendations above.

---

## C. Query and service-layer audit

### BE-008 — `OrderService.resolvePricing()` is called sequentially per item (and per additional service per item) during order creation, and itself issues up to ~5 sequential DB round-trips (Critical, Confirmed)
- Files:
  - Pricing waterfall: `src/services/order.service.ts:610-699+` (`resolvePricing`) — for one `(serviceId, itemId)` pair this does, **sequentially, not batched**: `serviceItemMappingRepo.findOne` (line 623), `resolveCouponOverridePrice(...)` (line 645, itself at least one more query), `storePriceOverrideRepo.findOne` (line 686), `storeRepo.findById` (line 693), `clusterPriceListRepo.findOne` (line 695) — and the function continues past what was read (region-level lookup is implied by the `'region'` branch of `priceSource`).
  - Caller loop, item pricing: `src/services/order.service.ts:1731-1735` — `for (const item of workingItems) { const pricing = await this.resolvePricing(...) }`.
  - Caller loop, additional-service pricing per item: `src/services/order.service.ts:1765-1769` — `for (const addlServiceId of distinctServiceIds) { const addlPricing = await this.resolvePricing(...) }` nested inside the item loop.
  - A second occurrence of the same per-item sequential pricing call appears at `src/services/order.service.ts:3686-3690` (order-edit path, `for (const addlServiceId of new Set(unitServiceIds.flat())) { const addl = await this.resolvePricing(...) }`).
- Measured impact: for an order with, say, 20 garments each carrying 1-2 additional services, this is 20-60 calls to `resolvePricing`, each ~4-5 sequential queries = roughly 80-300 sequential DB round-trips inside a **single create-order (or edit-order) HTTP request**, none of it batched or parallelized across items.
- Why it's a bottleneck under concurrent traffic: order creation is one of the highest-frequency, most latency-sensitive write paths in the app (POS counter flow). Each request holds one pool connection (max 15/instance, see datasource note) for the full duration of this serial chain; concurrent order creation at a busy store (or across multiple stores on one PM2 instance) directly competes for the same small pool, and a store/cluster/region price-list change that widens `distinctServiceIds` makes every order proportionally slower. This is also the kind of sequential-await chain that is invisible in isolated/local testing (one order, fast DB) but compounds badly at go-live concurrency.
- Severity: Critical (hot write path, confirmed multiplicative cost, confirmed sequential-not-batched). Confidence: Confirmed.
- Recommendation: batch-resolve pricing for the whole item set in one or two passes — e.g. load all relevant `serviceItemMappingRepo`, `storePriceOverrideRepo`, `clusterPriceListRepo`/region rows for the order's `storeId` once (single store, so `storePriceOverrideRepo`/`clusterPriceListRepo`/region queries are store-invariant across the whole loop and could be hoisted out of the per-item loop entirely — they're being refetched identically on every iteration), and run only the genuinely per-`(serviceId,itemId)` lookup (`serviceItemMappingRepo`) as one `inq` batch instead of one `findOne` per item.
- Dependencies/risk: `resolveCouponOverridePrice` depends on `customerId` as well as `storeId`/`serviceId`/`itemId` — confirm it's also store/customer-invariant across the loop before hoisting; the coupon-override and base-mapping lookups are the two that actually vary per item and need to stay per-item (but can still be batched via `inq` across all items in one query instead of N `findOne` calls).
- How to validate later: wrap `resolvePricing` with a call counter/timer in a staging order-create test with a 15-20 item order and measure total DB round-trips and wall-clock time attributable to pricing resolution alone.

### BE-009 — `MediaService.markUsed` updates one row at a time in a loop instead of a single `updateAll` (Low/Medium, Confirmed)
- File: `src/services/media.service.ts:14-18`
- Evidence:
  ```
  for (const id of mediaIds) {
    await this.mediaRepository.updateById(id, {isUsed: usedStatus});
  }
  ```
- Impact: N sequential `UPDATE ... WHERE id = $1` statements where one `UPDATE ... WHERE id IN (...)` (`updateAll({id: {inq: mediaIds}}, {isUsed: usedStatus})`) would do. `mediaIds` here are the photo/media attachments on a garment/order action, so N is typically small (a handful of photos) — this keeps severity low — but it is still an unambiguous N+1 write with a trivial fix.
- Severity: Low (bounded N in normal usage) but flagged because it's a one-line fix with no behavior change. Confidence: Confirmed.
- Recommendation: `await this.mediaRepository.updateAll({id: {inq: mediaIds}}, {isUsed: usedStatus});`

### BE-010 — `ProcessService` updates process logs one at a time with an explicit lint-suppressed `await` in a loop (Low, Confirmed, self-acknowledged)
- File: `src/services/process.service.ts:2015-2019`
  ```
  for (const log of logs) {
    // eslint-disable-next-line no-await-in-loop
    await this.processLogRepo.updateById(log.id, { status: ProcessLogStatus.PENDING, startedAt: undefined, ... });
  }
  ```
- The author already flagged this with an explicit lint suppression, suggesting it was a conscious tradeoff (likely because each row needs different field values, not a uniform `updateAll`). Noted for completeness; Severity: Low, Confidence: Confirmed. Recommendation: if `logs` can be large in a bulk-reprocess scenario, consider a single multi-row `UPDATE ... CASE` via `dataSource.execute` instead of N `updateById` calls; otherwise leave as-is given it's already a deliberate choice.

### BE-011 — Garment status-transition loop writes one row per garment sequentially (Medium, Confirmed)
- File: `src/services/order.service.ts:4401-4405` — `for (const garment of garments) { const moved = await this.stepGarmentForward(garment as any, GarmentStatus.IN_PROCESS, changedBy, ...) }`.
- `stepGarmentForward` was not fully traced in this pass but by name performs a status-history write plus the garment update per call; invoked once per garment in a bulk "move all garments forward" operation. For an order/batch with many garments this is the same sequential-write-per-row shape as BE-008/BE-009, on the garment-processing hot path (plant operations, not just order entry).
- Severity: Medium (bounded by order/batch size, which is typically smaller than, say, a whole report's row count, but still scales with transaction volume at a processing plant). Confidence: Strong indication (loop confirmed; full cost of `stepGarmentForward` not traced line-by-line in this pass).
- Recommendation: profile `stepGarmentForward`; if it is a single update + single history insert, consider a batched multi-row insert for history and a single `updateAll` for the status field where the "forward" transition is uniform across the batch.
- How to validate later: time a bulk garment-forward operation on an order with 30+ garments.

### BE-012 — Transaction boundaries: no evidence of long-running transactions wrapping external calls
- Grep for `beginTransaction`/`.transaction(` found transactional blocks confined to `order.service.ts`, `approval.service.ts`, `coupon.service.ts`, `process.service.ts`, `reprocess.service.ts`, plus seed/migration scripts (not production request paths). Spot-checked `order.service.ts` transaction blocks (coupon redemption locking at lines 810-814, order-create/edit flows) — payment-gateway and WhatsApp calls are explicitly kept **outside** transactions: `dispatchWhatsApp()` (fire-and-forget helper, `whatsapp.service.ts:93-101`) is invoked only after the transaction commits (e.g. `order.service.ts:2549-2550`, "Business flows call this after their writes/transaction commit succeed" — comment on `dispatchWhatsApp`, line 92). This is good practice — no finding here. Confidence: Strong indication (not every transaction block in an 8,148-line service file was individually read end-to-end in this pass).

### BE-013 — Dashboard service fetches the store's entire lifetime order set (not time-windowed) on every dashboard load, twice (Medium, Confirmed)
- File: `src/services/dashboard.service.ts`
  - `computePipeline()` (lines 457-507): `const orders = await this.orderRepo.find({where: {storeId: {inq: storeIds}}, fields: {id: true}});` — deliberately not date-filtered per the method's own comment ("a stock position, not a window", lines 450-456), used only to derive `orderItemIds` for garment-status counts.
  - `computePettyRider()` (lines 593-629): `const orders = await this.orderRepo.find({where: {storeId: {inq: storeIds}}, fields: {id: true}})` (lines 602-605) — same full-lifetime, unfiltered-by-date fetch, run again independently of `computePipeline`'s identical fetch, just to get `orderIds` for a rider-cash-pending lookup.
  - Both calls project only `{id: true}` (good) and run inside the outer `Promise.all` in `buildStoreSummary` (lines 200-220), so they don't serialize with each other, but each is a full scan of the store's order history and the same `{storeId: inq}` fetch is issued twice per dashboard load.
- Measured impact: scales with the store's (or stores', for cluster/region-scoped viewers) all-time order count, not with "today." For a store with multi-year history this grows unboundedly over time even though the rest of the dashboard is correctly time-windowed.
- Why it's a bottleneck: this is the landing-page dashboard, the single most frequently (and often auto-polled) hit endpoint in the app; an unbounded-by-date query here, issued twice, compounds the same pool-pressure risk as BE-005/BE-008 — and uniquely, this one runs on literally every dashboard page load/refresh, not just an occasional report pull.
- Severity: Medium (mitigated today by the `{id: true}` projection and by the fact that this is a correctness-motivated design choice per the code's own comment, not an oversight) but flagged because the two independent fetches are needless duplication and because "unbounded by date, bounded only by store" will keep getting slower as order history accumulates.
- Confidence: Confirmed (both call sites read).
- Recommendation: (a) compute `orderIds` for the store(s) once per `buildStoreSummary` call and pass it into both `computePipeline` and `computePettyRider` instead of refetching; (b) consider maintaining garment "current status" counts incrementally (or via a lighter-weight query keyed on garment/orderItem directly, e.g. a status index) rather than walking every order a store has ever raised just to get its item IDs.
- How to validate later: compare dashboard load latency for a long-lived store (large lifetime order count) vs. a newly opened store with the same "today" activity level.

---

## D. Connection and concurrency

### Positive finding — connection pool and process topology are already correctly addressed
- `src/datasources/pressto.datasource.ts:6-32`: `max: Number(process.env.PG_POOL_MAX) || 15`, `idleTimeoutMillis: 30000`, `connectionTimeoutMillis: 10000` — all explicitly set, with an in-file comment documenting the prior incident (unset pool defaulting to `max:10`, no connection timeout, requests hanging forever) and the reasoning for the current values, including the multiplication with PM2 instance count.
- `pressto_backend/ecosystem.config.js:11-42`: `exec_mode: 'cluster'`, `instances: Number(process.env.PM2_INSTANCES) || 2`, again with an in-file comment documenting the prior single-instance/single-core bottleneck and the tuning relationship between `PM2_INSTANCES` and `PG_POOL_MAX`.
- These two already encode the standard LB4/Node production-readiness advice (bounded pool with a fail-fast acquisition timeout; multi-instance cluster mode so one slow request can't stall the whole event loop) and do not need further changes from this audit. **No finding** — flagged here only so the lead doesn't ask "was the pool/process topology checked."

### BE-014 — `GeocodingService.fetchJson` uses raw `https.get` with no request timeout, called inline in two request paths (High, Confirmed)
- File: `src/services/geocoding.service.ts:61-81`
  ```
  private fetchJson(url: string): Promise<...> {
    return new Promise((resolve, reject) => {
      https.get(url, res => { ... }).on('error', reject);
    });
  }
  ```
  No `timeout` option is passed to `https.get`, no `req.setTimeout(...)` call, and no `AbortController`/`signal`. If Google's endpoint accepts the TCP connection but then stalls (no response, or a response whose body never ends), this promise never resolves or rejects on its own — it would only be cut off by an OS-level TCP timeout (which can be very long or effectively unbounded on some networks), not by application code.
- Call sites, both inline/awaited in request handlers:
  - `src/controllers/customer-profile.controller.ts:721` — `const geocoded = await this.geocodingService.geocodeAddress(...)`.
  - `src/services/customer-address.service.ts:40` — same pattern, called from the customer-address-save flow.
- `geocodeAddress()` (lines 89-111) does catch network/parse errors and resolve to `null` as a fallback — but only for errors that actually fire; a **hang** (no error, no data) is not caught by that `try/catch`, because nothing ever rejects.
- Why it's a bottleneck under concurrent traffic: a customer saving/updating an address with no coordinates on file triggers this geocode call inline; if Google's API is slow or network-partitioned, the HTTP request (and the pool connection/worker it's using) is held open for as long as the hang lasts, with no server-side cap.
- Severity: High (unbounded external-call hang directly in a customer-facing write path, exactly the pattern area E calls out). Confidence: Confirmed (code shows no timeout mechanism of any kind).
- Recommendation: pass `{timeout: <ms>}` to `https.get`'s options and add a `req.on('timeout', () => req.destroy(new Error('geocoding timeout')))` handler (or migrate to `axios`/`fetch` with a timeout, consistent with `whatsapp.service.ts`'s `axios.post(..., {timeout: 10000, ...})` pattern at `whatsapp.service.ts:405-413`, which is the correct reference implementation already in this codebase).
- How to validate later: point `GOOGLE_GEOCODING_API_KEY`'s requests at a deliberately slow/unresponsive endpoint (e.g. via a local proxy with injected latency) in a non-production test and confirm the request now fails fast instead of hanging.

### BE-015 — SMTP email send has no explicit timeout and is awaited inline in the forgot-password OTP flow (Medium, Confirmed)
- Files: `src/services/email.service.ts:12-19` (`sendMail` — plain `nodemailer.createTransport(SITE_SETTINGS.email).sendMail(...)`), config at `src/utils/config.ts:2-12` (host/port/auth/tls only — no `connectionTimeout`/`greetingTimeout`/`socketTimeout` override), call chain `src/services/otp.service.ts:52-72` (`sendOtpEmail`, `await this.emailService.sendMail(mailOptions)`) ← `src/controllers/auth.controller.ts:542` (`await this.otpService.sendOtpEmail(user.email!, otp)`).
- Nodemailer's own defaults (connection timeout ~2 min, greeting timeout ~30s, socket timeout ~10 min) mean this is not strictly unbounded, but a 10-minute worst case is still far beyond acceptable for an HTTP request a user is waiting on, and there's no override tuning it down for this specific fast, user-facing OTP path.
- Severity: Medium (bounded, but by a default an order of magnitude too long for the use case; WhatsApp OTP delivery at `otp.service.ts:30-49` is the primary channel and already has a proper 10s timeout via `whatsapp.service.ts`, so email OTP is the secondary/fallback path — reduces real-world exposure somewhat). Confidence: Confirmed for the missing explicit timeout; Confirmed for nodemailer's documented defaults (not independently re-verified against the installed nodemailer version's source in this pass).
- Recommendation: set an explicit `connectionTimeout`/`socketTimeout` (e.g. 10-15s) in `utils/config.ts`'s `email` block, matching the WhatsApp service's 10s convention.
- How to validate later: point `EMAIL_HOST` at a non-routable address in a test environment and time how long `sendOtpEmail` takes to fail.

### BE-016 — Razorpay SDK client has no explicit timeout configured (Needs validation)
- File: `src/services/razorpay.service.ts:82-90` — `new Razorpay({key_id: ..., key_secret: ...})`, no `timeout` or custom `axios`/`http` config passed.
- The official `razorpay` Node SDK does not document a configurable per-call timeout in its constructor options in the version patterns typically seen in this kind of integration; whether it inherits any default from its internal HTTP client was not independently verified in this pass (no network access / package internals were not read).
- Severity: unclear without reading the installed SDK's internals — **flag for follow-up**, not asserted as a confirmed defect.
- Confidence: Needs validation.
- How to validate later: read `node_modules/razorpay`'s HTTP client code (or its version's changelog/docs) for its default timeout behavior, or capture a `createOrder`/`paymentLink.create` call against a deliberately slow mock endpoint and measure how long it takes to fail.

### BE-017 — Unbounded `Promise.all` fan-out over a client-controllable list size (reiterating BE-005/BE-006 from the concurrency angle)
- `approval.controller.ts:604,633` and `sales-return.controller.ts:1002-1003` both do `Promise.all(<unbounded-or-page-after-the-fact list>.map(async row => <2-5 sequential DB calls>))`. For `approval.controller.ts` specifically (BE-005), the list being mapped is the **full unbounded query result**, not a page — so the `Promise.all` width itself is attacker/caller-controllable simply by having a large matching table and omitting `limit`. This is the same underlying code as BE-005; listed here again only to call out explicitly that it is also a *concurrency* (unbounded parallel DB fan-out) issue, not only a pagination issue — fixing the pagination (BE-005) also fixes this.

---

## E. Error handling and logging

### Console logging density and sensitive-data exposure — largely clean (positive finding, with one caveat)
- `console.(log|error|warn)` appears 149 times across 24 files; the large majority are in one-off seed/migration scripts (`seed-*.ts`, `migrate.ts`, `repair-legacy-reprocess.ts`) that are not part of the running request-handling surface. Within `src/controllers` and `src/services`, usage is sparse (single digits per file: `system-notification.service.ts` 15, `approval.service.ts` 7, `whatsapp.service.ts` 5, `notification.service.ts` 6, most controllers 1-2) and, where sampled, consists of plain error-path messages (`console.error('Failed to notify super admin for created order:', err)` — `order.controller.ts:420`; `console.error('[WhatsAppService] Template ... rejected; HTTP ...')` — `whatsapp.service.ts:439-445`).
- Targeted search for `console.*` calls logging tokens/passwords/OTP/CVV/card/secret/authorization found **no matches** anywhere in `src/`.
- Caveat: this was a pattern-based grep sweep (keyword + `req.body`/`JSON.stringify` heuristics), not a line-by-line read of all 149 occurrences — treat as **Strong indication**, not exhaustively Confirmed, that no sensitive-data logging exists outside the sampled files.
- No finding requiring action.

### BE-018 — No request correlation/trace ID anywhere in the stack (Medium, Confirmed)
- `src/sequence.ts:1-3` is the stock LoopBack `MiddlewareSequence` with no override:
  ```
  export class MySequence extends MiddlewareSequence {}
  ```
  `src/interceptors/` contains only `authorize.interceptor.ts` and `unique-constraint.interceptor.ts` — neither injects or logs a request/correlation ID. A grep for `requestId`/`correlationId`/`traceId`/`x-request-id` across `src/` matched only **domain-model** fields (e.g. `ApprovalRequest`'s own `id`, referred to as "requestId" in comments) — not an HTTP-level trace ID concept.
- Why this matters operationally: the many scattered `console.error(...)` calls throughout controllers/services (area E above) have no way to be correlated back to a single originating HTTP request, user, or store once concurrency increases (PM2 cluster mode, per BE's positive D finding, now runs 2+ processes — log lines from the same logical request can even be interleaved across instances with no shared identifier). This makes production incident diagnosis materially harder exactly in the high-concurrency scenarios the rest of this audit is about.
- Severity: Medium (doesn't cause an outage by itself, but degrades the ability to diagnose every other finding in this report once deployed). Confidence: Confirmed (sequence/interceptor files read directly; grep for trace-id concepts came back empty).
- Recommendation: add a lightweight request-ID middleware (generate or pass through `x-request-id`), bind it into a per-request logging context (or at minimum prefix it onto the existing `console.error` calls), and consider a structured logger (pino/winston) instead of bare `console.*` now that there's a concrete multi-instance (PM2 cluster) deployment to correlate across.
- Dependencies/risk: pure addition, low risk; does not require touching existing business logic.

### BE-014/BE-015/BE-016 (cross-referenced from D) — external-call timeout/failure handling
- Already detailed above under D because the manifestation is a concurrency/hang risk; restated here since the audit brief places "timeout and failure handling for external calls" under E too:
  - Razorpay: `client.payments.fetch(...)` (`razorpay.service.ts:321`) and order/payment-link creation (lines 82-90, 218+) have no explicit timeout (BE-016, Needs validation).
  - WhatsApp: **correctly** configured — `timeout: 10000, maxRedirects: 0, validateStatus: () => true` (`whatsapp.service.ts:405-412`) and dispatched via the fire-and-forget `dispatchWhatsApp()` helper (lines 92-101) rather than inline in the request path for most notification flows — this is the reference pattern other integrations in this codebase should follow. **No finding.**
  - Google Geocoding: no timeout, inline/awaited in request path (BE-014, High, Confirmed).
  - SMTP (email OTP fallback): no explicit timeout override, inline/awaited (BE-015, Medium, Confirmed).

---

## Summary table

| ID | Area | File:Line | Severity | Confidence |
|---|---|---|---|---|
| BE-001 | A | garment.controller.ts:373-411 | Low | Confirmed |
| BE-002 | B | transfer.controller.ts:899-937 | Critical | Confirmed |
| BE-003 | B | delivery.controller.ts:65-93 | High | Confirmed |
| BE-004 | B | reports.service.ts (multiple builders) | High | Confirmed |
| BE-005 | B/D | approval.controller.ts:542-645 | Critical/High | Confirmed |
| BE-006 | B | sales-return.controller.ts:901-981 | High | Confirmed |
| BE-007 | B | order.service.ts:5223-5690 (reference impl, no action) | — | — |
| BE-008 | C | order.service.ts:610-699,1731-1769,3686-3690 | Critical | Confirmed |
| BE-009 | C | media.service.ts:14-18 | Low/Medium | Confirmed |
| BE-010 | C | process.service.ts:2015-2019 | Low | Confirmed |
| BE-011 | C | order.service.ts:4401-4405 | Medium | Strong indication |
| BE-012 | C | transaction boundaries (no finding) | — | Strong indication |
| BE-013 | C | dashboard.service.ts:457-507,593-629 | Medium | Confirmed |
| BE-014 | D/E | geocoding.service.ts:61-81 | High | Confirmed |
| BE-015 | D/E | email.service.ts:12-19, otp.service.ts:52-72 | Medium | Confirmed |
| BE-016 | D/E | razorpay.service.ts:82-90,321 | Unclear | Needs validation |
| BE-017 | D | approval.controller.ts / sales-return.controller.ts (same as BE-005/006) | — | — |
| BE-018 | E | sequence.ts:1-3, interceptors/ | Medium | Confirmed |
| — | D | pressto.datasource.ts, ecosystem.config.js | Positive finding — no action | Confirmed |
| — | E | console.* logging sweep | Positive finding — no action | Strong indication |
