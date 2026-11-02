# Pressto — Full-Stack Production Readiness & Performance Audit

**Date:** 2026-11-01
**Branch:** `code-audit` (created fresh off `main`/`master` in each of `pressto_backend`, `pressto-admin-panel`, `pressto-customer-web`)
**Mode:** Read-only audit. No application code, schema, or data was modified. No migrations, restarts, or deploys were run.
**Method:** One lead/orchestrator pass + 5 independent specialist agents (Database, Backend/LoopBack4, Frontend, Infrastructure, Architecture/Security/Reliability), each producing an evidence-formatted report. Full specialist reports are included as appendices in this same `audit-reports/` folder: `db-audit.md`, `backend-audit.md`, `frontend-audit.md`, `infra-audit.md`, `architecture-security-audit.md`. This document consolidates and prioritizes their findings; finding IDs (e.g. `DB-009`, `BE-005`, `ARC-020`) refer to those files for full evidence (exact file:line, queries, EXPLAIN plans).

---

## 1. Executive Summary

Pressto's backend shows clear evidence of at least one prior, deliberate performance-remediation pass — the connection pool, PM2 cluster mode, and the order-listing endpoint all carry comments documenting real past incidents and the fixes applied. That pass did not reach most of the codebase. What's left is a consistent pattern repeated across the database, backend, and both frontends: **several of the highest-traffic screens and endpoints fetch an entire (or unbounded) result set and page, filter, or aggregate it after the fact**, rather than pushing that work down to the database. At current data volumes (2M orders, 5M order items, 9M garments) this is already measurably expensive in the database (confirmed full-table scans); at concurrent production load it is the most direct path to another cutover-style incident (pool exhaustion from a handful of staff opening the wrong screen at once).

Two findings sit above everything else and should be treated as pre-production blockers independent of any performance work:

- **Unauthenticated file storage (`ARC-020`, Critical):** `pressto_backend/src/controllers/file-upload.controller.ts` has zero `@authenticate`/`@authorize` on any of its 6 routes. Anyone who can reach the API can enumerate and download every file in shared storage (customer documents, garment damage photos) with no login, or upload an HTML file and have it served inline from the API's own origin. This is a live data-exposure and stored-XSS risk, not a performance issue, and is unrelated to and more urgent than the rest of this report.
- **Missing referential integrity (`DB-001`/`DB-002`, High, Confirmed):** only 2 of 121 tables have a database-enforced foreign key. Live orphan rows already exist (22 `order_item`, 5 `payment_transaction`) proving this is not theoretical.

Beyond those two, the pattern that will matter most under concurrent production traffic is **unbounded/unpaginated endpoints that fan out per-row enrichment queries**: `GET /approval-requests` and `GET /transfers` (`BE-005`, `BE-002`, both Critical) can each turn 2-3 staff opening a screen into a pool-exhausting burst of queries sized to the whole table, not a page. The order-creation hot path (`BE-008`, Critical) does 80-300+ sequential DB round-trips per order for a 20-item ticket. On the frontend, Customer Web fetches up to 200 orders per screen load and ships zero code-splitting (`FE-CW-001/006`, High), and Admin Panel silently drops server-side pagination the moment a payment-status filter is applied (`FE-ADM-003`, High).

A separate, quieter class of findings is concurrency/consistency bugs that don't need high traffic to bite, only bad timing: wallet and security-deposit balances are read-then-written with no transaction or row lock (`ARC-008/009/010`, High — real money drift under two near-simultaneous payments), shift-opening has a known, previously-incident-causing TOCTOU race that was narrowed but not closed (`ARC-011`, High), and order creation has no idempotency key, so a double-tap can create two orders (`ARC-026b`, Medium-High).

Finally, this audit confirmed the application has **no observability layer at all**: no structured logger, no log rotation, no APM/error-tracking, no `pg_stat_statements`, and no automated/tested backup process (`INF-009/011/015`). That gap doesn't cause an outage by itself, but it means every other finding in this report — and any real production incident — is currently hard to diagnose and will stay that way until closed.

**What this audit could and could not verify:** this was run entirely from the user's local Windows dev machine against a local, migration-seeded Postgres replica and the three apps' git working trees. There is no SSH access to the actual Ubuntu production server. Structural findings (schema, missing indexes, missing auth, missing transactions, code logic) are verified directly from source and are trustworthy regardless of where they run. Anything described as "needs production validation" — real CPU/RAM/connection numbers, actual `postgresql.conf`, Nginx config, real traffic volume — could not be measured and is explicitly flagged rather than estimated anywhere in this report.

---

## 2. System Architecture and Verified Environment

**Repositories present and audited (each now on a `code-audit` branch):**

| Repo | Stack | Role | Git state at audit start |
|---|---|---|---|
| `pressto_backend` | LoopBack 4 / Node.js / TypeScript | API backend, single source of business logic | Clean except pre-existing, unrelated in-progress WIP on `shift.controller.ts` (a shift cash-reconciliation query fix) — left untouched throughout this audit |
| `pressto-admin-panel` | CRA/React (`@minimal-kit/cra-js`) | Serves **both** "admin panel" and "employee/counter-staff panel" roles via role-gated routes in one app — confirmed no separate employee-panel codebase exists | Clean |
| `pressto-customer-web` | Vite/React | Customer-facing web app | Clean |

**Not audited / does not exist as a separate codebase:**
- No rider-facing frontend (mobile or web) repo is present locally. Rider functionality found here is (a) store/admin-side rider management inside `pressto-admin-panel` (`src/pages/riderManagement/*`), and (b) backend-only rider APIs documented in `pressto_backend`'s `RIDER_APP_*.md` files. Whatever client actually consumes those rider APIs was not available to audit.
- `pressto-client` (sibling folder) is **not a git repo** — it is a stale staging-deployment bundle (nested copies of the three real repos, plus a staging DB dump and a pm2 `ecosystem.config.js`), not a distinct application.

**Verified environment facts (from local artifacts):**
- PostgreSQL version on the local replica: **17.7** (Windows build). Production is stated to run PostgreSQL 16 — **unverified**, treat as a user claim.
- Database: `pressto_migration`, 14.37 GB (119 tables, 230 indexes, 0 views, 1 sequence).
- Backend process topology: PM2 **cluster mode**, 2 instances (`ecosystem.config.js`), each with its own Postgres pool (`max: 15`) — both already tuned following a documented prior incident (see `BE` positive finding under §5).
- TLS: a commercially-issued (RapidSSL/DigiCert) wildcard cert for `*.press2india.com`, valid until **2027-03-24** (~4.5 months from audit date), no local evidence of automated renewal (`INF-008`).
- Deploy mechanism: PowerShell scripts (`deploy/*.ps1`) that build locally, zip, `scp` to a single SSH host (`pressto-svr1` → `192.168.1.210`), and run `pm2 restart` — not containerized despite a working `Dockerfile` existing (`INF-007`).

**Explicitly unverified (claimed by the user, not measured by this audit):** Ubuntu OS, 8 vCPU, 16 GB RAM, single server hosting backend+database+frontends together, Nginx as reverse proxy. The one piece of local evidence that contradicts a detail of this claim: `ecosystem.config.js` currently runs the backend in **2** PM2 cluster instances, not the "one PM2 backend instance" stated in the brief (`INF-001`) — whether that's since changed, or the brief's description is slightly stale, needs confirming with whoever manages the server.

---

## 3. Production Cutover Incident — Evidence and Possible Contributing Factors

This audit was not given incident logs, timestamps, or error traces from the actual cutover, so nothing below is a confirmed root cause — it is a list of mechanisms **already present in the code today** that are consistent with the kind of failure a cutover (a sudden jump from near-zero to real concurrent load) would trigger. Several are explicitly documented in the code itself as fixes for a **previous** real incident, which is useful context: this is evidently not the first time load has caused a problem here.

- **Self-documented prior incidents already fixed:** `pressto.datasource.ts`'s connection pool previously had no configured `max` (silently defaulting to 10) and no `connectionTimeoutMillis`, causing requests to hang indefinitely once exhausted — "looking like the whole app had hung" (code's own words). `ecosystem.config.js` was previously running the backend in single-instance fork mode, which stalled under ~100 concurrent staff logins/searches on one core before being switched to 2-instance cluster mode. `order.service.ts`'s free-text order search previously built an unbounded customer-ID `IN` list. These are **not open findings** — they are evidence of the kind of failure mode this system is prone to, and that the same class of bug (unbounded fetch → fan-out → pool pressure) is still present elsewhere today (see §10below).
- **Mechanisms that could reproduce a similar incident today:** `GET /approval-requests` (`BE-005`) and `GET /transfers` (`BE-002`) are both still unbounded today, each capable of exhausting the same 15-connection-per-instance pool with just 2-3 concurrent staff. The order-creation pricing path (`BE-008`) does 80-300+ sequential round-trips per order — a store/cluster price-list change that widens the per-order service count makes every single order proportionally slower, exactly the kind of thing that looks fine in isolated testing and compounds badly the moment real concurrent counters are taking orders.
- **Shared-server contention, acknowledged by the codebase's own authors:** `ecosystem.config.js`'s comment explicitly warns that "this server also runs migration (and, when active, staging) side by side" and cautions against raising `instances` "without checking actual core count... risks starving them instead" (`INF-006`). If the cutover coincided with any migration/staging activity on the same box, this is a plausible contributing factor that can only be confirmed with real server access.
- **No observability to have caught it in flight:** there was (and is) no structured logging, no APM, no request-correlation ID (`BE-018`, `INF-009/011`) — meaning a cutover-time incident would show up only as "it was slow/down," with no way after the fact to say *which* endpoint, query, or resource was the actual bottleneck. This is the single biggest reason this audit cannot give a more specific answer about what actually happened, and the single highest-leverage fix for being able to answer this question next time.

**Recommended immediate step, independent of any other fix in this report:** enable `pg_stat_statements` (`DB-008`) and add basic structured logging + a request-correlation ID (`BE-018`) before the next deploy, so the *next* incident — cutover-scale or not — leaves evidence instead of just a support ticket.

---

## 4. Database Audit

Full detail: `audit-reports/db-audit.md` (16 findings, DB-001 through DB-016).

**Scale:** 14.37 GB total — `invoice` (1.97M rows, 3.68 GB), `garment` (~9.35M rows, 3.26 GB), `order_item` (5.12M rows, 1.68 GB), `orders` (1.97M rows, 1.48 GB), `order_status_history` (~3.98M rows), `order_handover` (1.95M rows), `garment_damage` (~4.15M rows), `payment_transaction` (1.94M rows) account for the overwhelming majority of database size. `invoice` + `garment` alone are ~48% of total size.

**Headline findings:**
- **`DB-001`/`DB-002` (High/Medium, Confirmed) — almost no referential integrity.** Only 2 of 121 tables have a DB-enforced FK (both trivial sequence-counter tables). Every core relationship — `orders→customer`, `order_item→orders`, `garment→order_item`, `payment_transaction→orders` — is enforced only in LoopBack application code. Live, read-only orphan checks already found 22 orphaned `order_item` rows and 5 orphaned `payment_transaction` rows. This is not systemic corruption (other relationships checked came back clean) but proves the gap is real, not theoretical.
- **`DB-009` (High, Confirmed via EXPLAIN) — full-table scan on the "pending orders" view for global/unscoped callers.** `order.service.ts`'s `status NOT IN (...)` filter can't use the existing plain btree on `status`; when no `storeId` is resolved (a global/super-admin caller), Postgres falls back to a parallel sequential scan of the full ~2M-row `orders` table. Store-scoped calls are unaffected (they hit the existing composite index first).
- **`DB-005` (Medium, Confirmed) — missing index, confirmed by an actual code path.** `payment_transaction.riderid` (1.94M rows) is filtered in `rider-performance.controller.ts` with no supporting index; a wide date range degrades to a parallel sequential scan of the whole table.
- **`DB-013` (High if also true in production, Confirmed locally) — Postgres memory settings are all factory defaults** on a 14 GB database (`shared_buffers` 128MB, `work_mem` 4MB, `effective_cache_size` 4GB) — essentially untuned, and biasing the planner toward sequential scans, consistent with `DB-009`.
- **`DB-008` (Medium, audit-capability gap) — `pg_stat_statements` is not installed.** There is no DB-side record of real query frequency/cost; every performance finding in this report had to be derived from code + planner estimates, not actual execution data. This should be enabled in production regardless of anything else in this report.
- **Positive findings:** zero duplicate/redundant indexes across all 230 indexes checked (`DB-007`); `pg_trgm` GIN indexes already correctly back wildcard customer/order/invoice search (`DB-012`); the main order-listing query already batches related-record lookups correctly (no classic N+1, informational note under §C).
- **`DB-003` (Low, Confirmed) — a schema landmine:** `customer.userid` is typed `text` while `users.id` (and all 117 other primary keys) is `uuid`. Works via the ORM's implicit cast; breaks in raw SQL/BI tooling without one.
- **`DB-011`/`DB-016`: stats-counter and bloat findings** that are explicitly flagged as possibly artifacts of this local instance's migration-seeding, not necessarily representative of production — see `db-audit.md` for the caveat on each.

**What needs production access to confirm:** whether production shares this same untuned `postgresql.conf`; actual `max_connections` and whether other environments (staging/migration) share the same server and connection budget (code already flags this as unverified, `DB-015`); real `pg_stat_activity`/lock contention under actual load.

---

## 5. Backend and API Audit

Full detail: `audit-reports/backend-audit.md` (18 findings, BE-001 through BE-018).

This codebase shows a prior, deliberate performance-remediation pass (documented in-line in `order.service.ts`, `pressto.datasource.ts`, `ecosystem.config.js`, `whatsapp.service.ts`). Findings below are what survived that pass, concentrated in endpoints the pass didn't reach.

**Critical:**
- **`BE-002` — `GET /transfers` has no pagination at all.** No `limit`/`skip` exist on the method signature; returns every transfer in the system, then two further unbounded `inq` queries in `enrichTransfers()`. `/transfers/export` explicitly reuses this same unpaginated method as its *only* path — there is no paginated path for this resource anywhere.
- **`BE-005` — `GET /approval-requests` ignores pagination at the DB level for store-scoped callers entirely**, and has no default/max limit for global callers. Each row is then enriched via `Promise.all` running 3-5 sequential queries per row — so the concurrent fan-out width is the *whole matching table*, not a page. This is the single most severe concurrency-risk finding in the backend audit: 2-3 staff opening this screen with no filter can by itself exhaust the 15-connection pool.
- **`BE-008` — Order creation's pricing resolution is sequential, not batched.** `resolvePricing()` does ~4-5 sequential DB round-trips per `(serviceId, itemId)` pair, called once per item and once per additional-service-per-item in a plain loop. A 20-item order with add-ons triggers 80-300+ sequential round-trips inside one order-creation HTTP request — the highest-frequency, most latency-sensitive write path in the app (POS counter flow).

**High:**
- **`BE-003`** — `GET /deliveries` has the identical unpaginated pattern as `BE-002`.
- **`BE-004`** — Finance/Ops reports (`buildPendingPayments`, `buildPendingTickets`, `buildOnAccountBilling`, `buildSalesGst`, `buildPettyCashExpense`) fetch the full date-bounded result set and enrich all of it before slicing to a page — a full-year report costs the same as the whole dataset regardless of requested page size.
- **`BE-006`** — `GET /sales-returns` fetches everything, joins the full set to `orders`, and pages only after that.
- **`BE-014`** — `GeocodingService` uses raw `https.get` with **no timeout**, awaited inline in the customer address-save path. A hang on Google's side hangs the request indefinitely.

**Medium:**
- **`BE-013`** — Dashboard service fetches a store's entire lifetime order history (not time-windowed) twice, independently, on every landing-page load.
- **`BE-015`** — SMTP OTP email send has no explicit timeout (relies on nodemailer defaults up to ~10 min).
- **`BE-018`** — No request-correlation/trace ID anywhere in the stack — makes diagnosing every other finding here harder once in production.
- **`BE-009`/`BE-010`/`BE-011`** — several N+1-shaped write loops (media status update, process-log update, garment status transitions) — low/medium severity, bounded by typical batch size.

**Positive findings (no action needed):** connection pool (`max:15`, `connectionTimeoutMillis:10000`) and PM2 cluster topology are already correctly tuned with documented reasoning; the main order-listing endpoint (`listOrders`) is already the reference implementation for correct batched-pagination and should be the pattern other endpoints above are brought up to; console logging was swept and found clean of sensitive data; WhatsApp's outbound HTTP call already has a correct, explicit timeout and is the reference pattern other external calls (Razorpay, Geocoding, SMTP) should follow.

---

## 6. Frontend Audit

Full detail: `audit-reports/frontend-audit.md` (findings FE-ADM-001 through FE-ADM-009, FE-CW-001 through FE-CW-008).

### Admin/Employee Panel (`pressto-admin-panel`)
- **`FE-ADM-003` (High, Confirmed)** — the "Manage Ticket" (order status) screen drops server-side pagination entirely the moment a Payment Status filter is set: `limit`/`skip` become `undefined`, the backend's unbounded response is fetched in one call, and pagination moves to a client-side `.slice()` — while the screen keeps polling every 10 seconds.
- **`FE-ADM-001`/`FE-ADM-002` (Medium, Confirmed)** — the Order Status toolbar's customer/ticket/invoice search and the Rider Management search both fire one request per keystroke; the correct debounce pattern (`useDebounce`) already exists and is used correctly elsewhere in the same codebase (User Management list), so this is an inconsistency, not a missing capability.
- **`FE-ADM-006` (Medium, Confirmed)** — the full Redux Toolkit + react-redux + redux-persist stack ships for a single unused demo "checkout" slice; every real screen runs on SWR + local state instead.
- **`FE-ADM-008` (Medium, Strong indication)** — no list-row component anywhere uses `React.memo`; the order-status table's 10-second poll fully re-renders all visible rows (each with ~8 icon-button/tooltip pairs) every cycle regardless of whether any row's data actually changed.
- **`FE-ADM-004`/`FE-ADM-007`** — a payment-invoice dialog polls 3 endpoints every 5 seconds while open (Medium); two independent map libraries plus always-loaded CSS for Quill/Slick/Mapbox ship at the app root regardless of route (Medium).
- **Positive/control findings:** no optimistic-update consistency risk found on payment/stock-affecting flows; no unoptimized raw `<img>` pattern at scale; the debounce+server-pagination pattern is known and correctly used on 18+ other master-data screens — the findings above are inconsistency gaps, not an unsolved problem for this codebase.

### Customer Web (`pressto-customer-web`)
- **`FE-CW-001`/`FE-CW-002` (High, Confirmed)** — the "My Orders" screen fetches up to 200 orders (`ORDERS_FETCH_LIMIT`) plus two full, unpaginated pickup-request requests on every filter change or page load, then paginates only 5 rows client-side. This is the clearest instance of the "fetch everything, paginate client-side" anti-pattern in either app, on the app most likely to be used over mobile data.
- **`FE-CW-006` (High, Confirmed)** — zero route-based code splitting: `App.jsx` statically imports all ~35 pages (full order-booking wizard, settings, messages, wallet, etc.) into one bundle. The sibling admin-panel app already demonstrates the correct `React.lazy` pattern throughout; this app has none of it.
- **`FE-CW-004` (Medium, Confirmed)** — no shared data-fetching/caching library; a single ~2,500-line hand-rolled `SessionContext` does both persistence and ad hoc caching, with a real 5-minute TTL cache existing for exactly one data type (pending approvals) and no equivalent for orders, wallet, addresses, pickup slots, or catalog data.
- **Positive/control findings:** text search on the Orders page IS correctly debounced; no optimistic-update risk found on the wallet-payment path; session bootstrap (7 parallel calls after login) is correctly deduplicated against re-firing, just noted as a baseline worth knowing if "slow after login" is ever reported.

**Not measured in either app (explicitly, per the audit's own read-only scope):** actual bundle sizes/byte impact of any dependency — all such findings are flagged "not measured" and would need a real `npm run build` + bundle-analyzer pass, deliberately not run as part of this read-only audit.

---

## 7. Infrastructure and Deployment Audit

Full detail: `audit-reports/infra-audit.md` (16 findings, INF-001 through INF-016). **This section is the one most limited by this audit's lack of production server access** — most findings here are "confirmed in committed config" paired with "needs production access to know the real-world impact."

- **`INF-002`/`INF-003` (High, Confirmed) — no real migration or rollback story.** ~25 separate manual npm scripts, no ordered/versioned migration ledger — the deploy script's own doc-comment admits "DB migration step is still a manual follow-up." No previous build is retained before being overwritten (`rm -rf dist` before unzip) — the only stated recovery from a bad deploy is re-running the whole pipeline from a known-good commit.
- **`INF-006` (High, Confirmed) — three environments (staging/migration/production) share one server**, explicitly acknowledged as a contention risk in the codebase's own comments, not speculation by this audit.
- **`INF-013` (High, self-flagged by the code) — Postgres connection budget across environments is unverified.** The datasource's own comment does the math (`PM2_INSTANCES × PG_POOL_MAX` = 30 for production alone) and explicitly says this was never checked against the server's real `max_connections`, especially with staging/migration sharing the same budget.
- **`INF-009`/`INF-011` (Medium/High, Confirmed) — no logging library, no log rotation, zero monitoring/APM/error-tracking** anywhere in any of the three app repos' dependencies.
- **`INF-015` (High, Confirmed) — backups are manual and irregular**, with no cron/automation found; one genuine past restore-verification exists but was a one-off, not a recurring tested process.
- **`INF-001` (Medium) — deploys use `pm2 restart`, not `pm2 reload`** — PM2 cluster mode's zero-downtime capability exists in config but isn't exercised operationally, per the committed script text.
- **`INF-004` (Medium)** — a `/ping` health endpoint exists in code but is never curled after a deploy to confirm the new build is actually healthy.
- **`INF-008` (Low today)** — TLS cert valid to 2027-03-24, no evidence of auto-renewal — a calendar risk to track, not an active problem.
- **`INF-007` (Low)** — a working Dockerfile exists but the real deploy path doesn't use it; the two "how to run this" definitions can drift apart unnoticed.

**Cannot be assessed from this machine at all, listed explicitly rather than guessed at:** real CPU/RAM/disk/network utilization; actual Nginx config (no `nginx.conf` found locally — its worker/timeout/TLS settings are entirely unverified); actual PostgreSQL config and real Postgres-vs-Node resource contention; actual Node version/PM2 instance count/restart history running on the real server; whether a backup cron exists server-side independent of the ad hoc dumps found locally; real request latency/throughput/error-rate data (needed to confirm or refute whether Redis/queues/read-replicas are actually warranted, rather than speculative).

---

## 8. Security, Reliability and Data Consistency Audit

Full detail: `audit-reports/architecture-security-audit.md` (29 findings, ARC-001 through ARC-027 plus ARC-022b/ARC-026b).

### Critical
- **`ARC-020` — `FileUploadController` has zero authentication on all 6 endpoints.** Unauthenticated upload, directory listing, and download of every file in shared storage (customer documents, garment damage/stain photos). One download variant's own code comment admits "no Content-Disposition (browser will preview if possible)" — an uploaded HTML file renders inline, same-origin as the API: stored XSS/phishing risk, plus unrestricted-upload disk-fill DoS. Path traversal is correctly defended against; the auth gap is the issue. This is the single most severe finding across the entire audit and should be fixed before anything else in this report.

### High
- **`ARC-008`/`ARC-009`/`ARC-010` — wallet, order-checkout wallet-debit, and security-deposit balances are all read-then-written with no transaction and no row lock anywhere in their respective files.** Two near-simultaneous payments against the same customer (a realistic scenario: an in-app top-up confirming while a store counter keys an admin recharge for the same walk-in customer) produce a lost update — real wallet-balance drift against the ledger, on the live checkout path, not an admin-only tool.
- **`ARC-011` — Shift `open()` has a known, previously-incident-causing TOCTOU race that was narrowed but not closed.** The model's own doc comment documents a real prior production incident of two simultaneous open shifts at one store; the applied fix broadened the duplicate-check filter but didn't add a transaction, lock, or DB constraint — true concurrent requests can still reproduce the exact incident.
- **`ARC-022b` — `GET /invoices`/`/invoices/count` return every store's invoices to any staff holding plain `order:read`**, with no store filter anywhere in the shared `_buildInvoiceWhere()` — despite `StoreScopeService` being correctly used elsewhere in the very same file.
- **`ARC-023` — five order sub-resource endpoints skip the store-visibility check** that three sibling endpoints in the same file correctly use, including a **write** endpoint (`correctPaymentMode`) that lets any `payment:update` holder relabel a payment on an order that was never theirs.
- **`ARC-018` — `GET /riders`/`GET /riders/{id}` are the only two call sites in the codebase that embed the `user` relation with no field restriction**, leaking the bcrypt password hash and hashed OTP fields — every other controller in the codebase correctly restricts this.
- **`ARC-001`/`ARC-002`/`ARC-017` — no permission re-validation after login (stale roles/active-status for up to the 7h token lifetime), no brute-force protection on login, no rate limiting anywhere in the application.** A terminated/compromised account's existing token keeps working for up to 7 hours after revocation; login and OTP endpoints have no attempt limiting at all.

### Medium-High / Medium
- **`ARC-026b` — order creation has no client-supplied idempotency key** — a double-tap/retried request can create two real orders (and two cash-payment records, if cash was included inline). The Razorpay/online-payment leg is separately protected and not at risk this way.
- **`ARC-005` — most order-status transitions run with no transaction or lock**; only three specific transitions (`RECEIVED_AT_STORE`, draft-exit, `DELIVERED`) correctly use `SELECT ... FOR UPDATE`. Two near-simultaneous status changes on the same order can silently drift the persisted status from the status-history log.
- **`ARC-014` — the payment webhook's own documented "always 200" design intent is not actually met for payload-mismatch failures** — those throw uncaught before reaching the one method designed to swallow them, so Razorpay gets a real 400 and retries a deterministically-unfixable failure forever.
- **`ARC-015` — no background job/queue/retry infrastructure exists at all.** A WhatsApp provider outage permanently loses every customer notification issued during that window, with no record to replay afterward (though the core order/payment flow itself is correctly unaffected — see positive note below).
- **`ARC-021` — the login-OTP service returns the real OTP in the API response when `WHATSAPP_ENABLED=false`** — a deliberate, documented outage fallback, but the shipped `.env.example` template defaults to exactly that flag value, making this one env-var mistake away from a full OTP-auth bypass on a misconfigured environment.
- **`ARC-006` — `DeliveryController.cancel`** runs 4 independent writes (order, delivery, bag, custody event) with no shared transaction — a mid-sequence crash can leave a bag permanently "in use" or an order with a stale rider assignment.

### Positive findings worth preserving
- Razorpay's payment-application path (`markPaidAndApply`) is correctly idempotent via a row lock + recheck, and both confirmation paths (Checkout popup and webhook) funnel through it.
- WhatsApp notification dispatch is deliberately decoupled from the business transaction (fire-and-forget, logged failures, de-duplicated by key) — a messaging outage cannot block or roll back an order/payment/shift action. This failure-isolation design is one of the stronger parts of the codebase.
- Petty cash has no stored balance at all (always derived live from the ledger) — a sound design that avoids the whole read-modify-write race class by construction.
- Coupon redemption correctly locks both the coupon and customer rows before applying.
- `StoreScopeService` itself is well-designed (fail-closed, anti-enumeration 404-not-403) and consistently used across ~20 controllers — the gaps found (`ARC-022b`/`ARC-023`/`ARC-024`) are specific missed call sites within an otherwise-sound mechanism, not a design flaw.

---

## 9. High-Volume Tables and Data Distribution

(See §4 for full table; summarized here as requested by the report structure.)

| Table | Rows | Total size | Growth pattern |
|---|---|---|---|
| `invoice` | 1,970,874 | 3.68 GB | Append-heavy, one per invoice event |
| `garment` | ~9,354,682 (est.) | 3.26 GB | Fastest-growing — one row per physical garment per order |
| `order_item` | 5,118,598 | 1.68 GB | One per line item per order |
| `orders` | 1,972,622 | 1.48 GB | Core transactional table |
| `order_status_history` | ~3,983,713 (est.) | 0.96 GB | Append-only audit log — grows with every status change, never pruned |
| `order_handover` | 1,949,395 | 0.71 GB | One per handover event |
| `garment_damage` | ~4,148,472 (est.) | 0.64 GB | Append-heavy |
| `payment_transaction` | 1,940,850 | 0.50 GB | Core financial ledger |

`garment`, `order_item`, `order_status_history`, and `garment_damage` are all append-heavy, per-event logging-style tables with no visible archival/retention policy — they will keep growing fastest and compounding the index-coverage and full-scan risks identified in §4 and §11 if left unaddressed. No excessive/redundant historical data was flagged as needing cleanup specifically — the volume itself is the finding, not data that shouldn't exist.

---

## 10. Critical APIs and Query Performance

Ranked by concurrent-traffic risk (most dangerous first):

1. **`GET /approval-requests`** (`BE-005`, Critical) — unbounded fetch + N-wide parallel fan-out of 3-5 queries per row.
2. **`GET /transfers`** and its `/export` variant (`BE-002`, Critical) — no pagination at all, ever.
3. **Order creation pricing resolution** (`BE-008`, Critical) — 80-300+ sequential round-trips per order on the highest-frequency write path.
4. **`GET /deliveries`** (`BE-003`, High) — same unpaginated pattern as `/transfers`.
5. **Finance/Ops reports** (`BE-004`, High) — `buildPendingPayments`/`buildPendingTickets`/`buildOnAccountBilling`/`buildSalesGst`/`buildPettyCashExpense` — full-range fetch, enrich-everything, page-in-memory.
6. **`GET /sales-returns`** (`BE-006`, High) — unbounded fetch, full join, then page.
7. **"Pending orders" admin view for unscoped/global callers** (`DB-009`, High) — confirmed parallel sequential scan of the full `orders` table.
8. **Dashboard landing page** (`BE-013`, Medium) — fetches a store's entire lifetime order history, twice, on every load.

All eight share the same root shape: pagination/limiting is either absent or applied after the expensive work, not before it. Fixing `order.service.ts`'s `listOrders()` — already correctly implemented with capped limits and batched `inq` lookups — is the in-codebase reference pattern for all of the above.

---

## 11. Missing or Inefficient Indexes

- **`payment_transaction.riderid`** (1.94M rows) — confirmed missing, confirmed active filter in `rider-performance.controller.ts`, confirmed parallel-seq-scan fallback on a wide date range (`DB-005`, Medium).
- **"Pending orders" status-exclusion predicate** — needs a partial index matching the exact `status NOT IN (...)` shape used in code, since a plain btree can't serve a `NOT IN`/`<>ALL` predicate the way it serves equality (`DB-009`, High).
- **37 other FK-like columns on large tables have no supporting index**, but targeted code cross-referencing found none of them are actually filtered on in the controllers/services searched today — listed as a watch-list, not a confirmed problem, and explicitly **not** recommended for blanket indexing (`DB-006`, Low/informational — over-indexing `garment`/`order_item` would slow down their already-heavy insert/update traffic).
- **No duplicate or redundant indexes exist** across all 230 checked — a clean result, nothing to remove (`DB-007`).
- **Existing `pg_trgm` GIN indexes already correctly support wildcard search** on order/invoice/customer lookup columns — a positive pattern to keep following for any new free-text search field (`DB-012`).

**Recommended approach:** enable `pg_stat_statements` (`DB-008`) before adding any index beyond the two confirmed cases above — the 37-column watch-list should be revisited against real production query frequency, not guessed at.

---

## 12. Excessive Relation Loading and API Payloads

The backend largely avoids LoopBack's classic "deep `include` chain" over-fetching problem — most list endpoints build their response manually via batched `find()` + in-memory joins rather than nested `include`, and no 2+-level `include` chains were found (`BE` area A). The payload problems that do exist are a different shape:

- **Unbounded result sets ARE the payload problem** — see §10. `GET /transfers`, `GET /approval-requests`, `GET /deliveries`, and the five report builders all return (or enrich) every matching row, not a page, which is both a query-cost and a response-size issue simultaneously.
- **`GET /riders`/`GET /riders/{id}`** (`ARC-018`, High) over-expose rather than over-fetch in volume: the full `Users` entity, including the password hash and OTP fields, is embedded with no field restriction — the only two call sites in the codebase that don't follow the established `scope: {fields: {...}}` convention used everywhere else.
- **`GET /garments`** (`BE-001`, Low) accepts a raw client-supplied LoopBack `where` filter with no field allow-list — bounded by an existing `limit: 200` cap, so low severity, but a caller could still shape an expensive filter.

---

## 13. Pagination, Caching and Frontend Performance

Covered in full in §6. Summary of the pattern: both frontends have at least one screen that defeats server-side pagination — Admin Panel's order-status screen when a payment filter is active (`FE-ADM-003`), Customer Web's entire "My Orders" screen by design (`FE-CW-001/002`). Caching is inconsistent in both apps: Admin Panel runs SWR correctly almost everywhere but ships an entirely unused Redux stack; Customer Web has no shared caching library at all, with exactly one data type (pending approvals) getting a real TTL cache. Customer Web's missing code-splitting (`FE-CW-006`) is the single highest-leverage, lowest-risk frontend fix available — a standard `React.lazy`/`Suspense` conversion with no backend dependency.

---

## 14. Logging, Monitoring and Observability

This is a confirmed, cross-cutting gap, not a severity-graded list of isolated findings:

- **No structured logging anywhere** — `console.log`/`console.error` only, no winston/pino/morgan, no PM2 log rotation configured, no `pm2-logrotate` module referenced (`INF-009`).
- **No request-correlation/trace ID** anywhere in the HTTP stack — the stock LoopBack `MiddlewareSequence` is unmodified (`BE-018`). Combined with 2 PM2 cluster instances, log lines from one logical request can be interleaved across processes with no shared identifier to reassemble them.
- **No APM/error-tracking/metrics tooling** in any of the three app repos' own dependencies — Sentry, Datadog, New Relic, Prometheus, Grafana all absent (`INF-011`). A host-level agent outside the app's own dependency tree could exist and would not show up in this check — that possibility is explicitly not ruled out, just not evidenced.
- **No DB-side query telemetry** — `pg_stat_statements` is not installed, so there is no record of real query frequency/cost to corroborate or refute any performance finding in this report (`DB-008`).
- **Backups are manual and ad hoc**, not a monitored/alerting-backed process (`INF-015`).

**This is the single highest-leverage, lowest-risk category in the whole audit** — none of these require touching business logic, and closing them is what turns every other finding in this report from "a plausible risk" into "a measured fact" the next time something goes wrong.

---

## 15. Scalability Architecture Options

Evaluated per the audit brief's required format — what it solves, whether current evidence justifies it, and the honest caveat on each:

| Option | Problem it solves | Evidence justifies it now? | Assessment |
|---|---|---|---|
| **Redis caching** | Repeated reads of semi-static data (reference data, dashboard aggregates) | No direct evidence of need | **Speculative without production metrics.** No caching layer exists anywhere today (backend or either frontend), but no latency data confirms this is actually slow in production yet. |
| **Background workers / job queue** | Synchronous WhatsApp/email/PDF generation blocking request threads | Partially — the architectural gap is confirmed | **Strong indication, not pure speculation.** Zero queue infrastructure exists (`INF-012`/`ARC-015`) and known-slow operations run inline; actual user-visible impact (timeouts) still needs production latency data. A DB-backed "outbox" table with a retry sweep would suffice — no need for Redis/BullMQ specifically. |
| **Separating Postgres from app services** | CPU/RAM contention between Postgres and Node on one box | Acknowledged by the codebase's own comments, not measured | **Partially evidenced.** The authors already flag this risk in-code (`INF-006`); whether it's an *active* problem needs real CPU/RAM measurements this audit cannot take. |
| **Read replicas / read-write separation** | Report/dashboard read load competing with transactional writes | No evidence either way | **Speculative.** No replication config exists; no query-pattern/load data confirms read load is actually the bottleneck versus the unbounded-query problems already identified in §10, which would need fixing regardless of replica count. |
| **Table partitioning** (for `garment`, `order_status_history`, `garment_damage`) | Unbounded growth of append-heavy historical tables | Growth pattern confirmed, pain not yet measured | **Worth planning, not yet urgent.** These tables will keep growing fastest (§9); partitioning by date becomes valuable once query patterns and retention needs are clearer — premature today without `pg_stat_statements` data. |
| **Centralized logging** | No way to search/aggregate logs across 2 cluster instances | Confirmed gap | **Needs it, based on what's missing** — one of the most concrete, lowest-risk gaps in this entire audit. |
| **Metrics/dashboards/alerting** | No way to detect elevated error rates or latency regressions proactively | Confirmed gap | **Needs it, based on what's missing**, with the caveat that a host-level agent outside the app's own dependencies could already exist unseen. |
| **Automated, tested backups** | No recurring, verified recovery path for the production database | Confirmed gap (one past one-off restore test is a positive, not a process) | **Needs it, based on what's missing.** |
| **Horizontal scaling / load balancing** | Single-server ceiling | Stated server spec is single-box; PM2 cluster mode already scales within it | **Speculative beyond the current ceiling.** Tuning PM2 instance count against actual core count is the nearer-term lever; multi-server load balancing has no evidence of being needed yet. |
| **Rate limiting / abuse protection** | No brute-force/abuse resistance anywhere (`ARC-002`/`ARC-017`) | Confirmed gap, independent of traffic-scalability | **Needs it regardless of scale** — this is a security requirement, not a performance optimization, and should not wait on production metrics. |

---

## 16. Prioritized Recommendations

**P0 — Critical (data loss, corruption, major outage, or severe security exposure risk):**
- Add authentication/authorization to all 6 `FileUploadController` endpoints (`ARC-020`).
- Fix wallet/security-deposit read-then-write races with a row lock or atomic conditional update (`ARC-008/009/010`).
- Close the shift-opening TOCTOU race with a DB-level constraint, not just an application check (`ARC-011`).
- Fix the `GET /transfers` and `GET /approval-requests` unbounded-fetch-and-fan-out patterns (`BE-002`, `BE-005`).
- Batch the order-creation pricing resolution loop (`BE-008`).
- Fix the cross-store data leaks in `/invoices` and the five order sub-resource endpoints, including the unscoped write (`ARC-022b`/`ARC-023`).
- Remove the password-hash/OTP field leak on `GET /riders`/`GET /riders/{id}` (`ARC-018`).

**P1 — High (major performance or reliability bottlenecks):**
- Add FK constraints incrementally after cleaning the 27 known orphan rows (`DB-001`/`DB-002`).
- Fix `GET /deliveries` and `GET /sales-returns` pagination (`BE-003`/`BE-006`); push limit/skip into the five report builders (`BE-004`).
- Add a partial index for the "pending orders" predicate; add the `payment_transaction.riderid` composite index (`DB-009`/`DB-005`).
- Add timeouts to `GeocodingService`'s raw `https.get` call (`BE-014`/`ARC-016`).
- Fix Customer Web's unpaginated order/pickup-request fetch and add route-based code splitting (`FE-CW-001/002/006`); fix Admin Panel's payment-filter pagination bypass (`FE-ADM-003`).
- Add brute-force protection and application-level rate limiting on auth/OTP endpoints (`ARC-002`/`ARC-017`).
- Close the login-OTP-in-response fallback's misconfiguration risk (`ARC-021`).
- Establish an automated, periodically-tested backup process (`INF-015`); confirm production's real `max_connections` against the app's documented, self-flagged pool-sizing assumption (`INF-013`/`DB-015`).
- Verify (and tune, if confirmed) Postgres memory settings on production (`DB-013`).

**P2 — Medium (strengthen scalability and maintainability):**
- Add structured logging, log rotation, and a request-correlation ID (`INF-009`/`BE-018`).
- Enable `pg_stat_statements` in production (`DB-008`).
- Add an idempotency key to order creation (`ARC-026b`).
- Fix the webhook's payload-mismatch handling to actually meet its own documented "always 200" intent (`ARC-014`).
- Add a minimal durable retry mechanism (even a DB outbox table) for WhatsApp/notification sends (`ARC-015`).
- Fix Admin Panel's debounce inconsistencies and remove the unused Redux stack (`FE-ADM-001/002/006`); add `React.memo` to polled list rows (`FE-ADM-008`).
- Add transaction wrapping to `DeliveryController.cancel` and the remaining order-status transitions beyond the three already-protected ones (`ARC-005`/`ARC-006`).
- Add a model-level `hidden` field defense on `Users` so future endpoints can't repeat the `ARC-018` mistake (`ARC-019`).
- Switch deploy scripts from `pm2 restart` to `pm2 reload`; add a post-deploy health check against the existing `/ping` endpoint; retain the previous build artifact for rollback (`INF-001`/`INF-003`/`INF-004`).

**P3 — Low (optional refinements):**
- Fix the `customer.userid` type mismatch (`DB-003`).
- Clean up unrouted demo template code in Admin Panel (`FE-ADM-009`).
- Consolidate on one mapping library instead of two (`FE-ADM-007`).
- Pin an exact Node engine version (`INF-016`).
- Fix the dead/buggy `generateShortToken` method (`ARC-003`).

---

## 17. Implementation Roadmap

**Immediate (before next deploy, independent of everything else):**
1. `ARC-020` file-upload auth fix — this alone is reason enough for an out-of-band patch.
2. Enable `pg_stat_statements` in production (read-only, low-risk, immediately improves every subsequent investigation).
3. Add the request-correlation-ID + structured-logging baseline (`BE-018`/`INF-009`) — low risk, pure addition, makes every other fix below easier to validate once shipped.

**Short-term (next 1-2 sprints):**
1. Wallet/security-deposit/shift-open concurrency fixes (`ARC-008/009/010/011`) — scoped, well-understood changes to specific service methods.
2. Unbounded-endpoint pagination fixes: `/transfers`, `/approval-requests`, `/deliveries`, `/sales-returns`, the five report builders (`BE-002/003/004/005/006`).
3. Cross-store data-leak fixes (`ARC-022b/023/024`) and the `GET /riders` field-exposure fix (`ARC-018`) — all are additive query/scope restrictions, not behavior changes.
4. Frontend fixes: Customer Web code-splitting and orders-page pagination (`FE-CW-001/002/006`); Admin Panel payment-filter pagination bypass (`FE-ADM-003`).
5. Add timeouts to Geocoding/SMTP external calls (`BE-014/015`, `ARC-016/027`).
6. Add application-level rate limiting on auth/OTP endpoints (`ARC-002/017`); fix the OTP-in-response fallback gating (`ARC-021`).

**Medium-term (architecture improvements, 1-2 quarters):**
1. Batch the order-creation pricing resolution (`BE-008`) — more invasive than the pagination fixes, needs careful testing given it's the core order-create path.
2. Add FK constraints after orphan-row cleanup (`DB-001/002`).
3. Add the confirmed/justified indexes (`DB-005`, `DB-009`'s partial index); verify and tune production Postgres memory settings (`DB-013`).
4. Add an idempotency mechanism for order creation (`ARC-026b`).
5. Establish automated, tested backups (`INF-015`); fix the deploy pipeline's reload/health-check/rollback gaps (`INF-001/003/004`).
6. Add a minimal durable notification-retry mechanism (`ARC-015`).

**Long-term scalability investments (only if production metrics justify them — see §15):**
1. Dedicated background job infrastructure (if the outbox-table approach proves insufficient).
2. Separating Postgres from application services onto its own host.
3. Table partitioning for `garment`/`order_status_history`/`garment_damage` as they continue growing.
4. Read replicas, if report/dashboard read load is confirmed (via `pg_stat_statements` data) to meaningfully compete with transactional writes.
5. Redis caching, if specific hot read paths are confirmed slow under real production load.

---

## 18. Testing and Production Readiness Strategy

This audit found no evidence of a concurrency/load-testing practice in either repo (no load-testing scripts, no k6/artillery/locust config found). Recommended validation approach for the fixes above, in order:

1. **Before fixing anything:** capture a real baseline. Enable `pg_stat_statements`; if possible, get even a rough production request-log sample (endpoint + latency) to confirm which of the unbounded endpoints in §10 are actually hit at concerning frequency/volume, rather than fixing all of them blind to real traffic shape.
2. **Per-fix validation**, following each finding's own "how to validate later" (see the five specialist appendix reports for the exact method per finding) — most follow one of three patterns:
   - **Concurrency bugs** (`ARC-008/009/010/011`, `BE-005`'s fan-out): fire two or more genuinely concurrent requests against a staging environment and confirm the race no longer produces a wrong result (lost update, duplicate shift, pool exhaustion) rather than just "looks fine in a single manual test."
   - **Unbounded-query fixes** (`BE-002/003/004/005/006`, `FE-ADM-003`, `FE-CW-001/002`): re-run the same endpoint against a realistic (ideally production-volume) dataset and confirm both response size and DB round-trip count scale with the requested page, not the full table.
   - **Security fixes** (`ARC-018/020/022b/023/024`): attempt the exact exploit scenario described in each finding (e.g., call the endpoint with no auth header, or as a different store's staff account) against staging, confirm it's now rejected.
3. **Before the next production cutover-style event specifically:** with `pg_stat_statements` and structured logging in place, run a realistic concurrent-load rehearsal (staff login storm, concurrent order creation, concurrent report pulls) against a staging environment sized like production, and watch connection-pool usage and query latency in real time rather than finding out from user reports.
4. **Backup/DR validation:** once an automated backup process exists, schedule a recurring restore test (not just the one-off already documented), on a cadence matched to how often the business could tolerate re-doing lost work.

---

## 19. Open Questions and Missing Evidence

Everything below genuinely requires access this audit did not have — none of it should be answered by guessing:

- **Production server access** (SSH or equivalent): real CPU/RAM/disk/network utilization; actual Nginx config (no `nginx.conf` found locally at all); actual PostgreSQL config and real-time resource contention with Node; actual Node version, PM2 instance count, and process uptime/restart history; whether `pm2 reload` vs `restart` is what's actually run; whether a backup cron/systemd timer already exists server-side; whether any host-level monitoring/APM agent is installed outside the app's own dependencies.
- **Real traffic data**: request latency/throughput/error-rate per endpoint — needed to confirm or refute every "speculative without production metrics" item in §15, and to know which of the unbounded endpoints in §10 actually matter most under real load (not all 8 are necessarily hit with equal frequency).
- **Production Postgres**: `pg_stat_statements` enabled and a representative sample of its output; `SHOW max_connections;` and a `pg_stat_activity` snapshot during real peak load; confirmation of whether production shares the same untuned memory settings found on the local replica.
- **The rider-facing client**: no rider mobile/web app repo was available to audit; its existence, stack, and whatever API-consumption patterns it has are completely unverified by this report.
- **The actual cutover incident**: no logs, timestamps, or error traces from the real event were available — §3's analysis is necessarily "mechanisms present that are consistent with this kind of failure," not a confirmed root cause.
- **Whether the `sales_return` stats-counter discrepancy (`DB-011`) and the dead-tuple ratios (`DB-016`) exist on production**, or are artifacts specific to how this local replica was migration-seeded.
- **Whether any of the 37 watch-list columns (`DB-006`) are actually filtered on outside the backend `controllers`/`services` files searched** — e.g. in raw-SQL reporting code or BI tooling not covered by this audit.
- **Backend engine/deploy specifics**: whether the existing `Dockerfile` is used anywhere in any real environment; the real account under which SSH deploys run (the committed script comment says `root`, unconfirmed against the actual server).

---

*This concludes the audit phase. No fixes have been applied. Per the audit's own terms: present findings, explain the evidence, present the recommended implementation order (§17), identify dependencies and risks (stated per-finding in the five appendix reports and summarized in §16), and wait for explicit approval before any code or infrastructure change.*
