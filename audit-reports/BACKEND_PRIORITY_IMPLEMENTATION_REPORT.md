# Backend priority implementation report

Date: 3 November 2026. Branch: `priority-points` in backend and admin.

Scope: the 22 technical items agreed in chat. The 18 deferred policy/verification items remain deferred. In particular, `WHATSAPP_ENABLED=false` still returns the login OTP in its existing payload; no rate-limit, JWT-refresh, cross-store policy, notification outbox or provider retry change is included.

Status: local implementation and validation. Not committed, pushed or deployed by this work. Staging business-flow and multi-store concurrency validation remains required.

## Changes and UI impact

| # | Item | Implementation | UI / compatibility |
|---|---|---|---|
| 1 | Large ID lists / BE-017 | SQL predicates/joins replace customer phone/label ID materialization, rider phone IDs, wallet ledger customer/wallet allowlists, approval/sales-return store allowlists and dashboard lifetime order IDs. Transfer bag counts are grouped in SQL. | Existing fields and scope rules retained. This addresses the agreed list paths; it is not a claim that every `inq`/`nin` in the repository is unsafe or has been removed. The broader approximately 50-candidate inventory is not certified closed. |
| 2 | BE-002 Transfer pagination | Bounded list + full count; exact scoped transit/bag lookup; export batches independently. | All Transfers requests its page. Receiving/detail lookups use the lookup API. Existing full-list selectors load sequential bounded pages so eligible options are not silently lost. |
| 3 | BE-005 Approval pagination | Scope and filters run before SQL count/page; only selected records are enriched. Default 100; maximum requested page 500. | Finance/Inspection Approvals and invoice/ticket approval consumers retain records/counts. Existing consumers without pagination exhaust bounded pages. |
| 4 | BE-008 Pricing batching | Request-local mappings/coupon overrides and hierarchy snapshot during order creation. Coupon → store → cluster → region → base precedence is preserved. | Primary/additional service pricing and coupon eligibility retained. No shared cross-request price cache. Existing non-create callers retain their pricing path. |
| 5 | BE-003 Delivery pagination | Bounded database query and full count. | Existing delivery-run selectors load bounded pages sequentially. Ticket-based Delivery Management retains its own order-list API. |
| 6 | BE-006 Sales-return pagination | Database store/transfer scope, count and paging; preview only the page. | Finance Credit Note Approvals retains its totals and payload. |
| 7 | BE-004 Reports | SQL count/aggregate/page for Pending Payments, Pending Tickets, On-account Billing, GST lines, Petty Cash events and the combined Mode of Payment ledger. | Full-result footers and exports are separate from visible-page rows. GST uses the existing JavaScript-equivalent line rounding. Petty Cash preserves opening/closing, finance receipts and running balances. |
| 8 | BE-013 Dashboard | SQL garment stock counts and rider-held cash sum; SQL inbound item count. | Stock/outstanding balances retain older outstanding work; no incorrect today-only restriction. |
| 9 | BE-014 / ARC-016 Geocoding | Eight-second total deadline destroys a stalled request and uses the existing null fallback. | Existing address/pickup fallback preserved. |
| 10 | Invoice end date | Separate lower/upper date predicates. | Manage Invoices list and count both apply the end date. |
| 11 | Admin recharge/top-up | Request, balance adjustment and ledger share a transaction; account row locked during request-number allocation. Notification dispatched after wallet commit. | Wallet and security-deposit forms retain their flow. A failed credit leaves no success request. |
| 12 | ARC-026b Idempotency | Optional `Idempotency-Key`, actor-scoped key, request fingerprint, transactional advisory lock and persisted response. Pending cheque/PDC requests now share order creation's transaction. | Admin creation shares concurrent submissions; retries after uncertain failures reuse the key. A successful new submission gets a new key. Older clients without the header remain compatible. |
| 13 | ARC-005 Order status | Ordinary transitions lock/recheck the order and write status/history together; notification follows commit. | Conflicting concurrent transitions fail rather than overwrite one another. Delivered-only cascades remain Delivered-only. |
| 14 | ARC-006 Delivery cancellation | Delivery/order locks and one transaction cover cancellation, assignment clearing, bag release and custody history. | Rider notification remains after commit. |
| 15 | ARC-019 User secrets | `Users.hiddenProperties` protects password and OTP fields during model JSON serialization. | Internal authentication can still read properties. Existing explicit response allowlists remain important for plain object spreads. |
| 16 | BE-018 / INF-009 Logging | Validated/generated request ID, response header/context binding and structured HTTP completion log (route template/status/duration). | No request bodies, query strings or tokens logged by this addition. No audit-history UI is added. |
| 17 | BE-015 / ARC-027 SMTP | Connection/greeting/socket timeouts; reset-email failure is logged without the address/OTP and keeps the documented soft response. | Forgot Password does not hang or expose the provider failure. |
| 18 | BE-011 Garment batching | Delivered garment updates and per-garment history are written in bounded batches inside the existing transaction. | Damaged/held/returned pieces are excluded as before; histories retained. |
| 19 | ARC-012 Shift close | Conditional update of an Open shift; a second concurrent close receives a conflict. | Closing employee/totals cannot be overwritten by another close. |
| 20 | BE-009 Media batching | Deduplicated IDs, bounded `updateAll` batches. | Photo/media forms retain their payload. |
| 21 | BE-010 Process batching | Bulk initial logs; remaining-step updates grouped by whether already started. | Original start timestamps are retained; completion/history behaviour retained. |
| 22 | Search RegExp warning | Literal substring patterns escape RegExp/LIKE special characters; native SQL searches remain parameterized. | Parentheses and similar punctuation no longer become invalid RegExp patterns. |

## Database / deployment

The only new schema requirement from this change is the additive `order_creation_request` table. It stores actor-scoped retry keys, fingerprints and order-creation responses; it does not change historical orders or monetary balances.

Run from the backend directory **before deploying the updated backend/admin creation flow**:

```powershell
npm run migrate:order-idempotency
npm run build
```

The table was created in the local loopback-host `pressto` database only, behind a host/database guard. No staging/production migration was executed. No new dependencies, seed command or env parameter is required. Restart the deployed backend and deploy the corresponding admin build together. Prior invoice-index deployment requirements from main are separate.

## Validation

- Backend compile passes. Full backend suite: **534 passing**, including PostgreSQL temporary-table fixtures. Command: `RUN_PG_FIXTURE_TESTS=true node node_modules/@loopback/build/bin/run-mocha --allow-console-logs "dist/__tests__"` (set the environment variable with your shell syntax).
- PostgreSQL financial-report fixtures are opt-in with `RUN_PG_FIXTURE_TESTS=true`. They write only session-local temporary tables and roll back; no application rows are modified.
- Read-only smoke checks cover customer/rider search, wallet filtering, scoped approvals/returns, transfer/delivery lists and dashboard stock/cash.
- Before/after report comparisons use the previous report implementation against the same local data. One checked store/month: Pending Payments 547, Pending Tickets 172, GST lines 1,297, Petty Cash events 117 and Mode of Payment entries 551. Full counts/totals matched after preserving GST double-precision rounding; Petty Cash description totals matched too. This is sample evidence, not exhaustive production-data proof.
- Admin regression suite: **216 tests pass across 58 suites**; one existing print suite cannot start because of the Axios/Jest ESM issue below. New API helper tests pass.
- Admin production build passes with pre-existing QR source-map/Browserslist/bundle-size warnings. Existing Axios/Jest ESM failure in `taffeta-manage-order-print.test.js` is unrelated and remains separately tracked.
- Existing legacy files have repository-wide lint debt. Changed backend lines and new TypeScript files pass the targeted lint check. Changed admin files pass ESLint. Do not claim the entire backend lint suite is clean.

## Manual acceptance before deployment

1. Store/cluster/global logins: table filters, next page, totals, exports, and exact scanned transfer/bag lookup. Check eligible selectors beyond the first page.
2. Multi-item ticket: primary/additional services, store/cluster/region uplift, overlapping coupons, dimensions, draft/confirmation and cheque/PDC approvals.
3. Concurrent/retried creation: one ticket/payment/approval set, same-key payload mismatch conflict, subsequent intentional new ticket permitted.
4. Wallet/deposit credit failure: no success request without credit. Simultaneous status/close/cancel requests: one coherent outcome, histories retained.
5. Financial reports: compare totals and page boundaries across filters, refunds, On-account multi-store invoice shares, GST rounding and petty-cash shift boundaries.
6. Photo uploads/process completion, dashboard outstanding older tickets, Forgot Password timeout, and unchanged disabled-WhatsApp OTP fallback.

## Limits

- Legacy selectors still assemble a complete option list from bounded sequential requests. Search-on-demand selector redesign is a possible later UI improvement, not silently imposed here.
- No staging multi-store stress run, payment-provider call, real order creation or WhatsApp send was performed as part of read-only smoke validation.
- Broad-query exact counts still have a database cost. Index plans and production capacity need staging measurements; these changes are not a guarantee that all traffic-related incidents are resolved.
