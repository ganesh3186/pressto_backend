# Pressto Production Server: Infrastructure & Incident Audit (corrected)

**Server:** `pressto-svr1` (192.168.1.210, VMware guest, Ubuntu 24.04). Investigated read-only over SSH. Nothing on the server was changed.
**Times:** UTC unless marked. IST = UTC + 5:30.
**Revision:** corrected on 2026-11-02. The first version of this report contained errors, listed in section 6. Use this version.

**Confidence labels:** *Confirmed* = directly observed. *Strong indication* = evidence fits but another cause is possible. *Assumption* = not verified.

---

## 1. Summary

1. **The live database has no scheduled backup.** The nightly job dumps `pressto_prod` (24 MB). The live app uses `pressto_production` (11 GB, about 36M rows). The only copy of the live DB is one manual dump from 2026-11-01 04:24, on the same disk. Fix this first.
2. **The go-live slowdown looks like an application and query problem, not a hardware shortage.** Whole-server CPU peaked at 41% on go-live day. The database logged protocol errors from huge parameter lists, plus login timeouts. This matches the team's own root cause in `workaround.md`: order search built a 59,000+ parameter query and pinned Node's single event loop.
3. **The server resize was not the incident response.** It went from 4 to 8 CPUs on Oct 31 07:49, about a day before go-live. The reason is not recorded.
4. **Nobody has shown this setup can carry 100 staff.** Only 11 orders were created on Nov 1, so the fixes and cluster mode have not been tested under real load.

---

## 2. Reconstructed timeline

| Time | Evidence | Reading | Confidence |
|---|---|---|---|
| Oct 14 to 16 | `pressto-prod-backend-error.log` created Oct 14. `node_modules/pdfkit` dated Oct 16 08:33 | Backend boot-crash loop on missing `pdfkit`, apparently fixed by Oct 16. The log has no timestamps, so the dates are inferred | Strong indication |
| Oct 29 02:28 to 02:30 | Dump named `pressto_migration_before_restore_20261029_022352`, then "checkpoints too frequent" | Checkpoint warnings line up with a DB restore, not app traffic | Strong indication |
| Oct 31 07:47 to 07:49 | Clean poweroff in the journal. `sar` goes from 4 to 8 CPU, RAM from about 8 GB to 23 GB, kernel from 6.8.0-139 to 6.8.0-147 | Planned resize and kernel update, about a day before go-live | Confirmed (reason unknown) |
| Nov 1 (go-live) | `workaround.md` | All staff start on the live system; site very slow | Team's account |
| Nov 1 02:47 to 05:22 | 9 × `bind message has N parameter formats but 0 parameters` on `pressto_production` | App sending parameter lists too large for the Postgres protocol. Matches the 59,000+ parameter search | Strong indication |
| Nov 1 04:47 (×5), 05:14 (×1) | `FATAL: canceling authentication due to timeout` on `pressto_production` | Clients stalled during connection setup. Fits a blocked event loop and the reported login failures | Strong indication |
| Nov 1 04:24 | `pressto_production_before_itpv_chip_20261101_094931.dump`, 2.3 GB | The only dump of the live DB | Confirmed |
| Nov 1 05:29 to 05:30 | `workaround.md` | Failed cluster-mode attempt, about 1 minute down | Team's account |
| Nov 1 05:43 | PM2 `created_at`, ids 14 and 15 | Production running in cluster mode with 2 instances. `workaround.md` still says fork mode, so it is out of date | Confirmed |
| Nov 1 04:00 to 06:59 | `orders` on `pressto_production`: 2, 8, 1 per hour. None after that, as of this check on Nov 2 | Staff stopped using the system; fits the reported revert to iTPV. Oct 30 and 31 show 100 to 180 per hour, but their origin (migrated or entered live) was not checked | Strong indication |

**Evidence not available:** HTTP latency for the incident. There is no slow-query log and no APM, and PM2 logs have no timestamps. nginx logged only 23 requests on Nov 1, because traffic was reaching the Node ports directly until the HTTPS switch that day.

**Server load per day (from `sar`, 10-minute averages, so short spikes are hidden):**

| Day | CPUs | Peak busy | Peak iowait | Peak load (1 min) |
|---|---|---|---|---|
| Oct 25 | 4 | 4.2% | 0.08% | 0.37 |
| Oct 26 | 4 | 7.0% | 1.17% | 0.86 |
| Oct 27 | 4 | 50.8% | 20.77% | 2.27 |
| Oct 28 | 4 | 37.7% | 1.11% | 3.36 |
| Oct 29 | 4 | 61.9% | 22.13% | 7.67 |
| Oct 30 | 4 | 15.5% | 0.76% | 0.96 |
| Oct 31 | 4, then 8 | 33.9% | 4.96% | 4.97 |
| Nov 1 (go-live) | 8 | 41.0% (05:00) | 13.99% (01:10) | 3.10 |

**Why low CPU doesn't clear the app:** in fork mode, one Node process can use at most 1 of 8 cores, which is 12.5% of the whole server. That process can be completely stuck while the server looks mostly idle.

No OOM kills appear in the journal, which goes back to Sep 7. No `too many clients` errors appear in the Postgres logs from Oct 25 to Nov 1.

---

## 3. Findings

### Critical

**INF-S-12: Live database is not covered by scheduled backups**
- **Observed:** `/usr/local/sbin/backup-pressto.sh` runs `pg_dump -d pressto_prod`. The production `.env` has `PG_DATABASE=pressto_production`. No cron or `/usr/local/sbin` script mentions `pressto_production`.
- **Evidence:** nightly dumps are about 1.3 MB; `pressto_prod` has 23,121 estimated rows and `pressto_production` about 36.4M. `archive_mode=off`. The script has no off-server copy. The Nov 1 04:19 dump is 0 bytes.
- **Impact:** a disk failure or bad migration could lose everything since the Nov 1 04:24 dump, and a disk failure would take that dump with it. The job's daily `SUCCESS` line hides this.
- **Confidence:** Confirmed.
- **Fix:** point the job at `pressto_production`, copy dumps off the server, run a restore test, and alert on failure. Check that the 11 GB dump fits the 88 GB free disk at the retention you choose.
- **Downtime:** none.

### High

**INF-S-01: PostgreSQL memory settings are near install defaults**
- **Observed:** effective values from `pg_settings`: `shared_buffers` 128 MB, `work_mem` 4 MB, `maintenance_work_mem` 64 MB, `effective_cache_size` 4 GB, on a 23 GB server.
- **Evidence:** `pressto_production` shows a 38% buffer hit rate and 20 GB of temp files across 7,878 files. These counters are cumulative and include dumps and restores, so they overstate app impact.
- **Impact:** slower queries under concurrency. Not shown to be the go-live cause; iowait was low during the incident window.
- **Confidence:** settings Confirmed; contribution to the incident is an Assumption.
- **Fix:** start around `shared_buffers` 6 GB, `effective_cache_size` 16 GB, `work_mem` about 16 MB, `maintenance_work_mem` 1 GB. Then measure.
- **Downtime:** restart required for `shared_buffers`.

**INF-S-03: Three environments share one VM and one Postgres instance**
- **Observed:** production and migration both run 2 backend workers, plus frontends. `pressto`, `pressto_migration`, `pressto_migration_old` and `pressto_production` all live on one instance. Staging is stopped.
- **Impact:** restores and dumps on migration compete directly with production. Migration's cumulative temp and read counters are also high.
- **Confidence:** Confirmed.
- **Fix:** stop migration during staff hours and go-live, and move it off this server when possible.
- **Downtime:** none for production.

**INF-S-09: No monitoring or slow-query logging**
- **Observed:** no monitoring agent. `log_min_duration_statement=-1`, `log_lock_waits=off`, `pg_stat_statements` not loaded. PM2 logs have no timestamps. `log_checkpoints` is already on.
- **Impact:** the next incident can't be diagnosed while it is happening.
- **Confidence:** Confirmed.
- **Fix:** turn on slow-query and lock-wait logging, add PM2 `log_date_format`, install a host and Postgres monitor, and add `pg_stat_statements`.
- **Downtime:** reload for logging. PM2 reload for timestamps. Restart for `pg_stat_statements`.

**INF-S-13: The app connects to Postgres as the `postgres` superuser**
- **Observed:** `PG_USER=postgres` in both production and migration `.env`. `statement_timeout` and `idle_in_transaction_session_timeout` are both 0 (off).
- **Impact:** an app bug or SQL injection has full control of every database. Runaway queries are never cancelled.
- **Confidence:** Confirmed.
- **Fix:** create a least-privilege app role with its own statement timeout.
- **Downtime:** backend reload to switch credentials.

**INF-S-14: Firewall off, and services listen on open interfaces**
- **Observed:** `ufw` inactive. Node listens on `0.0.0.0` on ports 3032, 3033, 3035, 4030, 4041 and 4050. Postgres listens on `192.168.1.210:5432`. Direct port URLs bypass nginx, TLS and access logs.
- **Impact:** anyone on the LAN can reach the database port and the plain HTTP apps. Internet exposure depends on the upstream router or NAT, which this audit could not see.
- **Confidence:** listening state Confirmed; internet exposure not tested.
- **Fix:** check the upstream forwarding rules, restrict these ports, and route all traffic through nginx.
- **Downtime:** none if done carefully; changing `listen_addresses` needs a Postgres restart.

**INF-S-06: Deploys don't sync dependencies or migration scripts**
- **Observed:** `deploy-backend.ps1` ships `dist/` only. Dependency install, unzip, migrate and restart are manual. `workaround.md` confirms `scripts/*.cjs` are copied by hand.
- **Evidence:** 2,973 `Cannot find module 'pdfkit'` boot crashes and 47 for `../scripts/add-coupon-ticket-visibility.cjs` in the production error log.
- **Impact:** a release can crash-loop production on boot.
- **Confidence:** Confirmed.
- **Fix:** script `npm ci --omit=dev`, migrations and a health check into one deploy step.
- **Downtime:** none.

### Medium

**INF-S-02: Small `max_wal_size` during bulk work**
- **Observed:** `max_wal_size=1GB`, with "checkpoints too frequent" warnings on Oct 27 and Oct 29. `checkpoint_completion_target` is already 0.9.
- **Impact:** extra I/O during restores. The Oct 29 warnings line up with a restore, so this is not shown to be a staff-load issue.
- **Confidence:** Confirmed.
- **Fix:** raise to 4 GB.
- **Downtime:** reload only.

**INF-S-07: Deploy instructions use `pm2 restart`**
- **Impact:** both workers restart together on every deploy. `reload` rolls them one at a time.
- **Confidence:** Confirmed.
- **Fix:** switch to `pm2 reload`, and test it on migration first because cluster mode is new here.
- **Downtime:** none once in use.

**INF-S-08: Worker count not based on measurement**
- **Observed:** `PM2_INSTANCES` is unset, so 2 workers. `PG_POOL_MAX` is unset, so 15 per worker.
- **Impact:** production plus migration can open 60 of 100 connections, before admin tools and dumps.
- **Confidence:** Confirmed.
- **Fix:** size it from a load rehearsal.
- **Downtime:** PM2 reload.

**INF-S-15: Stale databases and readable dumps**
- **Observed:** `/var/backups/postgresql` holds three 2.2 GB migration dumps and the 2.3 GB production dump, mode `-rw-r--r--` inside a `755` directory. `pressto_migration_old` is 11 GB.
- **Impact:** any local user can read customer data in the dumps.
- **Confidence:** Confirmed.
- **Fix:** run `chmod 600` on the dumps. After the owner confirms, delete what is no longer needed.
- **Downtime:** none.

### Low

- **INF-S-04: `migration_readonly` hits its limit of 5 connections.** There were 14 FATALs on Oct 31 from this role. Its client is unidentified. Fix the client's pool size.
- **INF-S-10: Backup log noise.** `find: Failed to restore initial working directory` appears on every run. Add a `cd` to the script. Check the script's exit code at the same time.
- **INF-S-11: Postgres soft `nofile` limit is 1024.** Not a problem at 100 connections. Review if connections grow. Restart needed.
- **INF-S-16: Clock jumps.** The journal shows `Time jumped backwards` (Oct 22, Oct 24), and `sar` samples appear out of order on Oct 31 and Nov 1. Check VM and NTP time sync, because this weakens log timelines.
- **INF-S-17: nginx warns about a conflicting server name** (`staging-pulse-admin`). Clean up the config. Reload only.

### Withdrawn

**INF-S-05 (pdfkit "broken for 3 weeks, currently live"): withdrawn.** The stack trace shows a crash at boot, from `application.js` loading `order-summary-pdf.service`. It was not a per-request failure, so "3,000 failed requests" was wrong. The even spread across the log is a repeating crash block and says nothing about dates. `pdfkit` has been present since Oct 16, and the current workers boot normally. The underlying deploy gap remains as INF-S-06.

---

## 4. Current state (Nov 1 to 2, off-peak)

- **Hardware:** 8 vCPU, 23 GB RAM, 4 GB swap (almost unused), `/` 42% used with 88 GB free.
- **Postgres:** 16.15 with v17 client tools installed. Those tools explain the `transaction_timeout` errors, because that setting doesn't exist on v16 (Strong indication).
- **PM2:** production and migration each run 2 cluster workers, plus frontends. Staging is stopped.

---

## 5. Can this server support about 100 staff?

**Hardware: probably yes. Whole setup: not proven.**

- **For:** 8 cores peaked at 41% on go-live day, iowait stayed low, there were no OOM kills, and Postgres never ran out of connections.
- **Against:** the system was abandoned after 11 orders, so these numbers don't show a full day of staff load. The fixes and cluster mode are untested at that load, and 10-minute samples can hide spikes.
- **Before the next go-live:** back up the live DB, add monitoring, finish the query fixes, tune Postgres, and run a realistic rehearsal. The rehearsal must be off-hours, because every environment on this VM shares its resources.

Fix order and priorities are in `checklists/`.

---

## 6. Corrections to the first version

| First version said | Actually |
|---|---|
| Backups are "sound" and "working and verified" | **Wrong.** They cover the wrong database (INF-S-12) |
| The incident was on Oct 31 | Go-live was Nov 1 |
| The resize was "almost certainly" the emergency fix | It happened about a day before go-live |
| The resize was "not a kernel/OS change" | The kernel also changed, 139 to 147 |
| The plain `pressto-backend` app was the "previous system" the team reverted to | That app is staging. The previous system is iTPV |
| Postgres had 591 FATAL/ERROR lines on Oct 31, "mildly elevated" | 591 counted all log lines. Actual: 4 on Oct 30, 69 on Oct 31, 102 on Nov 1 |
| `bind message` and `transaction_timeout` errors came from a BI tool on the read-only account | They ran as `postgres`. `bind` errors match the app's oversized queries; `transaction_timeout` likely comes from v17 tools |
| pdfkit broken for 3 weeks and live | Withdrawn, see above |
| `shared_buffers` is Critical and "most likely" to cause a repeat | Downgraded to High, no evidence it caused the incident |
| Enable `log_checkpoints`, raise `checkpoint_completion_target` to 0.9 | Both already set |
| Checkpoint storms were chronic | Oct 29 lines up with a restore |
| No post-resize business-hours data exists | It did exist; my command cut off the output |
| Pool timeouts not mentioned | 14 pool-timeout errors in the production log (undated) and 8 in migration's log |
| `pressto_prod` treated as production | Live DB is `pressto_production` |
