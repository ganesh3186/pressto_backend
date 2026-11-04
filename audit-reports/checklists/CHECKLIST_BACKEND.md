# Backend Checklist

**Repo:** `pressto_backend`. **Source:** `backend-audit.md`, `architecture-security-audit.md`, `SERVER_INCIDENT_AUDIT.md`.
**Priorities:** P0 = do first, before the next go-live. P1 = high impact. P2 = medium. P3 = low.
**Status:** findings were read from code at commit `43209a1`, which includes the Nov 1 performance fixes. Confirm each is still open before starting it. All of these deploy with a backend reload.

## Nov 3 implementation update

The agreed 22 technical changes are detailed in [the implementation report](../BACKEND_PRIORITY_IMPLEMENTATION_REPORT.md). Checked local implementation items are not a deployment claim. The 18 policy/verification items remain deferred, including the existing disabled-WhatsApp OTP response. BE-017 is closed locally after the full inventory review on 4 Nov.

## P0: Security

- [x] **Lock down `FileUploadController`.** Require JWT on upload, remove the list routes and `POST /files/{processId}`, and block customer document folders on the public file routes. Single-file image GETs stay public because `<img>` tags can't send a JWT. **Status: on `main` (`c0bab14`). Live on migration, staging and production since Nov 2. Still to verify with real logins, including rider app punch-in.** `ARC-020`
- [x] **Remove the password hash and OTP fields from `GET /riders`, `GET /riders/{id}` and the `POST /riders` response.** **Status: on `main` (`e25f3e0`). Live on migration, staging and production since Nov 2. Still to verify the rider list, edit and add screens with a real login.** `ARC-018`
- [x] **Add the store filter to `GET /invoices` and `/invoices/count`.** They returned every store's invoices. **Status: on `main` (`e655a31`). Live on migration, staging and production since Nov 2, with the index created on all three. Still to verify Manage Invoices with store, cluster, region and all-stores logins.** `ARC-022b`
- [x] **Add the store-visibility check to the order routes that skip it.** The audit listed 5 routes; 5 more were found while fixing it (`POST` handover, delivery-return and split, `DELETE /orders/{id}`, `GET` wallet-full-payment-preview). **Status: on `main` (`56e6dc1`, `c30f8b8`). Live on migration, staging and production since Nov 2. Still to verify order details, payments, handover, split, delivery return and cancel with store, cluster, region and all-stores logins.** `ARC-023`

## P0: Money and data correctness

- [ ] **Make wallet credit/debit atomic** with a row lock or conditional update. **Status: on `main` (`bec4c20`), not deployed. Covers recharges, admin debits and a double-credit race in `confirmRecharge`. SQL validated against the real tables on migration and production (read-only plan, no writes). Next: test on migration before any deploy.** `ARC-008`
- [ ] **Move the checkout wallet balance read inside the transaction.** **Status: on `main` (`1ff822c`), not deployed. Order creation, `addPayment` and approval refunds now use the same atomic update as `ARC-008`. Next: test wallet payments and refunds on migration before any deploy.** `ARC-009`
- [ ] **Make security deposit add/deduct atomic.** **Status: on `main` (`8c6c275`), not deployed. Also fixes a double-credit race in `confirmTopup`. `deductAmount` has no callers today, so the live risk is lost or doubled top-ups. SQL validated against the real tables on migration and production (read-only plan, no writes). Next: test top-ups on migration before any deploy.** `ARC-010`
- [ ] **Close the shift-open race.** **Status: on `main` (`b8ba4f9`), not deployed. Uses a per-store advisory lock in `open()`, so no schema change. No store has duplicate open shifts on production or migration (checked Nov 3). Next: test opening a shift on migration before any deploy.** `ARC-011`

## P0: Performance under staff load

- [x] **Commit and deploy the `GET /shifts/{id}/collected` fix.** Done in `b601200` on `main`, and the deployed live code contains it. `workaround.md` records the live crash at 7,016 parameters.
- [x] **Find and fix other Node-built `IN` lists.** The oversized `bind message` errors on Nov 1 came from this pattern; order and employee search are already fixed. **Status: implemented locally on `priority-points`, not deployed. All 473 non-test `inq`/`nin` uses were traced to their source. The ones that grow with history now use SQL joins or chunked lookups: refund cash, transfer grants, Send Out visiting garments, Custody Report, rider customer search, customer billing, on-account limit, Daily Sales, dashboard. Earlier fixes covered wallet, rider, customer, approval, sales-return and transfer lists, plus Manage Invoices on `main` (`8abad9c`, `03e1e30`). Details: `COMPLETED_BACKEND_PRIORITY_POINTS.md` point 1.** `BE-017`, `SERVER_INCIDENT_AUDIT.md`
 **Nov 3: agreed customer/rider/wallet/approval/transfer/dashboard paths updated locally. Broader candidate inventory remains open; see report.**
- [x] **Paginate `GET /transfers`.** `BE-002`
 **Implemented locally on Nov 3; staging validation/deployment pending. See implementation report.**
- [x] **Bound `GET /approval-requests`** and push paging into SQL. `BE-005`
 **Implemented locally on Nov 3; staging validation/deployment pending. See implementation report.**
- [x] **Batch pricing lookups in order creation.** Test carefully, because this is the core order path. `BE-008`
 **Implemented locally on Nov 3; staging validation/deployment pending. See implementation report.**

## P1

- [x] **Paginate `GET /deliveries`.** `BE-003`
 **Implemented locally on Nov 3; staging validation/deployment pending. See implementation report.**
- [x] **Paginate `GET /sales-returns`.** `BE-006`
 **Implemented locally on Nov 3; staging validation/deployment pending. See implementation report.**
- [x] **Push limit/skip into the report builders.** Some report queries were fixed Nov 1, so check which remain. `BE-004`
 **Implemented locally on Nov 3; staging validation/deployment pending. See implementation report.**
- [x] **Replace dashboard lifetime order-ID materialization with SQL aggregates.** Older outstanding stock/cash remains included. `BE-013` **Implemented locally on Nov 3; staging validation/deployment pending. See implementation report.**
- [x] **Add a timeout to `GeocodingService`'s `https.get`.** `BE-014`, `ARC-016`
 **Implemented locally on Nov 3; staging validation/deployment pending. See implementation report.**
- [ ] **Add brute-force protection and rate limits on login and OTP.** `ARC-002`, `ARC-017`
- [ ] **Stop returning the login OTP in the response** when `WHATSAPP_ENABLED=false`. `ARC-021`
- [ ] **Add a permission and store check to `GET /payments/gateway-links/{id}`.** `ARC-024`
- [ ] **Fast-forward `client-server` to `main`.** It was 19 commits behind before the Nov 2 merge. Deploying from it would remove the security fixes. Added after the audit.
- [ ] **Compare wallet balances with their ledgers,** read-only first. The `ARC-008` fix stops new errors but doesn't correct existing ones. Added after the audit.
- [x] **Fix the Manage Invoices "date to" filter.** With both dates set, `_buildInvoiceFilter` sends `createdAt: {gte, lte}`, and the connector reads only the first operator, so `dateTo` is ignored in the list and its total. Split it into two `and` clauses. Other routes may build ranges the same way, so check them too. Added after the audit.
 **Implemented locally on Nov 3; staging validation/deployment pending. See implementation report.**

## P2

- [x] **Put `adminRecharge` and `adminTopup` request creation and credit in one transaction.** A failed credit can leave a success request with no money added. Added after the audit.
 **Implemented locally on Nov 3; staging validation/deployment pending. See implementation report.**
- [x] **Update the unit tests broken by the Nov 1 SQL changes.** The 2 shift tests (`72bdeed`) and the 2 Manage Ticket invoice filter tests (`priority-points`) are fixed on `main`.
 **Implemented locally on Nov 3; staging validation/deployment pending. See implementation report.**
- [x] **Fix the `GET /shifts/collected` 500.** It falls into the `/shifts/{id}` route and fails with `invalid input syntax for type uuid: "collected"`. Seen in live logs after Nov 1 05:43. `SERVER_INCIDENT_AUDIT.md` **Implemented locally on 4 Nov; not deployed.** Shift routes now return 404 for an id that is not a UUID, before any query.
- [x] **Fix the 5xx on `GET /riders/availability-for-slot`** with a `fallback:` slot ID. Seen in the same logs. **Implemented locally on 4 Nov; not deployed.** `resolveSlotWindow` only looks up UUID slot ids; `fallback:<label>` uses the whole day. Covers Pickup, Dispatch and the Order Delivery dialog, plus pickup/order assignment.
- [ ] **Let the Manage Ticket payment filter cover all dates across stores.** It is limited to 90 days because it adds up payments for every order in scope (about 9 s for all stores on 2M orders). A stored paid total on orders would remove the limit. Added after the audit.
- [ ] **Read the DSR tax rate from the GST configuration.** It is fixed at 18% in `reports.service.ts`, while Sales GST reads the configured rate. Added after the audit.
- [x] **Add an idempotency key to order creation.** `ARC-026b`
 **Implemented locally on Nov 3; staging validation/deployment pending. See implementation report.**
- [x] **Add transactions to order status changes.** `ARC-005`
 **Implemented locally on Nov 3; staging validation/deployment pending. See implementation report.**
- [x] **Add a transaction to `DeliveryController.cancel`.** `ARC-006`
 **Implemented locally on Nov 3; staging validation/deployment pending. See implementation report.**
- [x] **Fix the webhook's payload-mismatch path** to meet its "always 200" intent. `ARC-014` **Implemented locally on 4 Nov; not deployed.** A signed payload that fails validation (4xx) or is not JSON is logged as `razorpay_webhook_unprocessed` and acknowledged with 200. Server faults (5xx) still fail so Razorpay retries.
- [ ] **Add a durable retry (outbox table) for WhatsApp and notifications.** `ARC-015`, `INF-012`
- [x] **Add a model-level `hidden` setting on `Users` secrets.** `ARC-019`
 **Implemented locally on Nov 3; staging validation/deployment pending. See implementation report.**
- [x] **Add request IDs and structured logs.** `BE-018`, `INF-009`
 **Implemented locally on Nov 3; staging validation/deployment pending. See implementation report.**
- [x] **Add an SMTP timeout and error handling to forgot-password.** `BE-015`, `ARC-027`
 **Implemented locally on Nov 3; staging validation/deployment pending. See implementation report.**
- [x] **Batch the garment status update loop.** `BE-011`
 **Implemented locally on Nov 3; staging validation/deployment pending. See implementation report.**
- [ ] **Decide how to handle roles baked into the JWT** (no live revalidation). `ARC-001`

## Needs validation first

- [ ] **Bag endpoints:** missing store filter and permission gate? `ARC-025`
- [ ] **Rider endpoints:** store and ownership scoping. `ARC-026`
- [ ] **Store scope coverage** across the remaining controllers. Do this sooner: `ARC-023` found 5 more unprotected routes than the audit listed. Include customer-billing routes. **Status: `generateOnAccountInvoice` and the consolidated invoice routes now check store scope on `main` (`f2c3c8d`), not deployed.** `ARC-004`
- [x] **`GarmentActionsController`:** read-then-act without a lock. `ARC-007` **Implemented locally on 4 Nov; not deployed.** Confirmed: return, upgrade, risk and damaged checked then created without a lock (reprocess already locked). They now take a per-garment `pg_try_advisory_xact_lock`; a simultaneous second action gets 409. Lock behaviour checked on two real connections.
- [ ] **WhatsApp dedup cache:** it is per-process, and production now runs 2 workers. `ARC-013`
- [x] **Razorpay client timeout.** `BE-016` **Implemented locally on 4 Nov; not deployed.** Confirmed: SDK 2.9.8 has no timeout option and its axios client defaults to none. Its client now has a 15s timeout.

## P3

- [x] **Shift `close()` check-then-act race** (lower impact). `ARC-012`
 **Implemented locally on Nov 3; staging validation/deployment pending. See implementation report.**
- [x] **Batch `MediaService.markUsed`.** `BE-009`
 **Implemented locally on Nov 3; staging validation/deployment pending. See implementation report.**
- [x] **Batch `ProcessService` log updates.** `BE-010`
 **Implemented locally on Nov 3; staging validation/deployment pending. See implementation report.**
- [x] **Remove the commented-out `isActive` check** or restore it. `ARC-022` **Implemented locally on 4 Nov; not deployed.** Restored (not removed): `verifyCredentials` is required by LoopBack's `UserService` interface. It has no callers; `/auth/login` already checks `isActive`.
- [x] **Remove or fix `generateShortToken`.** `ARC-003` **Implemented locally on 4 Nov; not deployed.** Removed; it had no callers.
- [ ] **Remove `api-live.out` and `api-live.err` from the repo** and ignore them. They were committed to `main` in `1497c21`. Added after the audit.
- [ ] **Remove the unused `buildOnAccountInvoiceRows`** from `reports.service.ts`. Mode of Payment no longer calls it. Added after the audit.
- [x] **Fix the `Auto-escaping invalid RegExp` warning** on search values such as `%Pune (REG001%`.
 **Implemented locally on Nov 3; staging validation/deployment pending. See implementation report.**

## No action needed

- `BE-007`: order list and details reviewed, no finding.
- `BE-012`: no long transactions wrapping external calls found.
