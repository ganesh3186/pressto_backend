# Pressto Backend — Architecture, Security & Reliability Audit (Agent 5)

Scope: `D:\karans_code_lab\pressto\pressto_backend` (LoopBack 4 / TypeScript), cross-referenced against pressto-admin-panel / pressto-customer-web auth flows where relevant. Read-only audit — no files edited, no migrations run, no git state touched. `src/controllers/shift.controller.ts`'s pre-existing uncommitted diff (a `collected()`/closing-reconciliation performance fix touching `windowTransactions`/`findInBatches`, lines ~743-790) was inspected only to confirm it does **not** overlap with the shift-opening race finding below (ARC-011); it is not itself flagged.

Method note: this audit was conducted in two passes across parallel, independently-scoped investigations (one per topic area), followed by a verification pass that re-read the actual source for every claim that was new, surprising, or contradicted another pass's finding before merging it in (e.g. the file-upload controller's missing auth, the invoice/order cross-store leaks, the OTP-in-response fallback, and the migration-script safety-guard claims below were all independently re-confirmed by direct code read, and one over-claim — that two destructive scripts lack any confirmation guard — was corrected after checking the actual scripts, which do have `--yes`/`--apply` guards). Findings below are the merged, verified result; a couple of first-pass "no issue found" assessments were superseded by second-pass evidence and are noted inline where that happened.

Each finding: ID, workflow/file/function, evidence, concrete failure scenario, severity, confidence, recommendation, dependencies/risks, how to validate later.

---

## 1. Authentication & Authorization

### ARC-001 — Roles/permissions baked into the JWT at login; no live revalidation
**Files:** `src/services/jwt-service.ts` (`verifyToken`, lines 64-96), `src/interceptors/authorize.interceptor.ts` (lines 29-79), `src/controllers/auth.controller.ts` (`login`, lines 147-303).

**Evidence:** `JWTService.verifyToken` decodes `roles`/`permissions`/`storeScope` straight from the JWT payload (lines 80-87) and returns them as the `UserProfile`. `AuthorizeInterceptor.intercept` (lines 51-76) authorizes purely against `currentUser.roles`/`currentUser.permissions` — both sourced from that decoded token, never re-fetched from the DB. `RbacService` (the service that resolves a role's live permission set) is only ever injected into `AuthController` (confirmed by codebase-wide grep: its only usages are `src/application.ts` binding and `src/controllers/auth.controller.ts` import/injection) — it is not consulted anywhere on the per-request authorization path. `AuthController.login` also only checks `user.isActive` once, at login time (line 188-190) — never again for the life of the token.

**Failure scenario:** An admin revokes a permission, demotes a role, or deactivates (`isActive=false`) an employee (e.g., a terminated employee who stole cash, or a compromised account). The employee's existing JWT (`JWT_EXPIRES_IN` defaults to `7h` — `.env.example:7`, `src/application.ts:93`) keeps working with its old roles/permissions/active-status snapshot for up to 7 hours after revocation — including financial actions like refunds, wallet debits, or order cancellation.

**Severity:** High. **Confidence:** Confirmed.

**Recommendation:** Either shorten `JWT_EXPIRES_IN` materially, or add a lightweight per-request/periodic re-check against `Users.isActive` (and ideally a `tokenVersion`/`passwordChangedAt` style invalidation claim) so demotion/deactivation takes effect well inside the token's nominal lifetime, instead of only at next login.

**Dependencies/risks:** Any fix that re-queries the DB per request adds latency/DB load — needs caching with a short TTL, not a query on every call.

**How to validate later:** Deactivate a test employee, then replay a previously-issued token against a protected endpoint before it expires; confirm it is rejected.

---

### ARC-002 — No brute-force protection on `/auth/login` (or any auth endpoint)
**Files:** `src/controllers/auth.controller.ts` (`login`, lines 147-303); `package.json` (dependencies list, lines 105-127).

**Evidence:** `package.json` has no rate-limiting library (`express-rate-limit`, etc.) and no `helmet`. Codebase-wide search for `rateLimit|rate-limit|lockout|failedLoginAttempts|loginAttempts|brute` returns zero matches outside this note. `login()` only checks password via bcrypt compare (lines 193-200) with no attempt counter, no exponential backoff, no CAPTCHA, no IP/account lockout.

**Failure scenario:** An attacker (or automated script) can submit unlimited password guesses against any known username/email/phone, limited only by network latency — a credential-stuffing or brute-force attack against staff or customer accounts has no in-app resistance.

**Severity:** High (staff accounts can perform refunds/payments/order actions; customer accounts hold wallet balances). **Confidence:** Confirmed (absence of any such control, verified by dependency list and full-codebase grep).

**Recommendation:** Add per-IP and per-account rate limiting (e.g., `express-rate-limit` or a Redis-backed limiter) in front of `/auth/login`, `/customer/auth/*`, `/rider/auth/*`, and OTP endpoints; add a progressive lockout/backoff after N failed attempts.

**Dependencies/risks:** None significant; this is additive middleware.

**How to validate later:** Script repeated failed logins against a test account and confirm the service eventually throttles/locks rather than accepting unlimited attempts.

---

### ARC-003 — Dead/buggy `generateShortToken` (low impact, noted for hygiene)
**File:** `src/services/jwt-service.ts`, lines 55-61.

**Evidence:**
```ts
async generateShortToken(userProfile: UserProfile): Promise<string> {
  ...
  return this.signJwt('10m', '10m' as jwt.SignOptions['expiresIn']);
}
```
The `userProfile` parameter is ignored; the JWT payload becomes the literal string `'10m'` instead of the user profile. Codebase-wide grep confirms `generateShortToken` has no callers — dead code, so no live impact today, but a latent bug waiting to bite if ever wired up (e.g., for a password-reset short-lived token).

**Severity:** Low. **Confidence:** Confirmed. **Recommendation:** Fix to `this.signJwt(userProfile, '10m')`, or remove if truly unused.

---

### ARC-020 — CRITICAL: `FileUploadController` has zero authentication on every endpoint — unauthenticated arbitrary file upload, directory listing, and file download/preview
**File:** `src/controllers/file-upload.controller.ts`, all 6 routes (lines 82-89, 91-122, 154-175, 177-212, 214-237, 239-262). Verified directly: none of the six `@post`/`@get` handlers in this file carry `@authenticate` or `@authorize` — confirmed by reading the full file, which has no such decorator anywhere.

**Evidence:**
- `POST /files/{processId}` (82-89) and `POST /files` (91-122): accept arbitrary `multipart/form-data` via `multer({storage}).any()` (line 69) with no auth, no file-type allowlist, no size limit visible, written to disk under `STORAGE_DIRECTORY` — the same directory other services (customer documents, garment damage/stain photos, generated invoice PDFs) use.
- `GET /files` (154-175) lists every file in the storage root; `GET /files/{folderName}` (177-212) lists any subfolder's contents — both unauthenticated, enabling full filename enumeration of everything ever uploaded.
- `GET /files/file/{path}/{fileName}` (214-237) and `GET /files/file/{fileName}` (239-262) serve any file in storage by name, unauthenticated. The second variant's own code comment admits the risk: `// ❌ No Content-Disposition (browser will preview if possible)` (line 257) — an uploaded HTML/SVG file would render inline, in-browser, same-origin as the API.
- Path-traversal is defended against (`validateFileName`/`startsWith(this.storageDirectory)` checks, lines 51-53, 201-203, 269-281) — so this is not also a traversal bug — but the entire namespace is open to anyone regardless.

**Concrete failure scenario:** An unauthenticated caller hits `GET /files` to enumerate stored filenames, then `GET /files/file/{fileName}` to download any file — potentially customer KYC documents, garment damage/stain photos, or anything else saved under the shared storage root — with no login required. Separately, an attacker can `POST /files` an HTML file and link `GET /files/file/{fileName}` to execute script content in the API's own origin (stored XSS / phishing-via-trusted-domain), or fill the disk via unrestricted uploads (DoS).

**Severity:** Critical — the single most severe finding in this audit; unauthenticated read/write access to a document store containing customer PII/images, reachable without any credentials at all.
**Confidence:** Confirmed by direct code read.

**Recommendation:** Add `@authenticate('jwt')` plus an appropriate `@authorize` (scoped to the resource owner/role that legitimately needs it) to all six endpoints immediately. Separately: remove or fix the no-`Content-Disposition` download path (`downloadFileOutsideFolder`), add a file-type/size allowlist to the upload handler, and confirm this controller isn't meant to be the public document server — `customer-document.controller.ts` already serves that role correctly via signed, expiring URLs, which suggests `file-upload.controller.ts` may be legacy/internal-only and simply never got the auth decorators the rest of the codebase consistently applies.

**Dependencies/risks:** Adding auth here could break any existing internal caller (admin-panel upload widgets, PDF-generation internals) that currently calls these routes without a token — those call sites need to be identified and given a valid session/service token before the fix ships.

**How to validate later:** Call `GET /files` and `POST /files` with no `Authorization` header against a staging deployment; confirm both currently succeed, then confirm both are rejected after the fix.

---

### ARC-021 — Login OTP returned in plaintext in the API response when `WHATSAPP_ENABLED=false`
**File:** `src/services/otp.service.ts`, `sendLoginOtp` (lines 28-38); callers `src/controllers/rider-auth.controller.ts` (line ~90-92, endpoint unauthenticated by design — it's the send-OTP step) and `src/controllers/customer-auth.controller.ts` (line ~271, same pattern).

**Evidence:**
```ts
async sendLoginOtp(user: {...}) {
  const otp = this.generateOtp();
  ...
  if (process.env.WHATSAPP_ENABLED === 'false') {
    return {message: 'OTP sent', otp};        // line 36-38 — OTP returned to the HTTP caller
  }
  ...
}
```
Confirmed this is a deliberate, documented fallback (per the project's own `docs/whatsapp-notifications.md`, added at the user's request so login still works during a WhatsApp outage), not an accidental leak — but `.env.example` ships `WHATSAPP_ENABLED=false` as its template default, while the live `.env` in this repo currently has it `true`.

**Concrete failure scenario:** Any environment provisioned from `.env.example` without explicitly flipping the flag to `true` (a plausible mistake for a new staging/UAT environment, or a misconfigured prod deploy) hands back the real login OTP in the response body of an unauthenticated "send OTP" call for any phone number the caller supplies — a complete bypass of the "possession of phone" property, since the attacker never needs to receive the WhatsApp message at all.

**Severity:** High (Critical if this is ever true on a reachable, real environment — not verifiable from this repo alone). **Confidence:** Confirmed in code and docs; whether any live/reachable environment currently has the flag unset is Needs validation.

**Recommendation:** Never let this fallback trigger from an *unset/misconfigured* env var — require an explicit, separately-gated `DEV_OTP_BYPASS` flag (defaulting to off, and ideally blocked outside non-prod) rather than overloading `WHATSAPP_ENABLED=false`, which is also the natural state during a real outage.

**How to validate later:** Confirm with the infra/ops owner that `WHATSAPP_ENABLED=true` is set in every reachable deployment (staging included), and consider removing the OTP-echo fallback for any environment that isn't explicitly local/dev.

---

### ARC-022 — Dead code: `isActive` check commented out in `UserService.verifyCredentials` (currently unreachable, latent bypass if ever wired up)
**File:** `src/services/user-service.ts`, lines ~33-35. The `isActive` gate is commented out in this method; codebase-wide grep confirms `verifyCredentials` has zero live callers today — the actual `/auth/login` handler in `auth.controller.ts` (lines 188-190) independently and correctly checks `isActive`. Severity: Low. Confidence: Confirmed dead code; flagged only so a future refactor that wires this method back in doesn't silently reintroduce a deactivated-account-can-still-log-in bug.

---

## 2. Tenant / Store-Level Data Isolation

**Overall assessment:** `StoreScopeService` (`src/services/store-scope.service.ts`) is a well-designed, fail-closed scoping layer (`EMPTY_SCOPE`/`GLOBAL_ROLES` design, lines 50-65) and is consistently wired into the business-critical controllers: `order.controller.ts` (every list/detail/mutate endpoint calls `storeScopeService.resolve`/`assertOrderVisible`/`allows`, confirmed at ~20 call sites including lines 373-374, 465-476, 563-575, 758-759, 823, 942, 1092-1093, 1484, 1671-1674, 1785-2139), plus `garment.controller.ts`, `garment-actions.controller.ts`, `garment-process.controller.ts`, `invoice.controller.ts`, `sales-return.controller.ts`, `pickup-request.controller.ts`, `intake-rejection.controller.ts`, `approval.controller.ts`, `reports.controller.ts`, `dashboard.controller.ts`, `petty-cash.controller.ts`, `transfer.controller.ts`, `delivery.controller.ts`, `challan.controller.ts`, `employee.controller.ts`, `shift.controller.ts`, `admin-customer-recharge.controller.ts`, `refund.controller.ts`, `gateway-payment.controller.ts`, `customer-auth.controller.ts`. It also returns 404 (not 403) for out-of-scope orders (`assertOrderVisible`, lines 265-277) — a deliberate anti-enumeration choice (documented "D4" in the code).

Rider-facing endpoints (`rider-delivery.controller.ts`) scope by `riderId === rider.id` ownership checks instead of store scope (e.g. `deliveryDetail`, lines 210-219: `if (delivery.riderId !== rider.id) throw Forbidden`) — a different but equally valid mechanism for a rider's own-deliveries-only view; not a leak.

**Correction to initial pass:** a second, independent read focused specifically on comparing sibling endpoints within the same files found confirmed cross-store leaks that the first pass missed — the scoping *mechanism* is well-designed and consistently used in most places, but is missing at several specific call sites, documented below as ARC-022 through ARC-024. One documented, *intentional* exception (not a finding): `WalletService.getAllTransactions` (`src/services/wallet.service.ts`, lines 358-359, comment) is explicitly NOT store/cluster/region-scoped — "every caller with `wallet_transactions:read` sees every transaction, same posture as the Customer list already has."

Note on exploitability throughout this section: `AuthorizeInterceptor.intercept` (`src/interceptors/authorize.interceptor.ts` lines 61-67) ORs roles and permissions — `@authorize({roles:['super_admin'], permissions:['order:read']})` grants access to **any** staff account holding the `order:read` permission, not only `super_admin` accounts. So "gated by `@authorize({roles:['super_admin'], permissions:[...]})`" below means "reachable by ordinary store staff who hold that one permission," which is the realistic exploit population for every finding in this section.

### ARC-022 — CONFIRMED HIGH: `GET /invoices` and `GET /invoices/count` return invoices from every store, with no store filter
**File:** `src/controllers/invoice.controller.ts`, `find()` (lines 73-103) and `count()` (lines 105-126), both via the shared `_buildInvoiceWhere()` (lines 133-181).

**Evidence:** `_buildInvoiceWhere` filters only on `status`, `dateFrom`/`dateTo`, `type` (onAccount/regular), and free-text `search` (invoice number, customer name/phone via `_orderIdsMatchingCustomer`, order number via `_orderIdsMatchingNumber`) — confirmed by reading the full method (lines 133-181): no `storeId` clause, no call to `storeScopeService` anywhere in it. `StoreScopeService` **is** injected into this same controller (line 39) and **is** correctly used elsewhere in the very same file — `getByOrder()` (line 503-507) and the generate-invoice flow (line 346) both call `assertOrderVisible()`. The list/count endpoints are the one place it's missing in this file. Both routes are gated by `@authorize({roles:['super_admin'], permissions:['order:read']})` (lines 74, 106) — per the OR-semantics note above, any employee holding plain `order:read` can call them.

**Concrete failure scenario:** A Store-A biller searches the global invoice list by a customer's phone number (`search` param) and sees that customer's invoices from Store B too; or simply pages through `GET /invoices` with no filter and sees every store's revenue, GST, and customer PII system-wide.

**Severity:** High (financial/PII cross-store leak; no concurrency or special timing needed — an ordinary authenticated list/search request). **Confidence:** Confirmed by direct code read.
**Recommendation:** Apply `storeScopeService`'s store-id narrowing inside `_buildInvoiceWhere`, the same way `dashboard.controller.ts`/`reports.controller.ts` already do for their own aggregate queries.
**How to validate later:** As a Store-A-scoped staff account with only `order:read`, call `GET /invoices?search=<a known Store-B customer's phone>` and confirm whether Store-B invoices are returned.

---

### ARC-023 — CONFIRMED HIGH: five per-order sub-resource endpoints in `order.controller.ts` skip the store-visibility check that sibling endpoints in the same file use
**File:** `src/controllers/order.controller.ts`.

**Evidence:** `findById` (line ~559), `deliveryManagementDetail` (~571), and `requestReprocess` all correctly call `await this.storeScopeService.assertOrderVisible(id, currentUser)` before touching the order. The following five do **not** call it anywhere — verified directly, no `assertOrderVisible`/`storeScopeService` reference appears in any of their bodies:
- `getHandover` (lines 2233-2242) — `GET /orders/{id}/handover`.
- `getPayments` (lines 2246-2264) — `GET /orders/{id}/payments`; fetches the order directly via `orderRepository.findOne({where:{id, isDeleted:false}})` (2251-2253) with no scope check, then returns `paymentTransactions`, totals, and balance due.
- `correctPaymentMode` (lines 2271-2309) — `PATCH /orders/{id}/payments/{paymentId}`, a **write** that relabels a recorded payment's mode, gated only by `@authorize({roles:['super_admin'], permissions:['payment:update']})` — any `payment:update` holder, no scope check at all.
- `statusHistory` (lines 2313-2322) — `GET /orders/{id}/status-history`; queries `statusHistoryRepository.find({where:{orderId:id}})` directly.
- `activityLog` (lines 2331-2339) — `GET /orders/{id}/activity-log`; calls `orderService.getActivityLog(id)` directly.

All five are `@authenticate('jwt')` + `@authorize({roles:['super_admin'], permissions:['order:read'|'payment:update']})` only.

**Concrete failure scenario:** Store-A staff who know, guess, or enumerate an orderId belonging to Store B (order ids/numbers are not inherently secret within the org — they appear in receipts, labels, etc.) can read that order's full payment history and balance, its handover record, status history, and activity log — and can **rewrite** a payment's recorded mode on an order that was never theirs, with no store-scope check blocking any of it.

**Severity:** High (financial-data read plus an unscoped write path). **Confidence:** Confirmed — direct contrast within the same file against the three sibling methods that do call `assertOrderVisible`.
**Recommendation:** Add `await this.storeScopeService.assertOrderVisible(id, currentUser)` at the top of each of these five handlers, matching the pattern already used three other times in this exact file.
**How to validate later:** As Store-A staff, call `GET /orders/{known-store-B-order-id}/payments` and `PATCH /orders/{that-id}/payments/{paymentId}` and confirm whether either succeeds today.

---

### ARC-024 — CONFIRMED MEDIUM: `GET /payments/gateway-links/{id}` has no permission gate and no store-scope check
**File:** `src/controllers/gateway-payment.controller.ts`, `findById` (lines 181-188, route `GET /payments/gateway-links/{id}`).

**Evidence:** `@authenticate('jwt')` only (line 181) — no `@authorize`, and no call to `this.storeScopeService` (which **is** injected into this same controller at line 41 and used correctly in `create()` at line 127: `await this.storeScopeService.assertOrderVisible(body.referenceId, currentUser)`). `findById` simply does `this.gatewayPaymentLinkRepository.findById(id)` (line 185) and returns it.

**Concrete failure scenario:** Any authenticated staff or rider account (no specific permission required) can poll any gateway payment link's status — amount, reference type/id, Razorpay order/payment ids — for any store, by guessing/enumerating the link id. Lower severity than ARC-022/023 since it's read-only, non-PII-heavy payment metadata, but still an inconsistency against this controller's own `create()` method and against the customer-facing counterpart (`CustomerGatewayPaymentController`), which does check ownership.

**Severity:** Medium. **Confidence:** Confirmed by code read.
**Recommendation:** Add the same `assertOrderVisible(link.referenceId, currentUser)` check (after fetching the link) that `create()` already uses.

---

### ARC-025 — Needs validation: `bag.controller.ts` list/detail endpoints have no store filter and no permission gate
**File:** `src/controllers/bag.controller.ts`, `find()` (lines 56-68) and `findById()` (lines 72-82) — `@authenticate('jwt')` only, no `@authorize`, no store filter; returns all bags company-wide including `currentStoreId`/`status`/`itemCount`.

**Evidence:** Confirmed no `@authorize` and no store-scope call on either method. `Bag` is documented (model comment) as a shared inter-store-transfer-custody resource — every store arguably needs visibility into where bags currently are to receive/reconcile transfers, so unscoped *visibility* may be intentional. What looks like a gap regardless: there's no permission gate at all, so any authenticated account — including a `rider` role — can call `GET /bags` and see company-wide bag locations/counts, which seems broader than a rider's job needs.
**Severity:** Low-Medium. **Confidence:** Needs validation (depends on whether broad bag visibility is an accepted business decision — it reads that way given the model's own comment, but no explicit confirmation was found).
**How to validate later:** Confirm with the product owner whether riders are meant to see full company-wide bag inventory, and if not, add a role/permission gate.

---

### ARC-026 — Needs validation: rider endpoint store/ownership scoping not exhaustively traced
`rider-pickup.controller.ts` and `rider-delivery.controller.ts` use rider-ownership checks (e.g. `deliveryDetail` in `rider-delivery.controller.ts`: `if (delivery.riderId !== rider.id) throw Forbidden`) rather than `StoreScopeService` — a different but plausible mechanism for a rider's own-work-only view. Not independently traced end-to-end for every rider endpoint in this pass (e.g., whether every "my pickup requests"-style listing truly filters to the calling rider and not a broader store/cluster set). Severity: N/A (process note). Confidence: Needs validation.

### ARC-004 — Needs validation: scope coverage not exhaustively verified
Given the size of the controller surface (~90 files), I spot-checked the highest-traffic/business-critical controllers listed above but did not exhaustively verify every list/find endpoint in every controller (e.g., `bag.controller.ts`, `item.controller.ts`, `service.controller.ts`, `warehouse.controller.ts`, `price-list.controller.ts` were not checked — these look like store-agnostic master-data tables, but that assumption wasn't verified).
**Severity:** N/A (process note). **Confidence:** Needs validation. **How to validate later:** grep every `@get` list endpoint lacking `storeScopeService`/`storeId` filtering and confirm each one is genuinely global master data, not tenant data.

---

## 3. Order Lifecycle Transaction Consistency

### ARC-005 — `OrderService.changeStatus`: most status transitions run with NO transaction and NO row lock
**File:** `src/services/order.service.ts`, method `changeStatus` (starts line 2637).

**Evidence:**
- Lines 2644-2659: order is read via a plain `findOne` (no lock); the allowed-transition check (`ORDER_STATUS_TRANSITIONS[order.status]`) runs against that unlocked read.
- Lines 2673-2753: **only** for `newStatus === RECEIVED_AT_STORE`, or `DRAFT → CONFIRMED/CANCELLED`, does the method open a transaction and issue `SELECT id FROM public.orders WHERE id = $1 FOR UPDATE` (line 2680), re-read the order inside the tx, and re-validate before writing (lines 2681-2738) — a correct pessimistic-lock pattern.
- Lines 2754-2794: for **every other transition** (`IN_INSPECTION`, `IN_PROCESS`, `QUALITY_CHECK`, `READY`, `OUT_FOR_DELIVERY`, `ON_HOLD`, `CANCELLED`-from-non-draft, etc.) a transaction is opened **only if** `newStatus === DELIVERED` (line 2754-2756); for all others, `tx`/`options` remain `undefined` (line 2773), and the write —
  ```ts
  await this.orderRepo.updateById(orderId, {status: newStatus, ...}, options);  // line 2774, options === undefined
  ```
  — runs completely unprotected, followed by an equally unprotected `statusHistoryRepo.create` (lines 2780-2787).

**Concrete failure scenario:** Two near-simultaneous requests act on the same order while its status is `IN_PROCESS` — e.g. two scan-station staff, or a UI double-submit racing a background sync — one targeting `QUALITY_CHECK`, the other `ON_HOLD`. Both unlocked reads at 2644-2646 see `status=IN_PROCESS`; both pass their own allowed-transition check independently; both execute the unprotected `updateById`. Whichever commits last silently wins — the other caller receives a success response for a status that was never actually persisted, and **both** status-history rows get inserted, leaving a status-history log that contradicts the order's final persisted status.

**Severity:** Medium-High (business-critical garment pipeline correctness — silent state corruption / phantom success, not outright data loss).
**Confidence:** Confirmed (direct code reading of both branches).

**Recommendation:** Extend the `SELECT ... FOR UPDATE` + re-validate-inside-tx pattern that is already correctly used for `RECEIVED_AT_STORE`/draft-exit/`DELIVERED` to **every** status transition in this method, not just those three.

**Dependencies/risks:** Will add a small amount of lock contention on hot order rows; acceptable given per-order concurrency is inherently low.

**How to validate later:** Fire two concurrent `changeStatus` calls on the same test order moving it to two different next states from the same current state; confirm the loser receives an explicit `Conflict` rather than a silent 200.

---

### ARC-006 — `DeliveryController.cancel`: 4 sequential writes with no transaction
**File:** `src/controllers/delivery.controller.ts`, method `cancel` (lines 179-230).

**Evidence:** Reads the delivery via `findOne` (line 183, no lock), checks `status === ASSIGNED` (185-189), then performs four independent writes with no shared transaction: `orderRepo.updateById` per linked order (202-208), `deliveryRepo.updateById` to `CANCELLED` (211-215), `bagRepo.updateById` to `AVAILABLE` (218-221), `custodyEventRepo.create` (224+).

**Concrete failure scenario:** A crash/exception between steps (e.g. after the delivery is marked `CANCELLED` but before the bag is released) leaves the bag stuck as "in use" forever, or an order retains a stale `assignedRiderId` after its delivery run was cancelled — requiring manual cleanup.

**Severity:** Medium. **Confidence:** Confirmed.
**Recommendation:** Wrap in `dataSource.beginTransaction(...)`, matching the pattern used throughout `order.service.ts` and `razorpay.service.ts`.
**How to validate later:** Kill the process (or throw a forced error) between two of the four writes in a test environment; confirm no permanently-stuck bag/order state results once the fix is applied.

---

### ARC-007 — Needs validation: `GarmentActionsController` read-then-act without lock on some endpoints
**File:** `src/controllers/garment-actions.controller.ts`.

**Evidence:** `requestReturn` (lines 50-90+), the `readyForDispatch`-style endpoint (~414-423), and the bag-assignment endpoint (~450-456) each do a plain `findOne` + later `updateById`/service call with no transaction/lock — **except** one method (~line 376) which correctly does `beginTransaction` + `SELECT ... FOR UPDATE OF g` on the garment row. The inconsistency within the same file suggests the pattern is known but not applied uniformly. I did not fully trace `ApprovalService.createRequest`/`_guardNoPendingRequest` to confirm whether a double-submitted "return" request could create duplicate approval requests or double-apply a garment-status side effect.
**Severity:** Low-Medium. **Confidence:** Needs validation.
**How to validate later:** Trace `_guardNoPendingRequest` and `ApprovalService.createRequest` fully, and/or fire two concurrent `POST /garments/{id}/action/return` calls for the same garment and inspect for duplicate approval requests.

---

### Positive control observed
`order.service.ts` locks the `coupon` row (`SELECT id FROM public.coupon WHERE UPPER(code) = $1 FOR UPDATE`, line 812) and the `customer` row (line 823) before applying a coupon redemption, and `coupon.service.ts` has no stored "usage count" column at all (grep for `usageLimit|maxRedemptions|redemptionCount|currentUsage|usageCount` returns nothing) — so coupon-limit races appear well-guarded. Not a finding; noted so effort isn't duplicated.

---

## 4. Stock / Inventory-Analogue Consistency (Wallet, Security Deposit, Petty Cash)

Pressto has no traditional SKU inventory; the closest analogues are customer wallet balance, customer security-deposit balance, and store petty-cash balance.

### ARC-008 — `WalletService.credit`/`debit`: classic read-then-write, zero transaction protection
**File:** `src/services/wallet.service.ts`, `credit()` (lines 62-75), `debit()` (lines 77-93).

**Evidence:**
```ts
async credit(walletId, amount, ...): Promise<any> {
  const wallet = await this.walletRepository.findById(walletId, undefined, options);   // line 63
  const newBalance = Number(wallet.currentBalance) + Number(amount);                   // line 64
  await this.walletRepository.updateById(walletId, {currentBalance: newBalance}, options); // line 65
  ...
}
async debit(walletId, amount, ...): Promise<any> {
  const wallet = await this.walletRepository.findById(walletId, undefined, options);   // line 78
  if (Number(wallet.currentBalance) < Number(amount)) { throw ... }                    // line 79
  const newBalance = Number(wallet.currentBalance) - Number(amount);                    // line 82
  await this.walletRepository.updateById(walletId, {currentBalance: newBalance}, options); // line 83
  ...
}
```
No `dataSource.beginTransaction` call exists anywhere in this file (confirmed by full read). These two methods back `adminRecharge`, `adminDebit`, `confirmRecharge`, `cancelRecharge` — i.e. customer self-service wallet top-up, admin counter recharge, and admin correction debit.

**Concrete failure scenario:** Customer has ₹500. An admin counter recharge and the customer's own in-app top-up confirmation land within milliseconds of each other (realistic: customer taps "pay with wallet" on the app while in-store staff key an admin recharge for the same walk-in customer). Both `credit()`/`debit()` calls read the same stale `currentBalance`; the second `updateById` overwrites the first's result (lost update). Both `WalletTransaction` ledger rows are still created correctly, so `wallet.currentBalance` silently drifts out of sync with the ledger — breaking reconciliation and potentially letting a debit through that should have failed the insufficient-balance check (which also used the stale value).

**Severity:** High (money/ledger integrity). **Confidence:** Confirmed.

---

### ARC-009 — Order checkout's wallet-debit path: balance read *before* the transaction begins; no row lock on `wallet` anywhere
**File:** `src/services/order.service.ts`.

**Evidence (addPayment/collectPayment flow, ~line 7800-7990):**
- Lines 7862-7874: wallet balance fetched via `walletRepo.findOne` and the insufficient-balance check performed **before** `tx = await this.dataSource.beginTransaction(...)` at line 7876.
- Line 7881: only the **order** row gets `SELECT ... FOR UPDATE` inside the transaction — the wallet row is never locked or re-read inside it.
- Line 7971: `const newBalance = wallet.currentBalance - thisWallet;` — uses the pre-transaction, already-stale value captured at line 7873.
- Lines 7972-7976: writes that stale-derived value via `walletRepo.updateById(wallet.id, {currentBalance:newBalance}, {transaction: tx})`.

**Evidence (order-creation flow, lines 2468-2485):** Partially better — re-reads the wallet via `findById(..., {transaction: tx})` *inside* the tx (line 2469) before computing `newBalance` (line 2480) — but a plain `SELECT` inside a transaction under READ COMMITTED does **not** block a concurrent transaction's `SELECT`. Codebase-wide grep for `FOR UPDATE` in `order.service.ts` (16 occurrences) confirms it is used only on `orders`, `coupon`, `customer`, `store`, and `garment` rows — **never** on `wallet`.

**Concrete failure scenario:** Customer has ₹1000 wallet balance and two open tickets due ₹600 and ₹500. Two near-simultaneous "pay with wallet" requests for the two different orders (plausible: a retried request from the customer app's queue, or two store counters serving the same customer's two tickets) each read balance=1000, each independently compute and commit a new balance (1000−600=400, 1000−500=500). The final persisted balance is whichever commits last (e.g. 500) — it should be −100, i.e. the second payment should have been rejected as insufficient. Net effect: the business loses ₹500-₹600 of wallet-funded service that was never actually backed by real money.

**Severity:** High — this is the live, high-traffic checkout/payment path, not an admin-only tool.
**Confidence:** Confirmed by direct reading of both call sites and the grep confirming no wallet-row lock exists anywhere in the file.

---

### ARC-010 — `SecurityDepositService.addAmount`/`deductAmount`: identical unprotected pattern
**File:** `src/services/security-deposit.service.ts`, lines 25-59.

**Evidence:** Same shape as ARC-008 — `findById` → compute in JS → `updateById`, no `beginTransaction` anywhere in the file. Backs `confirmTopup`/`adminTopup`.
**Severity:** High (same reasoning as ARC-008). **Confidence:** Confirmed.

**Recommendation (ARC-008/009/010 collectively):** Either (a) use an atomic DB-level update — `UPDATE wallet SET current_balance = current_balance - $1 WHERE id = $2 AND current_balance >= $1`, checking rows-affected — inside a transaction, or (b) take a `SELECT ... FOR UPDATE` lock on the wallet/deposit row inside a transaction before reading the balance used for the write, consistent with the pattern `order.service.ts` already uses correctly for orders/coupons/customers.

**Dependencies/risks:** None beyond the usual small added lock contention on a given customer's wallet row — acceptable since the risk is specifically concurrent actions against the *same* customer.

**How to validate later:** Fire two concurrent wallet-debit (or addPayment-with-wallet) requests for the same customer against a staging DB; confirm the resulting `wallet.currentBalance` always equals `sum(ledger entries)` rather than silently diverging.

---

### Positive note — Petty cash has no stored-counter race at all
`PettyCashService.computeBalance` (`src/services/petty-cash.service.ts`, lines 38-56) deliberately has **no stored balance column**; the balance is always derived live from the finance+register ledger via aggregation queries. This is a sound design choice specifically because it avoids the read-modify-write race class entirely. Not a finding — noted to avoid duplicate investigation.

---

## 5. Shift Opening/Closing Concurrency

### ARC-011 — Shift `open()`: TOCTOU race between "no open shift" check and create; no DB constraint backstop
**Files:** `src/controllers/shift.controller.ts`, method `open` (lines 422-536+); `src/models/shift.model.ts` (doc comment, lines 4-27).

**Evidence:**
```ts
const existingOpen = await this.shiftRepository.findOne({
  where: {storeId: caller.storeId, status: ShiftStatus.OPEN} as object,  // line 484-489
});
if (existingOpen) throw new HttpErrors.Conflict(...);                     // line 490-495
...
const shift = await this.shiftRepository.create({ ..., status: ShiftStatus.OPEN, ... });  // line 523-536
```
There is no transaction, no `SELECT ... FOR UPDATE`, and no database unique constraint between the check and the create. The `Shift` model's own doc comment (lines 12-20) states this explicitly: *"Scoped by storeId — one open shift per STORE at a time... Enforced in the controller (no DB constraint — precedent for a status-conditional unique index elsewhere in this codebase, matching RiderPincodeMapping's same posture)."* The model's only unique index is `uniqueStoreOpeningNo` on `(storeId, openingNo)` (line 26) — it does not cover `(storeId, status=OPEN)`. The same comment block documents a **real prior production incident**: two different employees each ended up with their own OPEN shift at the same store simultaneously; the fix applied (lines 477-483) only broadened the `findOne` filter to catch a *different* employee's already-open shift (removing a `userId` filter) — it does **not** close the TOCTOU window between the check and the create for two requests racing at the same instant.

**Concrete failure scenario:** Two `POST /shifts` requests for the same store, submitted within the (small but nonzero) window between the `findOne` check and the `create` call — e.g. two different cashiers opening the register within the same second during a shift handover — can both pass the "no open shift" check and both successfully create an `OPEN` shift row for the same store, reproducing the exact incident the code comment already describes as having happened in production, except this time via true request concurrency rather than stale client knowledge.

**Severity:** High (this is precisely the "two shifts/registers open at once" scenario the audit was asked to check for, and it is explicitly acknowledged as a known risk, not fully fixed, in the code itself).
**Confidence:** Confirmed — both by code reading and by the author's own doc comment.

**Recommendation:** Add a partial/status-conditional unique index (e.g., Postgres `CREATE UNIQUE INDEX ON shift (store_id) WHERE status = 'open'`) as the actual backstop, and/or wrap the check+create in a transaction with `SELECT ... FOR UPDATE` on a per-store lock row (or `pg_advisory_xact_lock(hashtext(storeId))`). A DB-level constraint is the only thing that fully closes a TOCTOU window; the application-level check alone cannot.

**Dependencies/risks:** Requires a migration (the codebase already has a `scripts/*.cjs` migration pattern for this kind of schema change, e.g. `scripts/add-store-prefix-lock.cjs`).

**How to validate later:** Fire two concurrent `POST /shifts` requests for the same store (e.g. via a small concurrency test script) and confirm only one succeeds, with the other getting a clean `Conflict`, not a second `OPEN` row.

---

### ARC-012 — Shift `close()`: same check-then-act pattern, lower impact
**File:** `src/controllers/shift.controller.ts`, method `close` (lines 1357-1436+).

**Evidence:** `findById` (1366) → check `status !== OPEN` (1368-1370) → compute `revenue`/`orderSummary` (1424-1427) → `updateById` to `CLOSED` (1429-1436) — no transaction, no lock between the read and the write.

**Concrete failure scenario:** A double-tap/double-submit (flaky network retry) sends two `close` calls for the same shift in quick succession. Both pass the `status === OPEN` check, both run the (somewhat expensive) revenue/summary computation redundantly, and both `updateById` to `CLOSED` — final state is still `CLOSED` either way (not a double-booking or financial-loss bug, since the target status is the same constant), but the stored `closing` JSON snapshot is whichever call's `now`-derived numbers committed last, with no error surfaced to the "losing" caller and no idempotency key to detect the duplicate submit.

**Severity:** Low-Medium (less severe than ARC-011 — no double-resource creation, just a redundant/last-write-wins snapshot). **Confidence:** Confirmed.
**Recommendation:** Same `FOR UPDATE` pattern as the rest of the shift lifecycle, or an idempotency token from the client for the close action.

---

## 6. Idempotency / Duplicate-Request Handling

### Positive finding — Razorpay payment application is correctly idempotent
**File:** `src/services/razorpay.service.ts`, `markPaidAndApply` (lines 457-515).

This method opens a transaction, takes `SELECT id FROM public.gateway_payment_link WHERE id = $1 FOR UPDATE` (466-470), re-reads the link's status **inside** the lock, and short-circuits with a no-op commit if it's already `PAID` with no `applicationError` (lines 476-482) before ever calling `applyPayment`. Both confirmation paths (`verifyAndApplyPayment` — the Checkout popup handler — and `handlePaymentCaptured`/`handlePaymentLinkPaid` — the webhook) funnel through this same guarded method, so "whichever gets there first applies the payment, the other is a no-op" (as the code's own comment at lines 291-293 states) is actually true and verified by the lock+recheck pattern. This is good, deliberate engineering — not a finding, documented so it isn't re-investigated.

### Positive finding — WhatsApp notification de-duplication
**File:** `src/services/whatsapp.service.ts`, `once()` (lines 480-510) and `dispatchWhatsApp()` (lines 93-101).

Every outbound WhatsApp notification is keyed (e.g. `'wallet-recharge:' + transactionId`, `'order:' + orderId + ':' + event`) and deduplicated via an in-memory `sent`/`pending` map with a 24h TTL, preventing double-sends if the same event is triggered twice. Side-effect sends are wrapped via `dispatchWhatsApp` (fire-and-forget with `.catch()`), explicitly documented as being called "after their writes/transaction commit succeed" — i.e., notification failure can never roll back or block the underlying business transaction. Good failure-isolation design (see also Section 9/13).

### ARC-026b — CONFIRMED MEDIUM-HIGH: Order creation has no client-supplied idempotency key — double-submit can create two orders
**Files:** `src/controllers/order.controller.ts`, `createOrder` (lines 288-378+); `src/services/order.service.ts`, `createOrder` (~line 1518 onward).

**Evidence:** The `createOrder` request body schema (order.controller.ts, around lines 290-378) has no idempotency/correlation-id field; `OrderService.createOrder` has no "was this exact submission already processed" check. The internal transaction/locking that does exist (`beginTransaction` + `lockCustomerForOrder`/`resolveNextOrderNumber` under `FOR UPDATE`, confirmed elsewhere in this file) is solid for correctness of order-number sequencing and coupon/customer locking **within** one request, but does nothing to stop two separate HTTP requests — e.g. a double-tap on the admin-panel/customer-app "place order" button, or a client retry after a request that actually succeeded but timed out on the response — from each independently passing through as a brand-new order, each with its own `orderNumber`, garments, and any cash payment entries included in the request body.

**Concrete failure scenario:** A counter staff's screen hangs after tapping "create order" (slow network); they tap again; both requests reach the server and both succeed, producing two distinct orders (and, if a cash payment was included in the body, two recorded cash collections) for what the customer experiences as one transaction. The Razorpay/online-payment leg is not at risk of double-charging this way, since Razorpay's own signature-verified confirmation and `markPaidAndApply`'s row-locked idempotency (Section 7) protect that path — this gap is specific to the order record itself and any payment leg recorded inline with creation (e.g. cash).

**Severity:** Medium-High. **Confidence:** Confirmed absence of any guard by code read; the "two orders from one double-tap" scenario is a direct reading of the code's behavior, not reproduced against a live system — mark reproduction itself Needs validation.
**Recommendation:** Accept an optional client-generated idempotency key (e.g. `Idempotency-Key` header or a body field) on `POST /orders`, store it with a unique constraint, and return the original order on a repeat key within a short window — the same pattern already used correctly for Razorpay payment application.
**How to validate later:** Fire the same `createOrder` payload twice in quick succession against a test store/customer and confirm whether one or two orders result.

### ARC-013 — Needs validation: the WhatsApp dedup cache is process-local, not persisted
**File:** `src/services/whatsapp.service.ts`, lines 106-108 (`private readonly sent = new Map...`, `pending = new Map...`).

**Evidence:** These maps live in instance memory (the service is `BindingScope.SINGLETON` within one Node process). If the backend is horizontally scaled to multiple instances, or restarted, the dedup state resets/splits per-instance.
**Severity:** Low. **Confidence:** Needs validation (depends on deployment topology, which wasn't visible from the repo — single instance vs. multiple). **How to validate later:** check the deployment config (not present in this repo) for replica count; if >1, a shared (Redis-backed) dedup store would be the safer design, though the actual duplicate-send risk is likely small given most call sites only invoke each notification key once per business event already.

---

## 7. Payment & Webhook Reliability (Razorpay)

**Signature verification:** present and correct for both paths — `RazorpayService.verifyWebhookSignature` (lines 276-283) uses Razorpay's own `validateWebhookSignature` helper over the **raw, unparsed** request body (the controller explicitly reads it via `readRawBody`/`x-parser: 'text'`, `src/controllers/gateway-payment.controller.ts` lines 190-209, to avoid JSON re-serialization breaking the HMAC check — a real, easy-to-get-wrong detail that is handled correctly here). The Checkout-popup path (`verifyAndApplyPayment`, lines 295-331) independently re-derives and compares its own HMAC with `crypto.timingSafeEqual` (lines 307-319) — a constant-time comparison, correctly avoiding a timing side-channel.

**Amount/entity cross-checks:** `assertCapturedPayment` (lines 424-441) and the inline checks in `handlePaymentLinkPaid` (lines 390-401) verify the payment id, status, currency, and amount against the stored `GatewayPaymentLink` before ever applying anything — good defense against a webhook claiming success for the wrong amount.

### ARC-014 — Webhook handler's "always 200" design intent is not actually guaranteed for payload-mismatch failures
**Files:** `src/controllers/gateway-payment.controller.ts`, `webhook` (lines 200-242); `src/services/razorpay.service.ts`, `handlePaymentCaptured` (341-365), `handlePaymentLinkPaid` (376-412), `webhookEntity` (414-422), `assertCapturedPayment` (424-441).

**Evidence:** The controller's comment (lines 237-240) states: *"Always 200 once the signature checks out ... a genuine application failure is already recorded on the link itself ... rather than something a retry would fix."* But lines 212-235 call `handlePaymentCaptured`/`handlePaymentLinkPaid` with **no try/catch** around them. Inside those service methods, `webhookEntity()` throws `HttpErrors.BadRequest` if the expected entity is missing (line 419-420), and `assertCapturedPayment()` throws `HttpErrors.BadRequest` on any status/amount/currency/order-id mismatch (lines 429-440) — and crucially, **both of these throw before `markPaidAndApply` is ever called**, i.e. before the one place (lines 483-492) that is designed to swallow an application error into `applicationError` and still return 200. An uncaught `HttpErrors.BadRequest` thrown here propagates straight up through the controller (there is no surrounding try/catch, and `src/sequence.ts` is the unmodified default `MiddlewareSequence` with no custom error-to-200 mapping) and LoopBack's REST layer returns the real 400 status to Razorpay.

**Concrete failure scenario:** Razorpay delivers a `payment.captured`/`payment_link.paid` webhook whose entity data doesn't match what's stored (e.g. a stale/mismatched `GatewayPaymentLink` row, a legitimate amount discrepancy, or any malformed/unexpected payload shape that still carries a valid signature) — `assertCapturedPayment`/`webhookEntity` throws, the endpoint returns 400, and Razorpay's retry policy will redeliver the identical webhook repeatedly. Since the mismatch is deterministic (not a transient condition), every retry fails identically — a permanent-failure webhook gets treated as if it were a retryable transient one, generating retry noise with no automatic resolution until the discrepancy is manually fixed in the DB (at which point Razorpay may have already exhausted its retry window).

**Severity:** Medium (this is the opposite failure mode from "silent swallow" the audit asked about — it's "retries forever on something a retry can never fix" — but it does mean the comment's stated design guarantee is not actually met for this failure class).
**Confidence:** Confirmed by direct code reading (no try/catch present; default sequence confirmed).

**Recommendation:** Wrap the `handlePaymentCaptured`/`handlePaymentLinkPaid` calls in the controller (or inside those service methods) in a try/catch that logs the mismatch for manual reconciliation and still returns `{received:true}`/200 — consistent with the comment's stated intent — reserving a non-200 response only for genuinely transient failures (e.g. DB connection errors) where a retry might actually help.

**How to validate later:** Send a signed webhook payload with a deliberately mismatched amount/status to a test endpoint and confirm the HTTP response code returned to the "Razorpay" caller.

---

## 8. Background Job Reliability

### ARC-015 — No background job/queue system exists at all; all async work is in-process fire-and-forget with no retry or dead-letter
**Files:** `package.json` (no `bull`/`bullmq`/`agenda`/`node-cron` dependency); codebase-wide grep for `setInterval|setTimeout(...,[0-9]{4,}|node-cron|cron.schedule` returns only one unrelated `setTimeout` in `notification.service.ts:257` (a 1.5s pacing delay inside a loop, not a scheduled job).

**Evidence:** Every "background"-style operation (WhatsApp template sends, FCM push notifications) is a plain in-process `Promise` kicked off via `dispatchWhatsApp()`/`.catch()` (whatsapp.service.ts lines 93-101) or similar inline `.catch(() => {})` patterns (e.g. `order.service.ts` line ~2746-2750, `notificationService.notifyRider(...).catch(() => {})`). If the send fails (WhatsApp API down, network timeout, FCM error), the only trace is a `console.error` line (e.g. `whatsapp.service.ts` lines 97-100, 438-445, 469-475) — there is no persisted failure record, no retry schedule, and no dead-letter queue to later replay or audit failed sends.

**Concrete failure scenario:** During a WhatsApp provider outage (or a burst of 5xx/timeouts from Tata Omni's API), every customer-facing notification issued in that window — order-created, ready-for-collection, delivery-assigned, payment-received, wallet-recharge confirmations — is permanently lost. The business-critical order/payment flow itself is correctly unaffected (see Section 13 — this is by design and a genuine strength), but there is no way to know afterward which customers didn't get notified, and no automatic re-send once the provider recovers.

**Severity:** Medium (customer-communication reliability, not transactional-data risk — but real business impact: customers not informed their order is ready/delivered).
**Confidence:** Confirmed (no queue/retry infrastructure exists anywhere in the dependency tree or codebase).

**Recommendation:** If guaranteed delivery of these notifications matters to the business, introduce a minimal durable queue (even a DB-backed "outbox" table with a periodic retry sweep would suffice — no need for Redis/BullMQ specifically) so failed sends are recorded and can be retried/alerted on, rather than vanishing into a log line.

**Dependencies/risks:** New infrastructure/table; needs a worker/cron to drain it (there is currently no cron infrastructure either — this would be new).

**How to validate later:** Simulate a WhatsApp API outage (point `WHATSAPP_API_URL` at an unreachable host in a test env) and confirm whether any record of the failed sends exists anywhere queryable afterward.

---

## 9. Retry / Failure-Recovery for External Calls

### ARC-016 — `GeocodingService.fetchJson`: raw `https.get` with no timeout — can hang indefinitely
**File:** `src/services/geocoding.service.ts`, `fetchJson` (lines 61-81), `geocodeAddress` (lines 89-111).

**Evidence:**
```ts
private fetchJson(url: string): Promise<...> {
  return new Promise((resolve, reject) => {
    https.get(url, res => { ... res.on('end', ...) }).on('error', reject);
  });
}
```
No `req.setTimeout(...)`, no `AbortController`/abort signal, no race against a timeout promise. The method's own doc comment (lines 83-88) says *"Never throws — a bad response, a network error, or a missing key all just resolve to null so a caller ... can fall back ... rather than fail the whole request."* — but a hang is not a throw: if Google's endpoint (or the network path to it) stalls without ever closing the connection or erroring, the returned `Promise` simply never settles, and `geocodeAddress()` awaits it forever.

**Concrete failure scenario:** A slow/hanging response from Google's Geocoding API (transient network partition, DNS stall, or Google-side slowdown) blocks whatever caller awaited `geocodeAddress()` — e.g. a pickup-request creation or customer-address save flow (per the file's own doc comment, lines 30-38) — for an indefinite period, tying up the request (and, depending on the HTTP server's own timeout configuration upstream, potentially the client connection) well past what the "never throws / never fails the whole request" design intent promises.

**Severity:** Medium. **Confidence:** Confirmed (no timeout mechanism present in the code).
**Recommendation:** Add an explicit timeout (e.g. `req.setTimeout(8000, () => req.destroy(new Error('geocoding timeout')))`) so a hang degrades to the same "resolve to null" fallback the comment already promises for other failure modes.
**How to validate later:** Point `GOOGLE_GEOCODING_API_KEY`'s requests at a host that accepts the connection but never responds, and confirm the caller eventually gets a result rather than hanging.

### Positive finding — WhatsApp outbound calls have an explicit timeout and controlled status handling
**File:** `src/services/whatsapp.service.ts`, `sendTemplateMessage` (lines 341-478). `requestConfig` sets `timeout: 10000`, `maxRedirects: 0`, `validateStatus: () => true` (406-413) — a deliberate, well-reasoned configuration (no silent redirect-following, explicit bounded timeout, and manual status-code handling rather than relying on axios's own throw-on-non-2xx). No retry on transient failure, but that gap is already captured under ARC-015 (no background retry infra generally) rather than a config mistake here.

### Needs validation — Razorpay SDK call timeouts not explicitly configured
**File:** `src/services/razorpay.service.ts`, `client` getter (lines 78-91) — the official `razorpay` npm SDK is constructed with only `key_id`/`key_secret`; no explicit timeout override is passed. Did not have time to trace the SDK's own internal axios defaults to confirm what timeout (if any) applies by default.
**Severity:** Low. **Confidence:** Needs validation.

### Positive finding — Email is only used for the OTP flow (a primary action, not a side-effect)
**Files:** `src/services/email.service.ts`, `src/services/otp.service.ts`. `EmailService` has exactly one caller in the whole codebase (`otp.service.ts:71`, confirmed by codebase-wide grep), used for the forgot-password OTP email — where failing loudly is actually correct behavior (email delivery IS the point of that endpoint), so the lack of a try/catch there isn't a failure-isolation gap the way it would be if email were used as a secondary notification on, say, order creation.

### ARC-027 — CONFIRMED LOW-MEDIUM: forgot-password email send has no timeout override and no try/catch, but the response text implies graceful handling
**Files:** `src/services/otp.service.ts`, `sendOtpEmail` (lines 52-71, `await this.emailService.sendMail(mailOptions)` at line 71, no try/catch); `src/controllers/auth.controller.ts`, `forgetPasswordSendOtp` (lines 505-545) — `await this.otpService.sendOtpEmail(user.email!, otp)` at line 542, also no try/catch, and the OTP/expiry is already persisted via `usersRepository.updateById` *before* this call (lines ~537-540).

**Evidence:** `src/utils/config.ts` configures nodemailer's `host`/`port`/`auth`/`tls` only — no `connectionTimeout`/`socketTimeout` override, so the app relies entirely on nodemailer's own defaults (which can be several minutes). The endpoint's response is `{message: 'If the email exists, an OTP will be sent.'}` (auth.controller.ts line 544) — phrasing that reads as "fire and forget, outcome doesn't block you" — but the actual code path is synchronous and will hang the HTTP request for however long the SMTP connection takes to fail, then surface a 500, not the soft message implied.

**Concrete failure scenario:** The SMTP provider is slow or unreachable; `POST /auth/forget-password/send-email-otp` hangs for minutes (bound only by nodemailer/OS defaults) before erroring, despite the OTP already being correctly written to the DB — a user-facing hang on a password-recovery flow, with the eventual error being generic rather than the implied "it'll arrive if it exists."

**Severity:** Low-Medium (availability/UX on a non-critical-path auth flow; no data loss — the OTP is safely persisted before the slow call). **Confidence:** Confirmed by code read.
**Recommendation:** Add an explicit transport-level timeout in `src/utils/config.ts`, and wrap the `sendMail` call in try/catch so the endpoint still returns its documented soft response even if the send is slow/fails, logging the failure for follow-up rather than surfacing a raw 500 or an indefinite hang.
**How to validate later:** Point the SMTP config at an unreachable host in a test environment and time how long `forgetPasswordSendOtp` takes to respond, and with what status/body.

---

## 10. API Rate Limiting / Abuse Protection

### ARC-017 — No rate limiting or abuse protection exists anywhere in the application
**Evidence:** `package.json` dependency list (lines 105-144) has no rate-limiting, throttling, or `helmet`-style hardening package. No custom middleware implementing this was found anywhere in `src/`. This is the same root cause as ARC-002 (login brute-force) but applies application-wide: OTP endpoints (`/auth/forget-password/send-email-otp`, `/auth/forget-password/verify-email-otp`, rider/customer OTP equivalents), payment-link creation, and every other public-ish endpoint have no request-volume defense beyond whatever sits in front of the app at the infra layer (unknown/out of repo scope — see Section 12 framing).
**Severity:** High (compounds directly with ARC-002; OTP-guessing in particular is a classic abuse vector — a 6-digit OTP with no rate limit is brute-forceable in a very small number of attempts). **Confidence:** Confirmed.
**Recommendation:** Add rate limiting at the application layer (don't rely solely on an assumed infra-level WAF/API gateway that wasn't visible in this repo) — at minimum on all `/auth/*`, `/*/auth/*`, and OTP verification endpoints.
**How to validate later:** Same as ARC-002's validation, specifically targeting `verify-email-otp`/OTP-verify endpoints with repeated wrong-code submissions.

---

## 11. Sensitive Data Exposure

### ARC-018 — `GET /riders` and `GET /riders/{id}` return the full `Users` entity, including the bcrypt password hash and OTP fields
**File:** `src/controllers/rider.controller.ts`, `find` (lines 343-359), `findById` (lines 406-420).

**Evidence:**
```ts
// find() — GET /riders
return this.riderRepository.find({
  ...filter,
  where: this.combineRiderWhere(filter?.where as object | undefined, searchWhere),
  include: [{ relation: 'user' }],                         // line 357 — NO fields restriction
});

// findById() — GET /riders/{id}
const rider = await this.riderRepository.findOne({
  where: { id, isDeleted: false },
  include: [{ relation: 'user' }],                          // line 416 — NO fields restriction
});
...
return rider;                                               // line 419 — returned as-is
```
The `Users` model (`src/models/users.model.ts`) declares no `hidden` properties at all (confirmed by full read — `password` (line 77), `resetPasswordOtp` (82), `resetPasswordOtpExpires` (87), `loginOtp` (90), `loginOtpExpires` (93) are all plain, unhidden properties), so every field — including the bcrypt password hash and the hashed password-reset/login OTP — is serialized into the JSON response for these two endpoints.

This is a **known, deliberately-handled risk everywhere else in the codebase**: the sibling `create` method in the very same file explicitly strips it — `rider: { ...rider, user: { ...user, ...userUpdates, password: undefined } }` (line 333) — and every other controller that embeds the `user` relation restricts `fields` to a safe allowlist (`approval.controller.ts:130`, `customer-profile.controller.ts:129-132`, `customer.controller.ts:431-434` & `596-599`, `employee.controller.ts:460-463` & `571-574`, `profile.controller.ts:105-108`, `rider-pickup.controller.ts:307` & `772`). `rider.controller.ts`'s `find`/`findById` are the **only** two call sites found that embed the `user` relation with no restriction whatsoever.

**Severity:** High (bcrypt hashes resist brute force but should never be exposed via API; the hashed OTP fields and other account metadata are also sensitive and were clearly intended to be excluded, per the codebase's own established pattern).
**Confidence:** Confirmed by direct code comparison against the rest of the codebase's own established (and self-evidently intentional) convention.

**Recommendation:** Add `scope: {fields: {id: true, fullName: true, email: true, countryCode: true, phone: true, username: true, isActive: true}}` to the `user` relation includes at lines 357 and 416, matching every other controller's convention — or add a model-level `hidden: ['password', 'resetPasswordOtp', 'resetPasswordOtpExpires', 'loginOtp', 'loginOtpExpires']` setting on `Users` as a blanket defense-in-depth measure so a *future* endpoint can't reintroduce this same mistake.

**Dependencies/risks:** None — purely additive query restriction; verify the admin-panel rider list/detail UI doesn't currently read anything off the now-removed fields (it shouldn't, since no legitimate UI need exists for a password hash).

**How to validate later:** Call `GET /riders` and `GET /riders/{id}` as an authenticated super_admin against a test rider and inspect the raw JSON response for a `user.password`/`user.resetPasswordOtp` field.

### ARC-019 — Needs validation: no model-level `hidden` defense means every future endpoint is individually responsible for remembering to strip these fields
Same root cause as ARC-018 — this is a systemic pattern risk (point-fix per call site rather than a blanket model-level guarantee), not a second confirmed leak. Flagged separately because fixing only ARC-018's two call sites leaves the underlying fragility in place for the next new endpoint.
**Severity:** Medium (pattern/process risk). **Confidence:** Confirmed as a pattern; no additional confirmed leak site found beyond ARC-018 in the time available.
**Recommendation:** Add the `hidden` model setting described above as the actual fix, rather than only patching the two known call sites.

---

## 12. Backup & Disaster Recovery Readiness

**Evidence:** No backup scripts, DB dump files, or automated-backup tooling exist anywhere in the repository (`find . -iname "*.sql" -o -iname "*backup*" -o -iname "*dump*"` turns up only `scripts/audit-user-integrity.sql`, an integrity-check query, not a backup mechanism). This is expected — backup/DR for a managed Postgres instance is almost always a production-infrastructure concern (managed-DB provider snapshots, WAL archiving, etc.) that lives outside an application repo, not something this codebase would be expected to implement.

**Severity:** N/A (infra question, not a code defect). **Confidence:** Needs validation — this audit cannot confirm or deny backup/DR posture from the repo alone; it must be validated against actual production/infra configuration (DB provider's backup settings, retention policy, and a tested restore procedure), which was out of scope for a code-only review.

**Schema-change/rollback posture (checked directly, not just assumed):** `package.json`'s ~25 `migrate:*` scripts each run a standalone `scripts/*.cjs` file with no `down()`/rollback counterpart and no migration-state tracking table — recovering from a bad schema change in prod has no automated reverse path, only a DB snapshot/restore. Two specific higher-stakes one-off scripts were inspected directly: `scripts/wipe-master-tables.cjs` (deletes all rows in 9 master tables) **does** refuse to run without an explicit `--yes` flag (checked at line 32: `if (!process.argv.includes('--yes')) { console.error('Refusing to run without --yes...'); process.exit(1); }`), and `scripts/clone-staging-catalog-to-production.cjs` (wholesale-replaces 5 production catalog tables from staging) **defaults to a dry run** and only executes inside a transaction when passed `--apply` (checked at lines 63-100: `const apply = process.argv.includes('--apply'); ... if (!apply) return; ... await prod.query('BEGIN');`). Both scripts have reasonable in-script safety gates — this is better than it might first appear — but the underlying DR-relevant gap stands: there is still no rollback mechanism for an applied schema migration itself, only for these two specific data-mutation scripts choosing to guard themselves individually. Severity: Low-Medium (process risk, mitigated by the two scripts' own guards). Confidence: Confirmed by direct code read.

---

## 13. Failure Isolation / Graceful Degradation

**Overall assessment: this is one of the stronger areas of the codebase.**

- `dispatchWhatsApp()` (`whatsapp.service.ts` lines 93-101) is explicitly documented as being called "after their writes/transaction commit succeed," and wraps every WhatsApp side-effect in a `.catch()` that only logs — a WhatsApp outage cannot roll back or block an order/payment/shift action. Confirmed at multiple call sites (e.g. `order.service.ts` notification calls after status changes, `wallet.service.ts` lines 164-170 and 297-303, `rider-delivery` flows).
- `notificationService.notifyRider(...).catch(() => {})` pattern (e.g. `order.service.ts` ~2746-2750, 2806-2814) — FCM push failures are explicitly non-blocking, with an inline comment stating exactly this intent ("a slow/unreachable FCM call must never delay or block the status change").
- `GeocodingService.geocodeAddress` (barring the timeout gap in ARC-016) is designed to degrade to `null` rather than fail the caller's request, with the caller (per its own doc comment) falling back to existing `NOT_SERVICEABLE` handling.
- Razorpay's `markPaidAndApply` deliberately marks a `GatewayPaymentLink` `PAID` even if `applyPayment` throws (lines 483-492), with the error captured in `applicationError` for manual reconciliation — "the money genuinely arrived... never lose that fact" (comment, lines 487-490). This correctly prioritizes not losing track of real money received over a clean application-layer result.

**The one confirmed gap in this otherwise well-isolated design is ARC-014** (the webhook's own stated "always 200" degradation guarantee is not actually met for one failure class) **and ARC-016** (geocoding's "never throws" promise doesn't cover hangs). Both are cross-referenced here rather than duplicated.

---

## Summary Table

| ID | Area | Severity | Confidence |
|---|---|---|---|
| ARC-001 | Auth — stale roles/permissions in JWT, no revocation | High | Confirmed |
| ARC-002 | Auth — no brute-force protection on login | High | Confirmed |
| ARC-003 | Auth — dead/buggy generateShortToken | Low | Confirmed |
| ARC-020 | **Unauthenticated file upload/list/download controller** | **Critical** | **Confirmed** |
| ARC-021 | Login OTP returned in plaintext when WHATSAPP_ENABLED=false | High | Confirmed (code); env exposure needs validation |
| ARC-022 | `isActive` check commented out in dead `verifyCredentials` | Low | Confirmed (dead code) |
| ARC-004 | Store scoping — not exhaustively verified everywhere | N/A | Needs validation |
| ARC-022b* | `GET /invoices`, `/invoices/count` leak invoices across stores | High | Confirmed |
| ARC-023 | 5 order sub-resource endpoints skip store-visibility check (incl. a write) | High | Confirmed |
| ARC-024 | Gateway-payment-link `findById` — no permission or store check | Medium | Confirmed |
| ARC-025 | Bag list/detail — no store filter, no permission gate | Low-Medium | Needs validation |
| ARC-026 | Rider endpoint scoping not exhaustively traced | N/A | Needs validation |
| ARC-005 | Order status transitions — unprotected for most states | Medium-High | Confirmed |
| ARC-006 | Delivery cancel — no transaction across 4 writes | Medium | Confirmed |
| ARC-007 | Garment actions — inconsistent locking | Low-Medium | Needs validation |
| ARC-008 | WalletService.credit/debit — no transaction at all | High | Confirmed |
| ARC-009 | Order checkout wallet debit — stale balance, no row lock | High | Confirmed |
| ARC-010 | SecurityDepositService — same pattern as ARC-008 | High | Confirmed |
| ARC-011 | Shift open() — TOCTOU race, no DB constraint, known prior incident | High | Confirmed |
| ARC-012 | Shift close() — same pattern, lower impact | Low-Medium | Confirmed |
| ARC-013 | WhatsApp dedup cache is process-local | Low | Needs validation |
| ARC-026b* | Order creation has no idempotency key — double-submit risk | Medium-High | Confirmed |
| ARC-014 | Webhook "always 200" not guaranteed for payload mismatches | Medium | Confirmed |
| ARC-015 | No background job/retry/dead-letter infrastructure at all | Medium | Confirmed |
| ARC-016 | GeocodingService — no timeout, can hang indefinitely | Medium | Confirmed |
| ARC-027 | Forgot-password email send — no timeout/try-catch, can hang | Low-Medium | Confirmed |
| ARC-017 | No rate limiting/abuse protection anywhere | High | Confirmed |
| ARC-018 | GET /riders, /riders/{id} leak password hash + OTP fields | High | Confirmed |
| ARC-019 | No model-level `hidden` defense for Users — systemic fragility | Medium | Confirmed (pattern) |

*ARC-022b and ARC-026b are numbered out of strict sequence (added during a follow-up verification pass that cross-checked a second independent review of the same codebase); IDs are kept as first assigned rather than renumbered, to avoid breaking in-document cross-references.
