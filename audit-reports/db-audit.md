# Pressto Database Audit — Agent 1 (Database Audit Specialist)

**Scope:** Read-only audit. No INSERT/UPDATE/DELETE/DDL executed. No `EXPLAIN ANALYZE` used anywhere — only plain `EXPLAIN` (planner estimates, no execution of the query plan) was used, and only against small-selectivity queries. All `COUNT(*)` calls were plain reads.

**Target:** PostgreSQL 17.7 (Windows build), database `pressto_migration`, local to the Windows dev machine. Per the task brief this is a **local replica/migration-seeded copy**, NOT the live production server. Any session/connection/lock/activity numbers below reflect this idle local instance only and are explicitly marked "not representative of production traffic." Structural findings (schema, indexes, constraints, row counts, index definitions, code-cross-referenced query shapes) are not instance-specific and are trustworthy.

**Method note on row counts (per instructions):** `reltuples` (planner statistics) was pulled for every table via `pg_class`. For 17 small/medium tables (≤ ~400k rows) an exact `SELECT COUNT(*)` was also run to validate the estimates — all matched closely (see DB-010), confirming the stats are fresh for those tables, **with one notable exception** (DB-011, `sales_return`). For the largest tables (`garment` ~9.3M, `order_item` ~5.1M, `order_status_history` ~4.0M, `garment_damage` ~4.1M) I report the `reltuples` estimate rather than running a full-table `COUNT(*)`, to avoid an expensive sequential scan; `orders`, `invoice`, and `order_item` were additionally spot-checked with an actual `COUNT(*)` (2.6–3.4s each) and matched their `reltuples` estimates within <0.01%.

Credentials, tokens and full connection strings are not reproduced anywhere below or in any command that was echoed.

---

## Executive summary (see end of message to lead for the short version)

- Database size: **14.37 GB** total (9.90 GB table data, 4.46 GB indexes, ~0.01 GB TOAST) across **119 tables**, 1 sequence, 230 indexes, 0 views, 0 materialized views, single `public` schema (plus `pg_toast`).
- **Only 2 of 121 primary-key-bearing tables have a foreign-key constraint declared in the database** (both on trivial sequence-counter tables). Every core relationship (`orders`→`customer`, `order_item`→`orders`, `garment`→`order_item`, `payment_transaction`→`orders`, etc.) is enforced only in LoopBack application code, not by Postgres.
- Live orphan-row checks (safe, read-only) found this gap has **already produced real orphaned rows**: 22 `order_item` rows and 5 `payment_transaction` rows reference `orders.id` values that no longer exist.
- `pg_stat_statements` is **not installed**, so there is no DB-side slow-query log to corroborate or refute app-level performance complaints — this needs to be enabled before any real query-performance audit (local or prod).
- Core memory-related `postgresql.conf` settings (`shared_buffers`, `work_mem`, `maintenance_work_mem`, `effective_cache_size`) are all at **PostgreSQL factory defaults** (`source = default`) on a 14 GB, million-row-table database — essentially untuned.
- One **confirmed-via-EXPLAIN** full-table-scan query pattern (`status NOT IN (...)` without a store filter, used for the "pending orders" admin view) and one **confirmed-via-code-and-EXPLAIN** missing index (`payment_transaction.riderid`, 1.94M rows, actively filtered in `rider-performance.controller.ts`).

---

## A. Database inventory and real data volumes

### DB-001 — Only 2 of 121 tables have an enforced foreign key
- **Table/object:** All 121 tables with a primary key (schema `public`)
- **Evidence (query):**
  ```sql
  SELECT tc.table_schema, tc.table_name, kcu.column_name,
         ccu.table_name AS foreign_table, ccu.column_name AS foreign_column
  FROM information_schema.table_constraints tc
  JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
  JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name = tc.constraint_name AND ccu.table_schema = tc.table_schema
  JOIN information_schema.referential_constraints rc ON rc.constraint_name = tc.constraint_name AND rc.constraint_schema = tc.table_schema
  WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema NOT IN ('pg_catalog','information_schema');
  ```
- **Observed result:** 2 rows returned total: `invoice_number_sequence.storeid → store.id`, `ticket_number_sequence.storeid → store.id`. Every other relationship — `orders.customerid`, `order_item.orderid`, `garment.orderitemid`, `payment_transaction.orderid`, `invoice.orderid`, `customer.userid`, `order_status_history.orderid`, `order_handover.orderid`, etc. (cross-checked against 1,554 total columns, 37 of which are `*id` columns on tables >1,000 rows with no supporting index either — see DB-005) — has **no DB-level FK constraint**.
- **Measured impact:** Confirmed consequence in DB-002 below: real orphaned rows already exist.
- **Why it matters under concurrent production traffic:** Without FK constraints, nothing in the database itself prevents a partial write (a crashed request, a bug in a service method, a manual data fix, a future migration) from leaving a dangling reference. At 2M-row `orders` / 5M-row `order_item` scale, a small bug that leaks orphans on every deploy will accumulate silently and corrupt reports, exports, and any joins that assume referential integrity. It also means the query planner has no declared relationship to reason about (no FK-based join selectivity/constraint-exclusion hints).
- **Severity:** High
- **Confidence:** Confirmed
- **Recommended improvement:** Add FK constraints incrementally, starting with the highest-traffic relationships (`order_item.orderid → orders.id`, `payment_transaction.orderid → orders.id`, `garment.orderitemid → order_item.id`, `orders.customerid → customer.id`). Given LoopBack already assumes these relations, this mainly protects against bugs/migrations, not application logic changes.
- **Dependencies/risks of implementing it:** Must first clean up the existing orphan rows (see DB-002) or use `NOT VALID` + `VALIDATE CONSTRAINT` to add constraints without a blocking table scan on day one. Must confirm delete/update semantics (`ON DELETE CASCADE` vs `RESTRICT` vs `SET NULL`) per relationship — currently undefined anywhere since there are no constraints to carry that rule. Adding FKs on multi-million-row tables briefly takes a lock while validating (unless `NOT VALID` is used) and requires an index on the referencing column (several are missing — see DB-005/DB-006).
- **How to validate later:** Re-run the same `information_schema` query after each constraint is added; re-run the DB-002 orphan-check queries to confirm 0 orphans before adding each constraint as `VALID`.

### DB-002 — Confirmed orphaned rows from the missing-FK gap
- **Table/object:** `order_item`, `payment_transaction`
- **Evidence (query):**
  ```sql
  SELECT count(*) FROM order_item oi WHERE oi.orderid IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.id = oi.orderid);
  SELECT count(*) FROM payment_transaction p WHERE p.orderid IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.id = p.orderid);
  ```
- **Observed result:** `order_item`: **22 orphaned rows** (of ~5.12M). `payment_transaction`: **5 orphaned rows** (of ~1.94M). By contrast, `orders.customerid → customer.id`, `garment.orderitemid → order_item.id`, and `invoice_order_link.orderid → orders.id` all came back **0 orphans** — so the data is mostly clean, this is not systemic corruption, but it proves the integrity gap in DB-001 is not theoretical.
- **Measured impact:** 27 rows total across the two tables checked (out of the relationships actually tested — other relationships were not exhaustively checked).
- **Why it matters under concurrent production traffic:** Any report, export, or join that assumes every `order_item`/`payment_transaction` has a live parent order will either silently skip these rows or throw when code expects a non-null `findOne` result. At current scale the count is small, but nothing stops it from growing since there's no constraint blocking it.
- **Severity:** Medium (current count is small; the structural gap that allows it is the High-severity item, DB-001)
- **Confidence:** Confirmed
- **Recommended improvement:** Investigate the 27 rows (likely candidates: an order hard-deleted or a migration/import edge case) and decide whether to soft-delete, null the reference, or delete them before adding the FK in DB-001.
- **Dependencies/risks:** None to find them (already done, read-only); fixing them changes data, so do that under the user's normal data-fix process, not as part of this audit.
- **How to validate later:** Re-run the two `NOT EXISTS` queries above; also run the same pattern for every relationship before validating its FK.

### DB-003 — Schema/type inconsistency: `customer.userid` is `text`, `users.id` is `uuid`
- **Table/object:** `customer.userid` vs `users.id`
- **Evidence (query):**
  ```sql
  SELECT table_name, column_name, data_type FROM information_schema.columns
  WHERE (table_name='customer' AND column_name='userid') OR (table_name='users' AND column_name='id');
  -- separately: SELECT data_type, count(*) FROM information_schema.columns
  --             WHERE column_name='id' GROUP BY data_type;  →  {"uuid": 117}
  ```
- **Observed result:** All 117 other primary `id` columns in the schema are `uuid`. `customer.userid` — the column that should reference `users.id` — is declared `text`. A naive join (`customer.userid = users.id`) fails outright with `operator does not exist: uuid = text`; it only works with an explicit cast (`users.id::text = customer.userid`), which this audit used to re-check orphans (0 orphans found once cast correctly — see DB-002's note).
- **Measured impact:** Not a data-integrity problem today (0 orphans with the correct cast), but a correctness/consistency landmine: any new raw SQL, report, or migration that joins these two columns without the cast will either error or (worse, if written loosely) silently compare nothing.
- **Why it matters under concurrent production traffic:** It's the specific reason an FK constraint can't be added on this relationship without first fixing the type, and it's exactly the kind of inconsistency that produces an intermittent bug report that's hard to reproduce (works via the ORM's cast, fails in raw SQL/BI tooling).
- **Severity:** Low
- **Confidence:** Confirmed
- **Recommended improvement:** Migrate `customer.userid` to `uuid` to match `users.id` (requires validating all existing values are valid UUIDs first — this audit did not exhaustively check that, only that none happened to be orphans against `users.id` when cast).
- **Dependencies/risks:** Type-changing migration on a 395k-row table (small, low risk) but must update any LoopBack model definition that currently types this field as `string` and any raw SQL/reports that rely on it being text.
- **How to validate later:** `SELECT userid FROM customer WHERE userid !~* '^[0-9a-f-]{36}$'` to confirm all non-null values are well-formed UUIDs before migrating the column type.

### DB-004 — Largest tables by size and estimated rows
- **Table/object:** whole-database inventory
- **Evidence (query):**
  ```sql
  SELECT c.relname, c.reltuples::bigint AS est_rows,
         pg_total_relation_size(c.oid) AS total_bytes,
         pg_relation_size(c.oid) AS table_bytes,
         pg_indexes_size(c.oid) AS index_bytes
  FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE c.relkind IN ('r','p') AND n.nspname NOT IN ('pg_catalog','information_schema')
  ORDER BY total_bytes DESC;
  ```
- **Observed result (top 10 by total size; `est_rows` is `reltuples`, cross-checked for `orders`/`invoice`/`order_item` with an actual `COUNT(*)` — see method note above):**

  | table | est./actual rows | total size | table | index | toast |
  |---|---|---|---|---|---|
  | invoice | 1,970,874 | 3.68 GB | 3.27 GB | 400.6 MB | 5.2 MB |
  | garment | ~9,354,682 (estimate) | 3.26 GB | 1.81 GB | 1.45 GB | 0.5 MB |
  | order_item | 5,118,598 | 1.68 GB | 1.32 GB | 365.9 MB | 0.4 MB |
  | orders | 1,972,622 | 1.48 GB | 0.75 GB | 733.4 MB | 0.2 MB |
  | order_status_history | ~3,983,713 (estimate) | 0.96 GB | 0.65 GB | 307.0 MB | 0.2 MB |
  | order_handover | 1,949,395 | 0.71 GB | 0.52 GB | 184.5 MB | 0.2 MB |
  | garment_damage | ~4,148,472 (estimate) | 0.64 GB | 0.40 GB | 251.6 MB | 0.1 MB |
  | payment_transaction | 1,940,850 | 0.50 GB | 0.30 GB | 213.6 MB | 0.1 MB |
  | invoice_order_link | 1,970,874 | 0.41 GB | 0.19 GB | 225.6 MB | 0.1 MB |
  | shift | 147,324 (actual) | 0.39 GB | 0.38 GB | 12.6 MB | 0.1 MB |

  Database total: **14.37 GB** (9.90 GB table data + 4.46 GB index data + ~10 MB TOAST). 119 tables, 230 indexes, 0 views, 0 materialized views, 1 sequence, schemas: `public` + `pg_toast` only.
- **Measured impact:** `invoice` and `garment` alone account for ~48% of total database size. Index-to-table-data ratio overall (4.46 GB / 9.90 GB ≈ 45%) is within a normal range, not evidence of index bloat.
- **Why it matters under concurrent production traffic:** These are exactly the tables that need the memory/IO settings in DB-007 and the index coverage in DB-005/DB-006 to behave well; sizing here establishes the baseline for `shared_buffers`/`effective_cache_size` planning.
- **Severity:** Low (informational)
- **Confidence:** Confirmed
- **Recommended improvement:** None required by itself; use this as the sizing input for DB-007.
- **Dependencies/risks:** None.
- **How to validate later:** Re-run the same query periodically to track growth; `garment`, `order_item`, `order_status_history`, `garment_damage` are all append-heavy (per-garment/per-item/per-status-change logging tables) and will keep growing fastest — worth a periodic growth-rate check, not just a point-in-time size.

### DB-010 — Row count estimate validation (small/medium tables)
- **Table/object:** 17 small/medium tables
- **Evidence (query):** Actual `SELECT COUNT(*)` run against `customer`, `users`, `customer_address`, `customer_security_deposit`, `user_roles`, `wallet`, `sales_return`, `garment_additional_service`, `petty_cash_register_entry`, `customer_phone`, `service_item_mapping`, `shift`, `store`, `coupon`, `item`, `wallet_transaction`, `customer_label_assignment`, plus `orders`, `invoice`, `order_item` (65–3,382 ms each).
- **Observed result:** All 16 of the 17 small/medium tables matched their `reltuples` estimate from DB-004 to within rounding. `orders` (1,972,622), `invoice` (1,970,874), `order_item` (5,118,598) actual counts matched their `reltuples` estimates almost exactly. **One exception: `sales_return`** — see DB-011.
- **Measured impact:** Confirms the `reltuples`-based estimates used for the larger tables in DB-004 are reliable (stats are being refreshed), except for the one case below.
- **Why it matters:** Validates that this audit's size/row-count figures are trustworthy, and isolates the one table where they are not.
- **Severity:** Low (informational / methodology confirmation)
- **Confidence:** Confirmed
- **Recommended improvement:** None.
- **Dependencies/risks:** None.
- **How to validate later:** N/A — already validated.

### DB-011 — Stale/incorrect planner statistics on `sales_return`
- **Table/object:** `sales_return`
- **Evidence (query):**
  ```sql
  SELECT n_live_tup, n_dead_tup, last_autovacuum, last_autoanalyze FROM pg_stat_user_tables WHERE relname='sales_return';
  SELECT count(*) FROM sales_return;
  ```
- **Observed result:** `pg_stat_user_tables.n_live_tup` reports **91** live rows and `n_dead_tup` reports 323, with `last_autovacuum` and `last_autoanalyze` both **NULL** (never run, by this stats-collector counter). An actual `SELECT COUNT(*)` returns **44,751** rows. The table's own `reltuples` (from `pg_class`, DB-004 method) correctly shows ~44,751, matching the real count — so only the incrementally-maintained `pg_stat_user_tables` live/dead counters are wrong, not the planner's row-count statistic used for query costing.
- **Measured impact:** A 491x discrepancy between the stats-collector's live-tuple counter and reality for this one table.
- **Why it matters under concurrent production traffic:** `n_live_tup`/`n_dead_tup` drive autovacuum scheduling decisions (whether/when to vacuum this table). If these counters are this wrong, `sales_return` may not get vacuumed on the schedule the configured thresholds imply, independent of the `reltuples` estimate the planner itself uses for row-cost estimation (which is correct here). This is very likely an artifact of how this specific local replica was seeded/migrated (e.g., bulk load path that didn't go through the normal stat-tracking code path, or a stats reset at some point after an ANALYZE had already run) — **this needs to be checked against production's own `pg_stat_user_tables` rather than assumed to also be wrong there.**
- **Severity:** Low on this instance (small table); flag as Medium if the same discrepancy exists on a large table in production.
- **Confidence:** Confirmed on this local instance; **needs validation in production** (not representative of production traffic/state — this instance was migration-seeded, which is exactly the kind of bulk operation that could cause this).
- **Recommended improvement:** Run `VACUUM ANALYZE sales_return;` (note: this is a write/maintenance operation and was deliberately NOT run as part of this read-only audit) if production shows the same pattern, and check whether the same migration/seed path was used for other tables.
- **Dependencies/risks:** `VACUUM` takes a lock that briefly blocks DDL (not normal reads/writes) on the table; safe to run off-peak.
- **How to validate later:** Compare `pg_stat_user_tables.n_live_tup` against `SELECT count(*)` for a sample of tables in production; check `pg_stat_user_tables.last_autovacuum`/`last_autoanalyze` for NULLs across the whole schema (many tables on this local instance show NULL for `last_autovacuum` specifically — see DB-009 — which may be the same underlying cause).

---

## B. Indexing audit

### DB-005 — Candidate missing index, confirmed by code: `payment_transaction.riderid`
- **Table/object:** `payment_transaction` (1,940,850 rows)
- **Evidence (code):** `pressto_backend/src/controllers/rider-performance.controller.ts:124`:
  ```ts
  where: {riderId: rider.id, paymentDate: {between: [from, toEnd]}} as object,
  ```
- **Evidence (index list):**
  ```sql
  SELECT indexname, indexdef FROM pg_indexes WHERE tablename='payment_transaction';
  ```
  → `payment_transaction_pkey (id)`, `paymentTransactionCashShiftId (cashshiftid)`, `paymentTransactionOrderId (orderid)`, `paymentTransactionPaymentDate (paymentdate)`. **No index on `riderid` in any form.**
- **Evidence (plain EXPLAIN, no execution):**
  ```sql
  EXPLAIN SELECT * FROM payment_transaction WHERE riderid = '<uuid>' AND paymentdate BETWEEN now() - interval '30 days' AND now();
  -- → Index Scan using "paymentTransactionPaymentDate" ... Filter: (riderid = ...)
  EXPLAIN SELECT * FROM payment_transaction WHERE riderid = '<uuid>' AND paymentdate BETWEEN '2020-01-01' AND now();
  -- → Gather / Parallel Seq Scan on payment_transaction ... Filter: (paymentdate >= ... AND riderid = ... AND paymentdate <= now())
  ```
- **Observed result:** With a narrow (30-day) date range the planner uses the existing `paymentdate` index and filters `riderid` afterward — tolerable. With a wide date range (e.g. a rider's full history, or if `from`/`toEnd` defaults to "all time" anywhere in the caller), the planner falls back to a **parallel sequential scan of the full 1.94M-row table**, confirmed via `EXPLAIN`.
- **Measured impact:** Plan-level only (no timing — `EXPLAIN` without `ANALYZE` was used deliberately, per audit rules); the seq-scan plan touches all ~1.94M rows and does it on every call with a wide date range.
- **Why it matters under concurrent production traffic:** This is a real, actively-used filter (confirmed in `rider-performance.controller.ts`), not a hypothetical. If any rider-performance view is requested without a narrow date filter (or for riders with activity spread across a long history), this degrades to a full scan under concurrent load from the rider app.
- **Severity:** Medium
- **Confidence:** Strong indication for the wide-date-range case (confirmed via `EXPLAIN` plan shape; no timing data since `ANALYZE` was avoided by design) — Confirmed that no supporting index exists.
- **Recommended improvement:** `CREATE INDEX CONCURRENTLY idx_payment_transaction_riderid_paymentdate ON payment_transaction (riderid, paymentdate);` (leading column `riderid` since it's an equality filter, `paymentdate` second for the range).
- **Dependencies/risks:** `CREATE INDEX CONCURRENTLY` avoids locking writes but takes longer and can't run inside a transaction; needs a maintenance window or off-peak deploy step. Adds ~ a few hundred MB on a table already at 213.6 MB of index data — monitor disk headroom.
- **How to validate later:** Re-run the wide-date-range `EXPLAIN` above after the index exists — expect `Index Scan` instead of `Seq Scan`; once in production, pull `pg_stat_user_indexes` for the new index to confirm it's actually being used.

### DB-006 — 37 other FK-like columns on tables >1,000 rows have no supporting index (candidates, NOT individually confirmed as queried this way)
- **Table/object:** 37 columns across `garment`, `order_item`, `garment_damage`, `orders`, `invoice`, `order_handover`, `customer`, `shift`, `petty_cash_register_entry`, etc.
- **Evidence (query):** Cross-referenced `information_schema.columns` (columns ending in `id`, excluding the PK `id` itself, on tables with >1,000 estimated rows) against `pg_indexes` (whether any index has that column as its leading column). Full list (table, column, est. rows) includes e.g. `garment.brandid` (9.35M), `garment.colorid` (9.35M), `order_item.serviceid` (5.12M), `order_item.itemid` (5.12M), `garment_damage.damagetypeid` (4.15M), `orders.deliveryslotid` (1.97M), `orders.deliveryaddressid` (1.97M), `payment_transaction.collectedbyuserid` (1.94M), `customer.customertypeid`/`customergroupid`/`preferredstoreid` (395k each), `shift.openinguserid`/`closinguserid` (147k).
- **Code cross-check performed:** For each of the higher-row-count candidates I grepped `pressto_backend/src/controllers` and `src/services` for actual `where:` usage. Findings:
  - `garment.brandid`/`colorid`: only used as `{id: garment.brandId}` lookups **against the `brand`/`color` tables' own PK** (`garment.controller.ts:286-287,352-353`), **not** as a filter on `garment` itself. Not a real missing-index concern as currently coded.
  - `order_item.serviceid`: the one `inq` usage found (`order.service.ts:5711`) filters the small `service_item_mapping` table (11,279 rows), not `order_item` itself. No confirmed direct filter on `order_item.serviceid`/`itemid` was found in the controllers/services searched.
  - `orders.deliveryslotid`/`deliveryaddressid`: used only as `{id: deliverySlotId}` / `{id: deliveryAddressId}` lookups against the slot/address tables' own PK (`order.controller.ts:790,806,1127,1174,1682`), not as a filter on `orders` itself.
  - `customer.customertypeid`/`customergroupid`/`preferredstoreid`/`referredbycouponid`: **no** `where:` usage found in controllers/services searched.
  - `shift.openinguserid`/`closinguserid`, `payment_transaction.collectedbyuserid`, `garment_damage.damagetypeid`: **no** `where:`-filter usage found in the controllers/services searched (they appear only as values being written, not filtered on).
- **Observed result:** Of the 37 structural candidates, targeted code search found **zero** confirmed additional cases of these specific columns being used as a query filter (beyond `payment_transaction.riderid`, already covered in DB-005). This does not rule out usage elsewhere (raw SQL, report-generation code, or files not grepped) — the search covered `controllers/` and `services/` only.
- **Measured impact:** None measured — this is a structural inventory, not a confirmed performance problem.
- **Why it matters under concurrent production traffic:** If any of these columns are filtered on in code paths this audit didn't check (e.g. BI/reporting queries, admin ad-hoc filters, future features), the same full-scan risk as DB-005 applies, especially for the 9M-row `garment` and 5M-row `order_item` tables.
- **Severity:** Low (as a confirmed-today problem) / informational watch-list
- **Confidence:** Needs validation — this is a structural candidate list, explicitly not a confirmed-usage finding except where code cross-check succeeded (and those succeeded cases turned out NOT to be filters on the listed table).
- **Recommended improvement:** Do not blanket-add indexes for all 37; instead, enable `pg_stat_statements` in production (DB-008) and revisit this list filtered by actual production query frequency before adding any index. Indexes aren't free — each one adds write overhead on these already-large, write-heavy tables.
- **Dependencies/risks:** Over-indexing `garment`/`order_item` (already 1.4 GB / 366 MB of index data respectively) would slow down the frequent inserts/updates these tables receive.
- **How to validate later:** With `pg_stat_statements` enabled, filter for queries referencing these column names and check `pg_stat_user_tables.seq_scan` growth rate on the underlying tables over a production time window.

### DB-007 — No duplicate or redundant indexes found
- **Table/object:** All 230 indexes across all tables
- **Evidence (method):** Parsed every `pg_indexes.indexdef` into (table, column-list, access method, unique-flag) and checked programmatically for (a) exact column-list+method duplicates on the same table, and (b) one btree index's column list being a strict prefix of another's on the same table (the classic "redundant index" pattern).
- **Observed result:** **Zero** exact duplicates and **zero** prefix-redundant index pairs found across all 230 indexes.
- **Measured impact:** None — this is a clean result.
- **Why it matters:** Confirms index bloat/duplication is not contributing to the 4.46 GB of index storage or to write overhead; the index footprint is deliberate, not accidental.
- **Severity:** N/A (positive finding)
- **Confidence:** Confirmed
- **Recommended improvement:** None.
- **Dependencies/risks:** None.
- **How to validate later:** Re-run the same duplicate/prefix check after any future index additions (e.g. from DB-005/DB-006) to avoid introducing the pattern.

### DB-012 — `pg_trgm` GIN indexes already in place for wildcard text search (positive finding)
- **Table/object:** `orders.ordernumber`, `invoice.invoicenumber`, `customer.customercode`/`firstname`/`lastname`, `users.phone`
- **Evidence:** `pg_indexes` definitions, e.g. `"orderOrderNumberTrgm" ... USING gin (ordernumber gin_trgm_ops)`, `"invoiceNumberTrgm" ... USING gin (invoicenumber gin_trgm_ops)`, `"customerFirstNameTrgm"`, `"customerLastNameTrgm"`, `"customerCustomerCodeTrgm"`, `"usersPhoneTrgm"`.
- **Observed result:** Leading-wildcard `ILIKE '%...%'` searches on these columns (confirmed in use, e.g. `order.service.ts` invoice-number search: `invoicenumber: {ilike: '%...%'}`) are supported by a trigram GIN index rather than falling back to a sequential scan, which a plain btree could not do for a leading-wildcard pattern.
- **Why it matters:** This is good existing practice that prevents a very common failure mode (full scan on every customer/order search-box keystroke) at current and future scale.
- **Severity:** N/A (positive finding, informational)
- **Confidence:** Confirmed
- **Recommended improvement:** None required; worth preserving as the pattern to follow for any new free-text search column.
- **Dependencies/risks:** N/A.
- **How to validate later:** N/A.

---

## C. Query performance

### DB-008 — `pg_stat_statements` is not installed
- **Table/object:** extension `pg_stat_statements`
- **Evidence (query):** `SELECT * FROM pg_extension WHERE extname='pg_stat_statements';`
- **Observed result:** 0 rows. The extension is not enabled on this instance, so there is no DB-side record of query call counts, total/mean execution time, or rows returned — the top-queries analysis requested by the audit brief could not be performed at all, on either this instance or (presumably, needs checking) production.
- **Measured impact:** No query-performance telemetry available from the database itself; all performance findings in this report had to be derived from static code inspection + planner `EXPLAIN` estimates, not real execution data.
- **Why it matters under concurrent production traffic:** Without this, there is no way to answer "what are our actual slowest/most frequent queries in production" except by guessing from code, which is what this audit had to do. This is the single biggest gap preventing a more complete query-performance audit.
- **Severity:** Medium (audit-capability gap, not a user-facing symptom by itself)
- **Confidence:** Confirmed (for this local instance) — **needs validation whether it's also absent in production**, since that's the instance that actually matters for this finding.
- **Recommended improvement:** Enable `pg_stat_statements` in production: add `shared_preload_libraries = 'pg_stat_statements'` to `postgresql.conf` (requires a Postgres restart) and `CREATE EXTENSION pg_stat_statements;`. Low overhead, standard practice, read-only data collection.
- **Dependencies/risks:** Requires a Postgres restart to take effect (needs a maintenance window), and a small, constant amount of shared memory for the statement-tracking hash table (configurable via `pg_stat_statements.max`).
- **How to validate later:** `SELECT * FROM pg_extension WHERE extname='pg_stat_statements';` should return 1 row; then `SELECT query, calls, total_exec_time, mean_exec_time FROM pg_stat_statements ORDER BY total_exec_time DESC LIMIT 25;` after a representative traffic period.

### DB-009 — Confirmed full-table scan: unscoped "pending orders" status filter
- **Table/object:** `orders` (1,972,622 rows)
- **Evidence (code):** `pressto_backend/src/services/order.service.ts:5293-5318`, inside `listOrders()`:
  ```ts
  if (params.status === 'pending') {
    baseConditions.push({status: {nin: ['draft','delivered','cancelled','returned']}});
  }
  ...
  if (params.excludeStatuses?.length) baseConditions.push({status: {nin: params.excludeStatuses}});
  ```
  `storeIds` filtering (`order.service.ts:5262-5273`) is only applied `if (Array.isArray(params.storeIds))` — callers without a resolved store scope (e.g. a super_admin/global caller, per `order.controller.ts:440-478` and `StoreScopeService.resolve`) skip the `storeId` condition entirely, leaving only the `status NOT IN (...)` + `isdeleted = false` filter.
- **Evidence (plain EXPLAIN, no execution):**
  ```sql
  EXPLAIN SELECT COUNT(*) FROM orders WHERE isdeleted = false AND status NOT IN ('draft','delivered','cancelled','returned');
  -- → Finalize Aggregate → Gather (2 workers) → Partial Aggregate → Parallel Seq Scan on orders
  --    Filter: ((NOT isdeleted) AND (status <> ALL ('{draft,delivered,cancelled,returned}'::text[])))
  ```
  Contrast with the same table filtered by a single status value:
  ```sql
  EXPLAIN SELECT COUNT(*) FROM orders WHERE isdeleted = false AND status = 'confirmed';
  -- → Aggregate → Index Scan using idx_orders_status
  ```
  And contrast with the same `NOT IN` filter when a `storeid` is also present (the normal, store-scoped case):
  ```sql
  EXPLAIN SELECT * FROM orders WHERE isdeleted=false AND storeid = '<uuid>' AND status NOT IN (...) ORDER BY createdat DESC LIMIT 20;
  -- → Index Scan Backward using "orderStoreCreatedAt" ... Filter: ((NOT isdeleted) AND status <> ALL(...))
  ```
- **Observed result:** The planner cannot use `idx_orders_status` (a plain btree on `status`) for a `NOT IN` / `<> ALL` predicate the way it can for equality — confirmed via `EXPLAIN`. When no `storeid` is present, this degrades to a **parallel sequential scan of the full `orders` table**. When a `storeid` is present (the common case for store-scoped admin users), the existing `orderStoreCreatedAt` composite index is used first and the status exclusion becomes a cheap post-filter — this path is fine.
- **Measured impact:** Plan-shape only, no timing (deliberately avoided `ANALYZE`); the problematic plan is a parallel seq scan over ~2M rows.
- **Why it matters under concurrent production traffic:** Any caller that reaches this code path without a resolved `storeIds` array (global/super-admin "pending orders" dashboard view, or `excludeStatuses` used the same way) triggers a full-table scan on every request, concurrently, with no caching layer visible in front of it. This is a real, reachable code path (not a hypothetical query), confirmed by reading the exact production filter-building logic.
- **Severity:** High
- **Confidence:** Confirmed (via code path + matching `EXPLAIN` plan on the local replica's real `orders` table/data). Whether this specific unscoped call pattern is actually hit at volume in production, and how often, needs production request-log/`pg_stat_statements` validation.
- **Recommended improvement:** A partial index tailored to the real "pending" definition, e.g. `CREATE INDEX CONCURRENTLY idx_orders_pending ON orders (createdat) WHERE isdeleted = false AND status NOT IN ('draft','delivered','cancelled','returned');` (Postgres can use a partial index matching the predicate shape, even though a plain btree on `status` cannot be used for `NOT IN`). Alternatively, invert the predicate to a positive `status IN (...)` list of the actual "pending-ish" statuses if the set is stable, which `idx_orders_status`-style indexes handle natively.
- **Dependencies/risks:** Partial index must be kept in sync if the "pending" status list in code ever changes (`order.service.ts:5293-5296`) — the index predicate and the application predicate must match exactly for the planner to use it. `CREATE INDEX CONCURRENTLY` needed to avoid locking the live `orders` table.
- **How to validate later:** Re-run the unscoped `EXPLAIN` above after adding the partial index — expect `Index Scan`/`Bitmap Index Scan` instead of `Parallel Seq Scan`. In production, check `pg_stat_user_tables.seq_scan` growth rate on `orders` before/after.

### Pagination pattern review — no confirmed N+1, good baseline design (positive, informational)
- **Table/object:** `order.service.ts: listOrders()` (the main admin order-list endpoint)
- **Evidence (code):** `order.service.ts:5256-5366` — `limit` capped at 100 (`Math.min(Number(params.limit ?? 20), 100)`); the list query and `orderRepo.count(where)` run in parallel via `Promise.all`; related records (`delivery_order`, `order_status_history`) are fetched once per page via `{orderId: {inq: orderIds}}` rather than per-row.
- **Observed result:** This is the correct batching pattern (one `inq` query for N related rows, not N queries). A targeted search for `for (...) { ... await repo.find/findOne(...) }` loops in `controllers/order.controller.ts` found no tight match.
- **Why it matters:** Positive finding — the highest-traffic listing endpoint is not a classic N+1 liability by design.
- **Severity:** N/A (informational)
- **Confidence:** Strong indication, not exhaustive — only `order.controller.ts`/`order.service.ts`'s main list path and a loose, broad regex scan of all controllers were checked; a full N+1 audit of all 40+ controllers was out of scope for the time available and would benefit far more from `pg_stat_statements` (DB-008) showing actual per-request query counts than from more static code reading.
- **Recommended improvement:** Once `pg_stat_statements` is enabled in production, cross-reference query counts per request/trace to find any real N+1 patterns empirically rather than by code inspection.
- **Dependencies/risks:** N/A.
- **How to validate later:** Enable `pg_stat_statements` + request-level tracing (e.g. a request-id comment in each query, or APM) and look for endpoints whose query count scales with result-set size.

---

## D. Database configuration and health

### DB-013 — Core memory settings are all at factory defaults on a 14 GB database
- **Table/object:** `pg_settings`
- **Evidence (query):**
  ```sql
  SELECT name, setting, unit, source FROM pg_settings
  WHERE name IN ('shared_buffers','work_mem','max_connections','effective_cache_size',
                 'maintenance_work_mem','checkpoint_timeout','checkpoint_completion_target',
                 'max_wal_size','min_wal_size','wal_buffers','autovacuum','autovacuum_naptime',
                 'autovacuum_vacuum_scale_factor','autovacuum_vacuum_threshold','random_page_cost',
                 'effective_io_concurrency','default_statistics_target','track_io_timing');
  ```
- **Observed result:**
  | setting | value | source |
  |---|---|---|
  | shared_buffers | 128 MB (16384 × 8kB) | **default** |
  | work_mem | 4 MB | **default** |
  | maintenance_work_mem | 64 MB | **default** |
  | effective_cache_size | 4 GB (524288 × 8kB) | **default** |
  | random_page_cost | 4 | **default** |
  | effective_io_concurrency | 0 | **default** |
  | track_io_timing | off | **default** |
  | autovacuum_vacuum_scale_factor | 0.2 | **default** |
  | autovacuum_vacuum_threshold | 50 | **default** |
  | default_statistics_target | 100 | **default** |
  | max_connections | 100 | configuration file |
  | max_wal_size | 1024 MB | configuration file |
  | min_wal_size | 80 MB | configuration file |
- **Measured impact:** `shared_buffers` (128 MB) is tiny relative to the 14.37 GB database and 9.90 GB of table data — standard guidance for a dedicated Postgres box is roughly 25% of RAM for `shared_buffers`. `work_mem` (4 MB) is low for sorts/aggregates against the multi-million-row tables found in DB-004 (`orders`, `order_item`, `order_status_history`, `garment`) — undersized `work_mem` causes sort/hash operations to spill to on-disk temp files under concurrent load. `effective_cache_size` (4 GB) under-informs the planner's assumption about OS page-cache availability relative to a hypothetical 16 GB box, which can bias the planner toward sequential scans (consistent with DB-009's observed seq-scan preference).
- **Why it matters under concurrent production traffic:** These settings are per-cluster, not per-database, so if production shares this same unconfigured `postgresql.conf`, every concurrent connection competing for the small 128 MB buffer pool and 4 MB of per-operation working memory will see far more disk I/O and temp-file spilling than necessary — compounded by Node.js and Postgres sharing the same box's RAM (see note below).
- **Severity:** High if production is also running on these same defaults (needs validation) — this is purely a configuration/tuning gap, trivially fixable, with high leverage given the data volumes already in DB-004.
- **Confidence:** Confirmed for this local instance. **Needs validation against production's actual `pg_settings`** — do not assume production shares this `.conf`; the task brief explicitly notes this local instance's config may differ. The note about "a hypothetical 16GB box" is provided for context only, since actual production RAM/CPU allocation could not be measured from here (flagged as **needs-production-access**, see DB-014).
- **Recommended improvement:** If production confirms the same defaults: raise `shared_buffers` to roughly 25% of the box's RAM, `effective_cache_size` to roughly 50-75% of RAM, `work_mem` to a few tens of MB (carefully — it's per-sort-operation per-connection, so multiply by `max_connections` × concurrent sort operations when sizing), `maintenance_work_mem` to several hundred MB (speeds up `VACUUM`/`CREATE INDEX` on the multi-GB tables in DB-004), and set `random_page_cost` lower (e.g. 1.1) if production storage is SSD/NVMe rather than spinning disk, and `effective_io_concurrency` accordingly.
- **Dependencies/risks:** Most of these require a Postgres restart (not just reload) to take effect. Must be sized against the box's *actual* RAM shared with the Node.js processes (ecosystem.config.js runs PM2 in cluster mode — see DB-015) — over-allocating `shared_buffers`/`work_mem` on a RAM-constrained box that also runs Node can cause OOM/swapping, which would be worse than the current under-tuned state. This must be done with real production hardware specs, not guessed.
- **How to validate later:** Pull the same `pg_settings` query against production; check `source` column — anything still `default` on a production OLTP database serving 2M+ row tables is a tuning gap worth closing deliberately with the real hardware numbers in hand.

### DB-014 — CPU/RAM contention with Node.js cannot be assessed from here
- **Table/object:** N/A (host-level resource, not database-level)
- **Evidence:** N/A — this requires OS-level process/resource monitoring (e.g. Windows Task Manager/perfmon, or `top`/`htop` equivalents) on the actual host, which is outside what SQL queries against the database can observe.
- **Observed result:** Not measurable from this audit's vantage point.
- **Why it matters:** The task brief correctly anticipates this — on the same box, Postgres (sized per DB-013) and the Node.js/LoopBack process(es) (sized per PM2 config, DB-015) compete for the same RAM and CPU. Tuning Postgres's memory settings in isolation, without knowing how much RAM/CPU the Node side actually needs and gets, risks either starving Postgres or starving the app.
- **Severity:** Needs-production-access (unrated — cannot assess severity without the data)
- **Confidence:** N/A — explicitly flagged as unmeasurable from this audit, per the task brief's own instruction.
- **Recommended improvement:** On the production host, capture a baseline of Node.js (per PM2 instance) and Postgres RAM/CPU usage under real load before finalizing the DB-013 memory settings.
- **Dependencies/risks:** N/A.
- **How to validate later:** `pm2 monit` / Windows Performance Monitor / equivalent, captured during peak traffic.

### DB-015 — Application connection-pool sizing vs. `max_connections` (code already flags this risk itself)
- **Table/object:** `pg_settings.max_connections`, `pressto_backend/src/datasources/pressto.datasource.ts`
- **Evidence (code):** `pressto.datasource.ts:14-31` — the file's own comments document that `pg.Pool` previously had no configured `max` (silently defaulting to 10) and no `connectionTimeoutMillis`, which caused indefinite request hangs once the pool was exhausted. It's now configured as:
  ```ts
  max: Number(process.env.PG_POOL_MAX) || 15,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
  ```
  with an explicit comment: *"PM2 cluster mode ... runs several instances of this process, EACH with its OWN pool of this size — total DB connections from this app alone is roughly `PM2_INSTANCES * PG_POOL_MAX`... with the 2-instance default in ecosystem.config.js that's 30 total for production — verify actual `max_connections` on the server."*
- **Evidence (DB query):** `SELECT setting FROM pg_settings WHERE name='max_connections';` → **100** on this local instance. `SELECT count(*), state FROM pg_stat_activity GROUP BY state;` → 5 total connections, 1 active (this is the idle local dev instance — **not representative of production traffic**).
- **Observed result:** On this local instance, 30 potential app connections would fit comfortably under 100. The code comment itself explicitly says this needs to be re-verified against the production server's real `max_connections`, "alongside every other environment sharing this server (migration, staging)" — i.e. the developers already know this number isn't necessarily safe in production and left themselves a note to check it.
- **Measured impact:** None measurable from here — this is precisely the kind of thing that needs the production number, not the local-replica number.
- **Why it matters under concurrent production traffic:** If production's `max_connections` is lower than assumed, or if migration/staging environments share the same Postgres server and also hold connections, the app's pool (`PM2_INSTANCES × PG_POOL_MAX`) could exceed capacity under load, reproducing the exact "requests hang/fail to get a connection" failure mode the code comment describes having fixed once already (just with a bounded timeout instead of an infinite hang this time).
- **Severity:** Medium (mitigated by the existing `connectionTimeoutMillis: 10000`, which fails fast instead of hanging — but failing fast under load is still a production incident, just a shorter one)
- **Confidence:** Needs validation — explicitly a production-only question; this local instance's `max_connections=100` is not evidence about production's value.
- **Recommended improvement:** Confirm production's actual `max_connections`, `PM2_INSTANCES`, and `PG_POOL_MAX` env value, and whether any other environment (migration/staging) shares the same Postgres server and consumes connections from the same budget, as the code comment itself requests.
- **Dependencies/risks:** Raising `max_connections` increases Postgres's own memory overhead per connection (relevant given DB-013/DB-014's shared-RAM concern) — must be sized together, not independently.
- **How to validate later:** On production: `SHOW max_connections;`, `SELECT count(*) FROM pg_stat_activity;` during peak load, and compare against `PM2_INSTANCES * PG_POOL_MAX` plus any other environments' pools on the same server.

### DB-016 — Dead-tuple bloat on several hot tables; default autovacuum thresholds likely too loose for the largest ones
- **Table/object:** `customer`, `garment_stain`, `garment_damage`, `sales_return` (and several smaller tables)
- **Evidence (query):**
  ```sql
  SELECT relname, n_live_tup, n_dead_tup, last_vacuum, last_autovacuum, last_analyze, last_autoanalyze
  FROM pg_stat_user_tables ORDER BY seq_scan DESC;
  ```
- **Observed result:** `customer`: 395,132 live / 68,407 dead (17%), `last_autovacuum` = NULL. `garment_stain`: 32,238 live / 7,532 dead (23%), `last_autovacuum` = NULL. `garment_damage`: 150,009 live / 28,000 dead (19%), `last_autovacuum` = NULL. With `autovacuum_vacuum_scale_factor = 0.2` (default) and `autovacuum_vacuum_threshold = 50` (default), `customer` only triggers an autovacuum once dead tuples exceed `50 + 0.2 × 395,132 ≈ 79,076` — current 68,407 is just under that, so the NULL `last_autovacuum` is consistent with the configured threshold simply not having been crossed yet, not necessarily a malfunction. (Caveat: per DB-011, this instance's `n_live_tup`/`n_dead_tup` counters have at least one proven case of being unreliable — this finding should be treated as a candidate, confirmed only insofar as the raw counter values are accurately quoted, not necessarily that they reflect true row counts.)
- **Measured impact:** Up to ~17-23% dead-row overhead on these tables currently; up to a theoretical ~20% before autovacuum intervenes on large tables under the current default scale factor.
- **Why it matters under concurrent production traffic:** A flat 20% scale factor means the *absolute* dead-tuple tolerance grows with table size — fine for small tables, but on `customer` (395k rows) that's ~79k dead rows' worth of bloat tolerated before cleanup, and proportionally more on `orders`/`order_item`/`garment` as they keep growing. Bloat increases table/index size (more pages to scan) and can degrade index-scan performance over time between autovacuum runs.
- **Severity:** Medium
- **Confidence:** Strong indication (the settings and current ratios are confirmed; whether this is already causing a measurable performance problem in production needs validation, and per DB-011 the underlying counters have at least one known inaccuracy on this instance)
- **Recommended improvement:** Lower `autovacuum_vacuum_scale_factor` (e.g. to 0.05-0.1) specifically for the largest/hottest tables (`orders`, `order_item`, `garment`, `customer`, `invoice`) via `ALTER TABLE ... SET (autovacuum_vacuum_scale_factor = 0.05);`, rather than changing the global default.
- **Dependencies/risks:** More frequent autovacuum runs consume more I/O/CPU; should be tuned gradually and monitored, not blanket-applied to all 119 tables.
- **How to validate later:** Re-run the `pg_stat_user_tables` query over time in production and watch `n_dead_tup` trend and `last_autovacuum` cadence after the change.

### Connection/activity/lock snapshot (explicitly not representative of production)
- **Evidence (query):** `pg_stat_activity` grouped by state; `pg_locks` joined to `pg_stat_activity`; a check for queries running longer than 5 seconds.
- **Observed result:** 5 total backend connections, 1 active, 0 queries running longer than 5 seconds, **0 rows in `pg_locks`** (excluding this audit's own backend). PostgreSQL version: 17.7 (Windows build).
- **Why this is flagged separately:** This is exactly the kind of snapshot the task brief warns about — it reflects an idle local dev machine with essentially no concurrent load, not production. **No conclusion about production lock contention, connection saturation, or long-running-query risk should be drawn from this.** It is included only as a methodology record (what was checked) and to confirm no locks were held by this audit's own read-only queries.
- **Severity:** N/A
- **Confidence:** N/A — explicitly non-representative
- **Recommended improvement:** Capture the equivalent `pg_stat_activity`/`pg_locks` snapshot on production during real traffic to get a meaningful read.
- **How to validate later:** Same queries, run against production, ideally during peak hours and repeated a few times rather than as a single snapshot.

---

## Confirmed vs. needs-production-validation — quick index

**Confirmed on this local instance (structural facts, not traffic-dependent):**
DB-001 (missing FKs), DB-002 (orphan rows), DB-003 (type mismatch), DB-004 (table inventory/sizes), DB-005 (payment_transaction.riderid plan), DB-007 (no duplicate indexes), DB-008 (pg_stat_statements absent *here*), DB-009 (orders pending-status scan plan), DB-010 (row-count method validation), DB-011 (sales_return stats discrepancy, local), DB-012 (trgm indexes exist), DB-013 (settings are defaults *here*).

**Needs real production access/metrics to confirm or size a fix:**
Whether production shares the same untuned `postgresql.conf` (DB-013), actual host RAM/CPU split between Postgres and Node (DB-014), production's real `max_connections` and whether other environments share the server (DB-015), whether DB-006's 37 candidate columns are filtered anywhere outside the controllers/services files searched, whether DB-009's unscoped "pending orders" path is actually hit at volume, and whether DB-011's stats-counter discrepancy exists on other/larger production tables. `pg_stat_statements` should be enabled in production specifically to answer the query-performance questions this audit could only infer from code.
