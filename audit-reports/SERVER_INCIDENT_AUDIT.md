# Pressto Production Server — Infrastructure & Incident Audit

**Scope:** read-only investigation of the production server (`pressto-svr1`, `192.168.1.210`, hostname `svr1`) behind the recent cutover incident ("~100 employees started working, app became slow, APIs stayed pending, team reverted to the previous system").
**Method:** live root SSH session (read-only commands only — no restarts, no config edits, no writes to the database, no load testing). Evidence pulled from `journalctl`, `sar`/`sysstat` history, PostgreSQL logs, PM2 logs, `nginx -T`, `pg_roles`/`pg_stat_activity`, backup logs, and deploy scripts in this repo.
**No fixes applied.** This report is for review only.

All timestamps are server-local, which is UTC.

---

## 1. Executive summary

The server was **resized from 4 vCPU / ~8 GB RAM to 8 vCPU / 23 GB RAM at 07:49 on 2026-10-31**, confirmed directly from `sar`'s CPU-count header changing from `(4 CPU)` to `(8 CPU)` across the reboot recorded in that file, and from the pre/post memory totals computed from the same data (`sar -r`). This almost certainly **is** the incident remediation: production was being asked to carry ~100 concurrent employees on a 4-core, 8 GB box that was also simultaneously running a second full application stack ("migration" environment) plus PostgreSQL, all on the same single VM.

Two things stand out:

1. **The hardware fix was real but the database was never re-tuned for it.** `shared_buffers` is still `128MB` — PostgreSQL's out-of-the-box default — on a server that now has 23 GB of RAM. It was also `128MB` before the resize, on an 8 GB box, which was already too small. Nobody has touched `postgresql.conf` in connection with this incident.
2. **Production and a second environment ("migration") share one Postgres instance and one VM**, each running its own 2-instance PM2 cluster, 24/7, whether or not it's needed — on top of whatever headroom the resize bought back.

Separately, and **not** part of the cutover-day root cause but worth fixing on its own merits: production has been throwing `Error: Cannot find module 'pdfkit'` continuously for roughly three weeks (first and last occurrence span nearly the entire 84k-line current error log, born 2026-10-14) — a broken PDF/invoice-generation code path that nobody has noticed or fixed, deployed via a process that ships `dist/` only and never runs `npm install` on the server.

**Bottom line on the closing question — can the current hardware/config reliably carry ~100 concurrent employees:** the *hardware* now plausibly can. The *configuration* cannot yet be trusted to, because PostgreSQL is still running on defaults sized for a toy VM, two full environments contend for the same instance, and there is no monitoring in place that would tell anyone before the next cutover whether it's about to happen again.

---

## 2. What actually happened on 2026-10-31 (reconstructed timeline)

| Time (UTC) | Evidence | What it shows |
|---|---|---|
| Until 07:47:42 | `sar -u -f sa31`, `(4 CPU)` header | Server was running on **4 vCPUs**, ~**8 GB RAM** (computed from `sar -r`: `kbmemused/%memused ≈ 8.1 GB` total) |
| 06:10–06:40 | `sar -b -f sa31`: `bread/s` peaks at 18,035 kB/s (06:20), 14,117 kB/s (06:30), 7,496 kB/s (06:40); `%user` CPU jumps to 23.9% then 20.2% (vs. a ~1–3% baseline all night) | A sustained spike in disk reads and CPU starting ~06:10, well above the night's idle baseline — the first clear sign of load on the box that morning |
| 06:25:10 | Postgres log: `FATAL: terminating background worker "X" due to administrator command` | Something administratively interrupted a Postgres background worker around this time — consistent with prep for the resize/reboot |
| 06:40:15 (×8) | Postgres log: `FATAL: too many connections for role "migration_readonly"` | A client (BI/export tool using the read-only tunnel account described in `db-tunnel-instructions.txt`) opened more than 5 simultaneous connections against a role capped at `CONNECTION LIMIT 5`. Confirmed via `SELECT rolconnlimit FROM pg_roles WHERE rolname='migration_readonly'` → `5`. This is real contention on the shared instance but is **not** the main production pool — see §5. |
| 07:47:42 | `journalctl -k -b -1`: `systemd-shutdown: Syncing filesystems...` → `Reached target poweroff.target` → `Shutting down` | A **clean, deliberate shutdown** — not a crash, not an OOM kill. No OOM-killer entries exist anywhere in the retained journal (back to 2026-09-07). |
| 07:49:28 | New boot ID in `journalctl --list-boots`; `sar` header flips to `(8 CPU)` | Server came back up with **double the vCPUs**. `free -h` now reports 23 GB total vs. the ~8 GB computed for the prior boot. This is a VM resize (`Detected virtualization vmware` appears in the boot log), not a kernel/OS change. |
| 00:38 (Nov 1, server-local — see note) / legacy `pressto-backend` app | PM2 `created_at` for the legacy, non-prefixed `pressto-backend` process | The team's "revert to the previous system" was PM2's plain-named app, last writing to its log at **2026-10-31 19:09** (file `mtime`) before going idle — it is currently `stopped`, with 6 accumulated restarts over its lifetime (not a crash-loop that evening; its last log lines before the file stopped growing are routine notification-send failures, not startup crashes). |
| 05:34–05:43 (Nov 1) | `pm2 jlist` `created_at` for `pressto-prod-backend` (ids 14/15) and `migration-pressto-backend` (ids 12/13) | Both environments' backend clusters were restarted again this morning, ~10 hours before this audit — the team moved back onto the "prod" stack sometime after the resize, abandoning the legacy revert. |

**Reading this honestly:** the Postgres FATAL/ERROR volume on 2026-10-31 (591 lines) is only mildly above the surrounding days (180–591/day, 2026-10-25 to 2026-11-01) — it is **not** a connection-exhaustion spike unique to the cutover. The clearest, least ambiguous signal that something changed is the vCPU/RAM jump at 07:49, not the Postgres error log. Treat anything below that infers "what it felt like to the 100 employees" as **Needs validation** unless marked Confirmed — there is no APM, no nginx access-log retention long enough, and no `log_min_duration_statement` to show exact request latency during the incident window (see Finding INF-S-09).

---

## 3. Findings

Format: **Finding ID | Observed | Evidence | Impact | Severity | Confidence | Recommendation | Downtime required?**

### INF-S-01 — PostgreSQL `shared_buffers` left at the 128 MB install default on a 23 GB server
- **Observed:** `shared_buffers = 128MB` in `/etc/postgresql/16/main/postgresql.conf`.
- **Evidence:** `grep shared_buffers /etc/postgresql/16/main/postgresql.conf` → `shared_buffers = 128MB  # min 128kB`. This value predates and survives the 07:49 resize — it was never revisited.
- **Impact:** Postgres cannot cache more than 128 MB of hot data/indexes in its own shared memory; everything else round-trips through the OS page cache or disk on every access. Under concurrent load (100 users hitting the same hot tables — orders, shifts, riders) this manifests exactly as "APIs remained pending": queries that should be sub-millisecond index hits become page-cache or disk reads, compounding with the missing indexes/FK findings already reported in `backend-audit.md`/`db-audit.md`.
- **Severity:** Critical
- **Confidence:** Confirmed
- **Recommendation:** Set `shared_buffers` to ~6–8 GB (≈25–30% of the 23 GB now available), raise `effective_cache_size` to ~16 GB, raise `work_mem` from the unset/tiny default appropriately for concurrent connection count, and raise `maintenance_work_mem` for faster autovacuum/index builds. Standard PGTune-style sizing for a dedicated-ish 23 GB/8-core box is a reasonable starting point.
- **Requires restart:** Yes — `shared_buffers` requires a full PostgreSQL restart (brief downtime; schedule off-hours).

### INF-S-02 — `max_wal_size` undersized, causing checkpoint storms
- **Observed:** `max_wal_size = 1GB`.
- **Evidence:** Postgres log, 2026-10-27 04:41–04:44 and 2026-10-29 02:29–02:30: repeated `LOG: checkpoints are occurring too frequently (8–23 seconds apart)` — Postgres's own built-in warning that it is checkpointing far more often than intended (default target is 5 minutes).
- **Impact:** Checkpoint storms cause bursty I/O and write-amplification that directly compete with foreground query latency — another contributor to "pending" API calls, independent of the cutover but chronic since at least 2026-10-27, i.e. **pre-existing**, not newly introduced by the cutover.
- **Severity:** High
- **Confidence:** Confirmed
- **Recommendation:** Raise `max_wal_size` to 4–8 GB, `checkpoint_completion_target` to 0.9, and enable `log_checkpoints` permanently (see INF-S-09) so this is visible on an ongoing basis rather than discovered after the fact.
- **Requires restart:** No for `max_wal_size`/`checkpoint_completion_target` (reload is sufficient: `pg_ctl reload` / `systemctl reload postgresql@16-main`).

### INF-S-03 — Production and "migration" are two full, permanently-running environments sharing one VM and one Postgres instance
- **Observed:** `pm2 list` shows `pressto-prod-backend` (cluster ×2), `pressto-prod-admin-panel`, `pressto-prod-customer-web` running **alongside** `migration-pressto-backend` (cluster ×2), `migration-pressto-admin-panel`, `migration-pressto-customer-web`, all day, every day, plus a third, currently-stopped "plain" (legacy/staging) copy.
- **Evidence:** `pm2 jlist`; `ss -tlnp` shows Postgres listening on both `127.0.0.1:5432` and the LAN IP `192.168.1.210:5432`, one instance serving both `pressto_prod` and `pressto_migration` databases (confirmed via `pg_stat_activity.datname`).
- **Impact:** Every CPU cycle, connection slot, and buffer-cache page the migration environment consumes is one fewer available to production, with zero isolation between them, at the exact moments production needs headroom most (business hours). This is also how the unrelated `migration_readonly` connection-limit FATALs (INF-S-04) and the schema-mismatch query errors ended up sharing blast radius with production's own instance.
- **Severity:** High
- **Confidence:** Confirmed
- **Recommendation:** Either retire the migration environment once cutover is confirmed stable, or move it to its own Postgres instance/VM (or at minimum its own `postgresql.conf` resource limits via a separate cluster on the same box, with `max_connections` and memory explicitly partitioned). Do not let a one-time migration environment sit at full production-equivalent resourcing indefinitely.
- **Requires restart:** No (process/infra reorganization, not a config flag).

### INF-S-04 — `migration_readonly` role repeatedly exhausts its own connection limit, and its queries don't match the schema
- **Observed:** Bursts of `FATAL: too many connections for role "migration_readonly"` (06:40:15 ×8, 12:38:45 ×3 on 2026-10-31) and a cluster of query errors against `pressto_migration` at 12:07–12:36: `ERROR: unrecognized configuration parameter "transaction_timeout"`, `ERROR: column "createdat" does not exist`, `ERROR: column reference "createdat" is ambiguous`, `ERROR: function max(uuid) does not exist`.
- **Evidence:** `postgresql-16-main.log.1`, grep by date/role shown above; role connection limit confirmed via `pg_roles.rolconnlimit = 5`.
- **Impact:** Whatever client is using this tunnel account (per `db-tunnel-instructions.txt`) is opening more parallel connections than the account allows, and running queries written for a different schema or a newer Postgres version (`transaction_timeout` is a PG17+ setting; this server runs PG16). This is self-contained failure on the client's side, but it still adds connection churn and (minor) log noise to the **same shared instance** production depends on (see INF-S-03). This is background noise present at similar volume on every day checked (2026-10-25 through 2026-11-01), **not** a cutover-specific event.
- **Severity:** Medium
- **Confidence:** Confirmed (the errors); Strong indication (that it meaningfully affected production latency, given it shares the instance)
- **Recommendation:** Fix or retire whatever script/BI tool is driving this (case-sensitive column names and a PG17-only setting both point to a tool built against the wrong schema/version); raise or pool its connection limit deliberately if the access pattern is legitimate and bursty-by-design.
- **Requires restart:** No.

### INF-S-05 — `pressto-prod-backend`'s PDF/invoice generation has been broken for ~3 weeks
- **Observed:** `Error: Cannot find module 'pdfkit'` — 2,973 occurrences in `/root/.pm2/logs/pressto-prod-backend-error.log`, from essentially the first line to nearly the last line of a log file born 2026-10-14 (i.e., spans the entire log's current retention, not a one-day event).
- **Evidence:** `grep -c "Cannot find module 'pdfkit'"` and `grep -n` line-position check (first hit at line 3, last at line 83219 of 84544 total lines). `pdfkit` **does** exist in the current `node_modules` on the server (`test -d .../node_modules/pdfkit` → yes), meaning this was fixed at the filesystem level at some point but the error volume suggests it ran broken for a long stretch beforehand, or a stale cluster worker process continued erroring until its next restart.
- **Impact:** Whatever feature calls this (invoice/PDF generation, by the module name) has been failing on every attempt for weeks, generating ~3,000 failed requests with no evidence anyone noticed — there is no monitoring that would have surfaced this (see INF-S-09). This is a real, currently-live defect, independent of the cutover.
- **Severity:** High
- **Confidence:** Confirmed (the errors exist and are voluminous); Needs validation (exact root cause/whether it's fully resolved now — the module directory exists, but nothing in this audit confirms the feature works end-to-end today, since that would require a non-read-only functional test)
- **Recommendation:** Reproduce the failing request path, confirm whether it's actually resolved post-fix, and — separately — fix the deploy process so a missing dependency can't reach production silently (see INF-S-06).
- **Requires restart:** No to investigate; a backend restart only if a code/dependency fix is applied (out of scope for this phase).

### INF-S-06 — Deploy script ships `dist/` only; `node_modules` sync is a manual, undocumented step
- **Observed:** `deploy/deploy-backend.ps1` builds, zips `dist/`, and `scp`s `dist.zip` to the server. It explicitly prints that unzipping, PM2 restart, and any DB migration are "manual follow-up on the server" — there is no step that runs `npm install` or otherwise reconciles `node_modules` with `package.json` on the target.
- **Evidence:** `pressto_backend/../deploy/deploy-backend.ps1` (read in this repo, not on the server).
- **Impact:** Any dependency added in a release (like, plausibly, `pdfkit` — INF-S-05) can ship as a `require()` in compiled `dist/` code with no corresponding `node_modules` entry on the server, and nothing in the pipeline will catch it before it starts erroring in production.
- **Severity:** High
- **Confidence:** Confirmed
- **Recommendation:** Add an explicit `npm ci --omit=dev` (or equivalent) step to the server-side deploy instructions, ideally scripted and run automatically after unzip, before `pm2 restart`.
- **Requires restart:** No (process change).

### INF-S-07 — Production backend deploy restarts PM2 instead of reloading it
- **Observed:** The deploy script's printed follow-up instructions tell the operator to run `pm2 restart $pm2Name`, not `pm2 reload`.
- **Evidence:** `deploy-backend.ps1` final `Write-Host` block.
- **Impact:** `pm2 restart` on a cluster app drops all instances and restarts them together — a short full outage on every deploy — whereas `pm2 reload` would roll instances one at a time with zero downtime. This is a known, previously-documented pattern in this app (see `ecosystem.config.js` comment history referenced in the prior full-stack audit) that has not been changed.
- **Severity:** Medium
- **Confidence:** Confirmed
- **Recommendation:** Switch the documented/scripted command to `pm2 reload <name>` for cluster-mode apps.
- **Requires restart:** N/A — this *is* the restart-vs-reload fix itself; applying it causes one brief full outage the last time, zero-downtime every time after.

### INF-S-08 — `pm2` cluster instance count is hardcoded to 2, unaware of the new 8-core capacity
- **Observed:** `pressto-prod-backend`'s `ecosystem.config.js`: `instances: Number(process.env.PM2_INSTANCES) || 2`. `PM2_INSTANCES` is not set anywhere on the server (`/etc/environment`, `/etc/profile.d` both empty for it), so both production and migration backends run exactly 2 cluster workers each, unchanged since before the resize.
- **Evidence:** `cat ecosystem.config.js` on server; `grep PM2_INSTANCES /etc/environment /etc/profile.d/*`.
- **Impact:** The box now has 8 cores; the Node app tier is only configured to ever use 2 per environment (4 total across prod+migration), leaving real spare capacity that a tuned-up Postgres (INF-S-01) would otherwise be able to share with a larger app tier under peak load.
- **Severity:** Medium
- **Confidence:** Confirmed
- **Recommendation:** Reassess instance count now that cores are available — but only after INF-S-01/02 are addressed and INF-S-03 (migration environment's footprint) is resolved, since Postgres and migration also need headroom on the same 8 cores.
- **Requires restart:** Yes — changing `instances` requires a PM2 reload/restart of that app.

### INF-S-09 — No monitoring, no slow-query logging, no APM; this incident could recur invisibly
- **Observed:** No `netdata`, `prometheus`, `node_exporter`, `datadog`, or similar agent running (`systemctl list-units --state=running | grep -iE "netdata|datadog|prometheus|grafana|node_exporter"` → empty). `log_min_duration_statement`, `log_connections`, and `log_lock_waits` are all unset in `postgresql.conf` (grep returned nothing). `nginx` access logging exists but rotated logs are tiny (the current `access.log` is 2 KB, `access.log.1` is 260 bytes) — nowhere near what ~100 employees' worth of daily traffic should produce, suggesting either very low actual API traffic through nginx (plausible if the mobile/admin apps hit the backend directly on its port rather than through the proxy for some routes) or aggressive, early rotation that already discarded the incident window.
- **Evidence:** As above; `ls -la /var/log/nginx/`.
- **Impact:** Nobody can see CPU/memory/connection trends in real time, nobody gets paged, and there is no query-level evidence of *which* endpoints were slow during the incident — this audit had to reconstruct the timeline indirectly from `sar`, PM2 `created_at`, and file `mtime`, rather than from a dashboard or slow-query log. The next capacity problem will be just as invisible until users complain.
- **Severity:** Critical (not because it caused this incident, but because it guarantees the next one is diagnosed the same way — after the fact, by inference)
- **Confidence:** Confirmed
- **Recommendation:** At minimum: turn on `log_min_duration_statement` (e.g. 500ms) and `log_lock_waits` on Postgres (reload only, no restart); stand up a lightweight agent (`netdata` is a single-package, low-overhead option) for CPU/mem/disk/network trending with history; confirm nginx access logging is actually capturing all proxied app traffic.
- **Requires restart:** No for the Postgres logging settings (`pg_ctl reload`); no for a monitoring agent install.

### INF-S-10 — Backup job is sound but logs a benign error on every run
- **Observed:** Daily cron (`0 2 * * *`, as `postgres`) runs `/usr/local/sbin/backup-pressto.sh`, which does `pg_dump -Fc` → verifies with `pg_restore --list` → atomic `mv` → prunes dumps older than 14 days. Every single run in the retained log (2026-10-27 through 2026-11-01) reports `SUCCESS: ...dump`, so **backups are working and verified**. However, every run also logs `find: Failed to restore initial working directory: /root: Permission denied` immediately after the `SUCCESS` line.
- **Evidence:** `/var/log/backup-pressto.log` tail; script source at `/usr/local/sbin/backup-pressto.sh`.
- **Impact:** None to backup integrity today (the dump itself always succeeds first, and this error is produced by the post-success cleanup's directory handling under the `postgres` user, which lacks access to `/root`, the cron job's starting directory). But it pollutes the log with a permanent false-positive error on every run, which will blunt anyone's ability to `grep -i error` this log and trust the result when a real failure eventually happens.
- **Severity:** Low
- **Confidence:** Confirmed
- **Recommendation:** Add `cd "$BACKUP_DIR"` (or any directory `postgres` can access) near the top of the script before the `find -delete` step, so the shell doesn't need to restore an inaccessible working directory.
- **Requires restart:** No.

### INF-S-11 — PostgreSQL's own file-descriptor soft limit is low relative to hard limit
- **Observed:** `postgres`'s process soft limit for open files is `1024` (hard limit `524288`).
- **Evidence:** `/proc/<postgres-pid>/limits`.
- **Impact:** Not currently a problem at `max_connections = 100`, but worth raising proactively alongside the other tuning in INF-S-01 so it isn't the next silent ceiling hit after everything else is fixed.
- **Severity:** Low
- **Confidence:** Confirmed (the limit); Needs validation (whether it would actually bind before `max_connections` does)
- **Recommendation:** Raise the `postgres` systemd unit's `LimitNOFILE` toward the hard limit as part of the same maintenance window as INF-S-01.
- **Requires restart:** Yes (systemd unit change + Postgres restart).

---

## 4. Hardware/OS resource utilization — current state

- **CPU:** 8 vCPUs (post-resize), current load average ~0.2–0.4 (idle at time of audit, a Sunday afternoon — **not representative of business-hours load**; no equivalent business-hours sample exists post-resize yet since the resize happened the prior morning).
- **Memory:** 23 GiB total, 2.5 GiB used, 18 GiB in buff/cache, 21 GiB "available" at time of audit. Swap: 4 GiB configured, 1.5 MiB used (no memory pressure right now).
- **Disk:** `/` is an LVM volume, 150 GB total, 63 GB used (42%), 88 GB free — no near-term space pressure. Current I/O (`iostat`) is near-idle.
- **OS:** Ubuntu 24.04.4 LTS, kernel `6.8.0-147-generic`, running as a VMware guest.

These are all **current, off-peak** snapshots. The only numbers in this report that speak to actual incident-time conditions are the `sar` history in §2 and the log timestamps in §3 — everything in this section should be read as "здесь and now," not "during the incident."

## 5. Services

- **PostgreSQL 16.15** (cluster `16/main`), listening on `127.0.0.1:5432` and `192.168.1.210:5432`. A second cluster, `17-main`, is installed but inactive/disabled — client tools for v17 are present but the running database is v16; there is no in-place upgrade in progress.
- **PM2 v7.0.4**, running 3 named environments (`pressto-*` legacy/stopped, `migration-pressto-*`, `pressto-prod-*`) concurrently — see INF-S-03/08.
- **nginx**, `worker_processes auto`, `worker_connections 768`, reverse-proxying `live-pulse-api/admin/customer.press2india.com` → ports 3035/3032/3033, and `staging-pulse-*` → 3040/3031/3030. Config looks reasonable for current traffic; no `proxy_read_timeout` override found (uses nginx default of 60s), which is fine unless a backend route is legitimately slower than that — worth re-checking once INF-S-01/02 are fixed and real load-tested.
- **No monitoring/APM agent** — see INF-S-09.

## 6. Overall assessment

**Can the current hardware reliably support ~100 concurrent employees?** Plausibly yes, *once* the configuration catches up to the hardware. Today, the server has real headroom (8 cores, 23 GB RAM, low current utilization) that did not exist before 2026-10-31 07:49. But:

- PostgreSQL is still configured as if it has 128 MB to work with, not 23 GB (INF-S-01) — the single highest-leverage, least-risky fix available, and the one most likely to directly reproduce the "slow app, pending APIs" symptom if left as-is under real concurrent load.
- A second full environment runs unthrottled on the same instance and VM every hour of every day (INF-S-03), eating into whatever margin the resize bought.
- There is no observability (INF-S-09) to confirm any of this before the next time ~100 people log in at once — right now, the honest answer to "will it hold up" is a reasoned inference from static config and historical logs, not a measurement.

**Recommended order (none of this has been applied — awaiting approval):**
1. INF-S-01 + INF-S-02 (Postgres memory/checkpoint tuning) — single maintenance window, one planned restart.
2. INF-S-09 (slow-query logging + lock-wait logging via reload; monitoring agent install) — so the *next* change (or the next busy day) is actually measurable.
3. INF-S-03 (separate or retire the migration environment) — reclaims shared capacity.
4. INF-S-06 + INF-S-07 (deploy process: `npm install` step, `pm2 reload` not `restart`) — prevents repeat of INF-S-05-style incidents and removes the only remaining source of planned-deploy downtime.
5. INF-S-05 (confirm pdfkit path actually fixed) and INF-S-10/11/04/08 (lower urgency, low risk, can be bundled into the same maintenance window as #1).

No code, configuration, or service changes have been made as part of this audit.
