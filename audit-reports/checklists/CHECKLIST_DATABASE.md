# Database Checklist

**Live database:** `pressto_production` on PostgreSQL 16.15. **Source:** `db-audit.md`, `SERVER_INCIDENT_AUDIT.md`.
**Priorities:** P0 = do first, before the next go-live. P1 = high impact. P2 = medium. P3 = low.
**Downtime:** `none`, `reload` (no outage), `restart` (brief outage, schedule off-hours).

> `DB-*` findings were measured on a local copy, not on `pressto_production`. Items marked **(re-check)** need confirming on the live DB first. Settings marked **(verified live)** were read from the server.

## P0

- [ ] **Get a scheduled, restore-tested backup of `pressto_production`.** Tracked in `CHECKLIST_SERVER.md`. `INF-S-12` | none
- [ ] **Get a scheduled, restore-tested backup of `pressto_production`.** Tracked in `CHECKLIST_SERVER.md`. **Status: on hold until the server move, by decision.** `INF-S-12` | none
- [ ] **Log slow queries and lock waits:** `log_min_duration_statement=500ms`, `log_lock_waits=on` **(verified live: both off)**. `INF-S-09` | reload
- [ ] **Stop the app using the `postgres` superuser;** create a least-privilege role **(verified live)**. `INF-S-13` | backend reload
- [ ] **Set a statement timeout for the app role.** `statement_timeout` is 0 today, so runaway queries never stop **(verified live)**. `INF-S-13` | backend reload
- [ ] **Set `idle_in_transaction_session_timeout`.** It is also 0 **(verified live)**. `INF-S-13` | reload
- [ ] **Add a DB constraint: one open shift per store/user.** Check for existing duplicates first. Code side is in `CHECKLIST_BACKEND.md`. `ARC-011` | none
- [ ] **Add a DB constraint: one open shift per store/user.** **Status: decided against, so no constraint will be added. `npm run migrate` can't express a partial unique index: declared on the model it builds a plain unique index on `storeId` (one shift per store, ever), and left off the model migrate drops it. The advisory lock in `CHECKLIST_BACKEND.md` closes the race instead. No store has duplicate open shifts on production or migration (checked Nov 3).** `ARC-011` | none

## P1

- [ ] **Tune memory for 23 GB RAM:** `shared_buffers` 6 GB, `effective_cache_size` 16 GB, `work_mem` about 16 MB, `maintenance_work_mem` 1 GB **(verified live: near defaults)**. `INF-S-01`, `DB-013` | restart
- [ ] **Enable `pg_stat_statements`** in the same restart window, then capture a baseline. `DB-008` | restart
- [ ] **Add the partial index for "pending orders"** **(re-check)**. `DB-009` | none (`CONCURRENTLY`)
- [ ] **Add the `payment_transaction.riderid` composite index** **(re-check)**. `DB-005` | none (`CONCURRENTLY`)
- [ ] **Clean the orphan rows** (27 in the local copy) **(re-check)**. `DB-002` | none
- [ ] **Add foreign keys in stages, after the cleanup.** Only 2 of 121 tables had one locally **(re-check)**. `DB-001` | none (`NOT VALID`, then validate)
- [ ] **Budget connections.** Production 30 + migration 30 + staging 30 if restarted, against 100. `DB-015`, `INF-013` | none

## P2

- [ ] **Raise `max_wal_size` to 4 GB.** Warnings line up with restores, not staff traffic **(verified live: 1 GB)**. `INF-S-02` | reload
- [ ] **Tighten autovacuum on the biggest hot tables** **(re-check)**. `DB-016` | none
- [ ] **Fix stale planner statistics on `sales_return`** with `ANALYZE` **(re-check)**. `DB-011` | none
- [ ] **Review the 37 FK-like columns without indexes.** Use `pg_stat_statements` data; add only the ones queries actually use. `DB-006` | none

## P3

- [ ] **Fix the `customer.userid` type** (`text` vs `users.id` `uuid`). `DB-003` | needs planning
- [ ] **Remove `pressto_migration_old`** (11 GB), after the owner confirms. `INF-S-15` | none
- [ ] **Clarify what `pressto_prod` is** and remove it if unused, after the backup job is repointed. It is 24 MB and easily confused with the live DB. | none

## No action needed

- `DB-007`: no duplicate indexes found (local copy).
- `DB-012`: trigram indexes already in place for text search (local copy).
- `DB-004`, `DB-010`: table-size reference data, no fix.
- `DB-014`: now measured. CPU peaked at 41% on go-live day (`SERVER_INCIDENT_AUDIT.md`).
