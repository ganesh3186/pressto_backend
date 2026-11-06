# Completed backend priority points — detailed report

Prepared: 4 November 2026.

Scope: the latest **22 agreed backend priority points**, including the admin changes required to keep their API consumers working. This count excludes earlier frontend P1/P2/P3 work and fixes already received from `main`.

## Completion count

| Status | Count | Meaning |
|---|---:|---|
| Implemented locally | **21** | Code changes for the agreed point are present; deployment and staging acceptance remain pending. |
| Partially complete across the full audit finding | **1** | BE-017: the agreed large-ID-list paths are fixed, but the broader risky-query inventory is still open. |
| Agreed points with implementation work present | **22** | The 21 above plus the targeted BE-017 fixes. |
| Deferred policy/confirmation points | **18** | Outside this implementation batch. |

“Done” below means **local implementation**, not production deployment or proof of production capacity. Current backend and admin changes remain in the working trees and were not committed or pushed by this work.

## 1. Replace large application-built ID lists — BE-017

**Status: targeted paths implemented; broader finding partially complete.**

**Problem / why:** Some searches first fetched many related IDs into Node.js and then sent them back to PostgreSQL in an `IN` condition. With large datasets, this increases memory, SQL parameters and database work, and can exceed PostgreSQL's bind-parameter limit.

**What changed:** Customer phone/label filtering, rider phone search, wallet ledger filters, approval/sales-return visibility and dashboard aggregates now use SQL predicates, joins or `EXISTS` instead of large intermediate ID arrays. Transfer bag counts are grouped in SQL. Query values remain parameterized.

**Main files:** `src/controllers/customer.controller.ts`, `rider.controller.ts`, `approval.controller.ts`, `sales-return.controller.ts`, `transfer.controller.ts`; `src/services/wallet.service.ts`, `dashboard.service.ts`; `src/utils/sql-page.ts`.

**Effect:** These screens keep their existing scope and response fields while avoiding the identified ID-list materialization. A small bounded page-ID query used for hydration remains intentional.

**Wider review, closed 4 Nov:** a script traced every one of the 473 non-test `inq`/`nin` uses back to its source:

| Source of the ID list | Count | Verdict |
|---|---:|---|
| Literal arrays or enum constants | 49 | Fixed size |
| Request input or values already in memory | 125 | Bounded by the request |
| An earlier query's result | 280 | Reviewed one by one |

Of those 280, about 260 are bounded by a parent row (one order's items, one transfer's bags, one rider's pending cash), an already-paged result, or a short window such as one shift or one store-day. The rest grew with history and are fixed:

- **Lifetime store or system lists, now SQL joins:**
  - Cash available for a refund payout (`availableCashForOrder`): the store's lifetime orders.
  - Transfer-granted order visibility (`transferGrantedOrderIds`): every transfer ever sent to the store. Used by the order list, approvals, garments and invoices.
  - Transfer Send Out visiting garments: every received or resolved transfer.
  - Transfer Custody Report: every transfer in scope. This also fixes its combined `{gte, lte}` date filter.
  - Rider app customer search: every user whose phone contains the search term.
- **Per-customer or wide-window lists, now chunked with `findInBatches` or counted in SQL:**
  - Customer billing: Club & Pay pending invoices, billable on-account tickets, on-account invoice history, and the POS summary pending balance.
  - The on-account limit check during order creation.
  - Daily Sales report: payments, revenue links and revenue orders.
  - Dashboard: order stats garment count, now a SQL count, and dispatched-delivery stops.

All new SQL plans against the real schema. Tests are in `src/__tests__/priority-be017-lists.unit.ts`.

## 2. Transfer list backend pagination — BE-002

**Status: implemented locally.**

**Problem / why:** Loading every transfer before displaying a page wastes work and grows slower as records increase.

**What changed:** `/transfers` accepts bounded `limit`, `skip` and `page`, queries the requested database page and returns the full filtered count. Filters apply before count/page selection. Added an authenticated, scoped exact lookup for transit/bag scans. Excel export fetches all matching records in batches independently of the table page.

**Main files:** `src/controllers/transfer.controller.ts`, `src/utils/sql-page.ts`; admin `src/api/transfer.js`, `src/sections/transfer/transfer-all-view.js`, `src/api/paged-collection.js`.

**Effect:** All Transfers uses server rows/count rather than slicing the full list. Receiving/detail scans use the lookup API. Legacy selectors load bounded pages sequentially to retain all eligible options.

## 3. Approval list SQL pagination — BE-005

**Status: implemented locally.**

**Problem / why:** Loading and enriching all approval records before selecting a page makes approval screens expensive.

**What changed:** Filters and existing order/store/transfer visibility run in SQL before counting and selecting IDs. Only the selected approval page is hydrated and enriched. Default page size is 100; the requested maximum is 500.

**Main files:** `src/controllers/approval.controller.ts`, `src/utils/sql-page.ts`; admin `src/api/approval.js`, `src/api/paged-collection.js`.

**Effect:** Finance/Inspection Approvals and ticket/invoice approval consumers retain their response data. Existing consumers that need all options explicitly load successive pages.

## 4. Batch order-creation pricing lookups — BE-008

**Status: implemented locally.**

**Problem / why:** Repeating service mapping, coupon and store hierarchy queries for every service multiplies database calls during ticket creation.

**What changed:** `preparePricing()` builds a request-local pricing snapshot from bulk mappings/coupon records and one store/cluster/region lookup chain. `resolvePricing()` reuses it for primary and additional services. Existing pricing callers outside creation retain their original path.

**Main file:** `src/services/order.service.ts`.

**Effect:** Preserves the coupon → store → cluster → region → base pricing order, coupon dates/targeting and additional-service price validation. Prices are not cached across requests.

## 5. Delivery list backend pagination — BE-003

**Status: implemented locally.**

**Problem / why:** Returning all delivery runs creates unnecessarily large responses and enrichment work.

**What changed:** `/deliveries` queries a bounded database page and returns the complete matching count. Date bounds are separate conditions. Admin consumers needing the complete run list fetch sequential pages.

**Main files:** `src/controllers/delivery.controller.ts`; admin `src/api/delivery.js`, `src/api/paged-collection.js`.

**Effect:** Delivery-run selectors retain all options. Ticket-based Delivery Management continues using its existing order-list API.

**Audit correction (4 Nov):** the admin delivery *detail* fetcher had also been switched to the paged-list helper, which drops `delivery`, `orders` and `custodyEvents` from `GET /deliveries/{id}`, so Rider Tracking's delivery job panel showed no orders. Restored to a plain fetch in admin `src/api/delivery.js`.

## 6. Sales-return backend pagination — BE-006

**Status: implemented locally.**

**Problem / why:** Fetching and previewing all sales returns before pagination makes credit-note approval listing expensive.

**What changed:** Store/transfer scope and filters apply in SQL before count/page selection. Related orders/customers/shifts and return previews are loaded only for that page.

**Main files:** `src/controllers/sales-return.controller.ts`, `src/utils/sql-page.ts`.

**Effect:** Finance Credit Note Approvals retains its response contract and scoped results. Credit-note approval/refund business rules were not changed by this pagination work.

## 7. Move remaining report paging and totals into SQL — BE-004

**Status: implemented locally for the six agreed report builders.**

**Problem / why:** Fetching all report rows and then slicing them in Node.js increases memory and latency. Totals must still cover every filtered record, not just the visible page.

**What changed:** Database count/aggregate/page selection for Pending Payments, Pending Tickets, On-account Billing, GST lines, Petty Cash events and Mode of Payment. Only selected sources are hydrated. GST preserves existing line-rounding behaviour; Petty Cash preserves opening/closing rows, finance events and running balances; Mode of Payment combines its ledger sources before paging.

**Main files:** `src/services/reports.service.ts`, `src/utils/petty-cash-report-sql.ts`, `src/utils/payment-report-sql.ts`.

**Effect:** Report counts and footer totals represent the full filtered result. Existing report/export contracts are retained. Sample before/after counts and totals matched; sample coverage is recorded below.

## 8. Replace dashboard lifetime ID fetches with aggregates — BE-013

**Status: implemented locally.**

**Problem / why:** Fetching lifetime order IDs just to count stock or sum money performs unnecessary application/database transfers.

**What changed:** SQL joins/counts for garment pipeline and inbound items; SQL sum for rider-held cash.

**Main file:** `src/services/dashboard.service.ts`.

**Effect:** Dashboard cards retain older outstanding garments and money. A today-only cutoff was not applied because it would omit valid outstanding work.

## 9. Bound geocoding requests — BE-014 / ARC-016

**Status: implemented locally.**

**Problem / why:** A stalled external geocoding request could keep a backend request waiting indefinitely.

**What changed:** An eight-second total deadline destroys the stalled HTTPS request. Timers are cleared on completion/error, and the existing best-effort `null` fallback remains.

**Main file:** `src/services/geocoding.service.ts`.

**Effect:** Address/pickup callers receive their existing fallback outcome when geocoding fails or times out.

## 10. Correct Manage Invoices end-date filtering

**Status: implemented locally.**

**Problem / why:** The connector could apply only one operator from a combined `createdAt: {gte, lte}` condition, ignoring the upper date bound.

**What changed:** Lower and upper bounds are separate `and` conditions in the shared invoice filter builder.

**Main file:** `src/controllers/invoice.controller.ts`.

**Effect:** Manage Invoices listing and its count both apply the supplied start/end bounds.

**Same bug elsewhere, fixed 4 Nov:** Deliveries, Transfers (list and export), Rider Attendance (`GET /riders/{id}/attendance` and the rider's own history) and the Transfer Custody Report now apply both bounds. A date-only end date covers the whole day. A repo-wide search, including multi-line spread forms, finds no remaining combined range.

## 11. Make admin wallet/deposit top-ups transactional

**Status: implemented locally.**

**Problem / why:** Creating a successful recharge/top-up request before crediting the account could leave a success entry even when the credit failed.

**What changed:** Request creation, balance credit and ledger writes share one transaction. The account row is locked during request-number allocation. Wallet WhatsApp dispatch follows commit.

**Main files:** `src/services/wallet.service.ts`, `src/services/security-deposit.service.ts`.

**Effect:** A failed credit rolls back its request and ledger changes. Wallet and security-deposit UI forms retain their flow. Historical balance reconciliation is a separate deferred task.

## 12. Prevent duplicate order creation on retries — ARC-026b

**Status: implemented locally; additive deployment migration required.**

**Problem / why:** Retrying after an uncertain network response or submitting concurrently could create duplicate tickets and payments.

**What changed:** Optional `Idempotency-Key` header; actor-scoped hashed key; payload fingerprint; transactional advisory lock; persisted successful response. Matching retries return the saved result; a reused key with a different payload receives a conflict. Pending cheque/PDC approval requests now share the creation transaction. Replays skip duplicate notifications.

**Admin change:** Shares an in-flight submission and retains its retry key after failure within the current application session. Successful completion clears that attempt so a later intentional order can use a new key. Persistence across browser reloads is not implemented.

**Main files:** `src/services/order.service.ts`, `src/controllers/order.controller.ts`, `scripts/add-order-creation-requests.cjs`, `package.json`; admin `src/api/order.js`, `src/api/order-create-request.js`.

**Effect:** Clients sending the key gain retry protection. Older clients without the header remain compatible and do not receive that protection automatically.

**Audit correction (4 Nov):** the admin now sends the key on every order, so before this fix a backend without the `order_creation_request` table failed **every** order creation. If the table is missing (PostgreSQL `42P01`), the backend now logs `order_idempotency_table_missing` and creates the order without retry protection; other database errors still fail. The migration also adds a `created_at` index and accepts `--prune-days=N` to delete old retry records. Still run `npm run migrate:order-idempotency` before deploying; it is not part of `npm run migrate`.

## 13. Make ordinary order-status changes transactional — ARC-005

**Status: implemented locally.**

**Problem / why:** Concurrent status changes could validate an outdated state or leave status/history writes inconsistent.

**What changed:** Lock and re-read the order inside a transaction, revalidate the transition, and write status/history together. Delivered cascades execute only for a Delivered transition. Notifications follow commit.

**Main file:** `src/services/order.service.ts`.

**Effect:** A conflicting concurrent transition receives a conflict instead of overwriting a newer state. Existing special handover paths retain their own handling.

## 14. Make delivery cancellation transactional — ARC-006

**Status: implemented locally.**

**Problem / why:** A cancellation failure could otherwise leave delivery, order assignments, bags and custody records partially changed.

**What changed:** Lock the delivery and affected orders, re-read state, and perform related cancellation writes in one transaction. Rider notification follows commit.

**Main file:** `src/controllers/delivery.controller.ts`.

**Effect:** Related cancellation changes commit or roll back together. Multi-user acceptance testing remains required before deployment.

**Audit correction (4 Nov):** the bag release and the cancelled custody event were still written outside the transaction, so a failed custody insert left the bag released while the delivery rolled back. Both writes now join the transaction.

## 15. Hide model-level user secrets — ARC-019

**Status: implemented locally.**

**Problem / why:** Serializing a Users model could expose password hashes or OTP fields if a caller forgot an explicit field selection.

**What changed:** Added `hiddenProperties` for `password`, `loginOtp`, `loginOtpExpires`, `resetPasswordOtp` and `resetPasswordOtpExpires`.

**Main file:** `src/models/users.model.ts`.

**Effect:** Users model JSON serialization omits these fields while internal authentication can still read them. Plain object spreads still need explicit safe fields. The separate login OTP fallback response requested by the business remains unchanged.

## 16. Add request IDs and structured HTTP logs — BE-018 / INF-009

**Status: implemented locally.**

**Problem / why:** It was difficult to identify and correlate slow or failed HTTP requests in server logs.

**What changed:** Validate a supplied request ID or generate a UUID, return `X-Request-ID`, bind it to the request context, and log completion as JSON with method, route template, status and duration.

**Main file:** `src/sequence.ts`.

**Effect:** Operations can correlate a response with a timing/status log. Only this completion line carries the request ID; other log lines do not yet. The log call is guarded so a logging failure cannot become an uncaught exception. This addition does not log bodies, query strings or credentials. It is operational HTTP logging; the proposed business Audit Logs screen remains a separate task.

## 17. Bound SMTP and handle reset-email failures — BE-015 / ARC-027

**Status: implemented locally.**

**Problem / why:** A slow SMTP connection could leave Forgot Password waiting, and a provider error could leak through the request.

**What changed:** SMTP connection/greeting timeouts of 10 seconds and socket timeout of 15 seconds. Reset-email errors are caught and logged without the email address or OTP; the documented generic response is retained.

**Main files:** `src/utils/config.ts`, `src/controllers/auth.controller.ts`.

**Effect:** Forgot Password has bounded SMTP waits and controlled failure handling. A generic response does not guarantee that an email was delivered.

## 18. Batch garment status writes — BE-011

**Status: implemented locally.**

**Problem / why:** Updating garment status and inserting history one garment at a time creates many sequential database calls.

**What changed:**
- **Counter inspection (the loop BE-011 names):** `stepGarmentForward` was called once per garment, with an update and a history insert per hop. It is replaced by `stepGarmentsForward`, which does one status update for all moved garments and one bulk history insert (both in batches of up to 500). It still writes one history row per hop and skips held, damaged and returned garments. Used by Complete Counter Inspection and Mark Units Inspected. A unit listed twice is now moved once instead of getting duplicate history.
- **Delivered cascade:** bounded batches of up to 500 garment status updates and `createAll` history inserts inside the existing transaction.

**Main file:** `src/services/order.service.ts`.

**Effect:** Each moved or delivered garment still receives its history, and the existing exclusions remain. A history-write failure in the delivered cascade rolls back the transaction. Counter inspection was not transactional before and still is not.

**Audit correction (4 Nov):** the first version only batched the delivered cascade. The counter-inspection loop that BE-011 actually names was still sequential until this fix.

## 19. Prevent concurrent shift-close overwrites — ARC-012

**Status: implemented locally.**

**Problem / why:** Two close requests could both pass an initial Open check and overwrite closing information.

**What changed:** Final update requires both the shift ID and `status: Open`; a request that updates no row receives a conflict.

**Main file:** `src/controllers/shift.controller.ts`.

**Effect:** A second concurrent close cannot overwrite the winning close's employee/totals. Existing close validations remain.

## 20. Batch media-used updates — BE-009

**Status: implemented locally.**

**Problem / why:** Repeated media IDs and per-record updates add avoidable database calls.

**What changed:** Deduplicate IDs and update `isUsed` through bounded `updateAll` batches of up to 500.

**Main file:** `src/services/media.service.ts`.

**Effect:** Photo/media forms keep their existing payload while requiring fewer update calls.

## 21. Batch process-log writes — BE-010

**Status: implemented locally.**

**Problem / why:** Creating initial process logs and completing remaining steps through individual calls grows expensive with more steps/items.

**What changed:** Bulk creation for initial/automatic logs and grouped bounded updates for remaining steps, separating already-started steps from unstarted ones.

**Main file:** `src/services/process.service.ts`.

**Effect:** Existing start timestamps and users are preserved for started steps; newly started steps receive their required start data.

## 22. Treat search punctuation literally

**Status: implemented locally in the updated search paths.**

**Problem / why:** Search text containing parentheses and other special characters could be interpreted as a regular expression, causing warnings or unintended matching.

**What changed:** Shared `literalContains()` escaping for regex/LIKE punctuation in the changed substring-search paths. Native SQL values remain parameterized.

**Main files:** `src/utils/search-pattern.ts`, `src/controllers/employee.controller.ts`, `rider-pickup.controller.ts`, `customer.controller.ts`, and `src/services/wallet.service.ts`.

**Effect:** Entered punctuation is treated as search text in these paths. This is not a repository-wide replacement of every search implementation.

## Verification already completed

These results are from the implementation validation on **3 November 2026**. This report was prepared on 4 November; documentation preparation did not rerun or deploy the application.

| Check | Result |
|---|---|
| Backend build | Passed |
| Backend regression suite, including opt-in PostgreSQL fixtures | **534 tests passed** (545 after the 4 Nov audit fixes) |
| Admin production build | Passed, with existing source-map/Browserslist/bundle-size warnings |
| Admin regression suite | **216 tests passed across 58 suites**; one existing print suite cannot start due to Axios/Jest ESM compatibility |
| Targeted lint | Changed backend lines/new TS files and changed admin files passed; existing backend-wide lint debt remains |
| Read-only database smoke checks | Nine passed: customer search, rider search, wallet filtering, scoped approvals, scoped sales returns, transfer page/lookup, delivery page, dashboard stock and rider cash |
| Before/after report comparison | Sampled store/month counts and totals matched |

Sample report comparison: Pending Payments **547**, Pending Tickets **172**, GST lines **1,297**, Petty Cash events **117**, Mode of Payment entries **551**, and empty On-account result handling. GST rounding and Petty Cash description totals were checked. This sample does not establish correctness for every historical data combination.

Additional supporting work updated existing test fixtures for the SQL changes and added regression coverage for pagination/export, retry replay/mismatch, pricing batching, transactional rollback and secret serialization. These test-maintenance changes are not counted as another business point.

## Senior audit — 4 November

All 22 points were rechecked against the code diff, not only this report.

**Fixed during the audit:** points 5 (admin delivery detail), 12 (missing-table fallback, prune option), 14 (bag and custody writes outside the transaction) and 18 (the counter-inspection loop BE-011 names). Point 16 also got a guard on its log call.

**Rechecked and confirmed as described:**
- Approval and sales-return SQL scope matches the old in-memory filters for all four entity types, including transfer grants.
- The pricing snapshot applies the same coupon date, geography, label and cheapest-price rules as `resolveCouponOverridePrice`.
- Report SQL matches the old JavaScript for payment status, rounding, refund exclusion, label, delivery and customer-name filters, and Mode of Payment row identities.
- Admin top-ups and deposits join the caller's transaction and lock the account row.
- Order status changes lock, re-validate and notify after commit.
- Cheque/PDC approvals are created inside the order transaction.
- Shift close, media and process-log batching match the report.

**Schema check:** the PostgreSQL fixture tests replace `uuid` with `text` in temporary tables, so they cannot catch type mismatches. All 16 new SQL statements were therefore also planned (`EXPLAIN`, read-only, no rows touched) against the real local schema. All 16 passed.

**Test results after the fixes:**
- Backend: **540 passing**, 0 failing, with `RUN_PG_FIXTURE_TESTS=true`. This is 534 plus 6 new tests in `src/__tests__/priority-audit-fixes.unit.ts`. Without that variable, 8 fixture tests are skipped.
- Admin: 216 passing; the existing print suite still cannot start.
- `tsc` passes in the backend.

**Known behaviour changes to tell testers:**
- `/transfers`, `/deliveries`, `/approval-requests` and `/sales-returns` return 100 rows when no limit is sent and reject a limit above 500. The non-hook `getApprovalRequests` therefore returns at most 100, which is fine for its current lookups by `entityId`.
- Reports now use the latest delivery stop per ticket instead of an arbitrary one.
- A missing media ID no longer raises an error.

**Closed afterwards (4 Nov):**
- The rider attendance date filter. See point 10.
- The wider BE-017 review. See point 1.
- The work is committed on the `priority-points` branch in both repos (not pushed).

The backend now has **545 passing** tests, 0 failing, with fixtures on.

## Required deployment steps

From the backend folder, before running the updated order-creation flow:

```powershell
npm run migrate:order-idempotency
npm run build
```

The additive migration creates `public.order_creation_request` for retry fingerprints/responses. It was applied only to the local `pressto` database. Deploy the matching admin build and restart the backend through the normal deployment process. This batch requires no new env variables, dependencies or seed command.

## Acceptance still pending

- Staging checks with store, cluster and global logins for paging, totals, exports and scan lookup.
- Business-flow testing for pricing, cheque/PDC approvals, wallet/deposit failure, status changes, cancellation and shift closing.
- Simultaneous request/retry testing and multi-store load measurements.
- Load measurement for the BE-017 changes (customer billing for a large on-account customer, Daily Sales over a month of all stores, Custody Report).
- The 18 previously deferred policy/verification points, including the requested disabled-WhatsApp OTP fallback behaviour.

Related files: [implementation summary](BACKEND_PRIORITY_IMPLEMENTATION_REPORT.md) and [backend checklist](checklists/CHECKLIST_BACKEND.md).
