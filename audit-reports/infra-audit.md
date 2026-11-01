# Pressto Production-Readiness Audit — Agent 4: Infrastructure, Deployment & Observability

**Scope constraint (binding):** This audit was performed entirely from the local Windows dev
machine (`D:\karans_code_lab\pressto`). No SSH access, no credentials, no live metrics from the
actual Ubuntu production server exist in this session. The production server spec (Ubuntu,
8 vCPU, 16 GB RAM, Postgres 16 + Node + static frontends on one box, single PM2 instance* of the
backend, Nginx reverse proxy) is a **user-provided claim, unverified** by direct measurement —
treated as a claim to note, not a fact confirmed here. (*Note: local `ecosystem.config.js`
evidence below actually shows the backend configured for **2** cluster instances, not one — see
INF-001; this is a discrepancy between the claim and the committed config, not something this
audit can resolve without seeing what's actually running on the server.)

`db-tunnel-instructions.txt` was intentionally skipped per instructions (different, credential-gated
read-only DB tunnel). No remote hosts, IPs, or hostnames found in config files were contacted;
they are only noted as references below.

---

## Findings

### INF-001 — PM2 cluster mode, 2 instances, but deploy uses `restart` not `reload`
- **Artifact:** `pressto_backend/ecosystem.config.js`; `deploy/deploy-backend.ps1` (line "pm2 restart $pm2Name")
- **Evidence:** `ecosystem.config.js` runs `exec_mode: 'cluster'`, `instances: Number(process.env.PM2_INSTANCES) || 2`. In-line comments explain this was recently changed from fork mode (single event loop) specifically because ~100 concurrent staff logins/searches at go-live stalled on one core. However, the deploy script's printed server-side follow-up step says `pm2 restart $pm2Name`, not `pm2 reload $pm2Name`. In PM2 cluster mode, `restart` kills and respawns all workers together (brief full outage window); `reload` would roll workers one at a time for zero-downtime restarts — the stated benefit of cluster mode is only half-realized if `restart` is what's actually run operationally.
- **Why it matters:** Every deploy currently causes a short full-service interruption rather than the zero-downtime behavior cluster mode is capable of.
- **Severity:** Medium
- **Confidence:** Strong indication (the script text is unambiguous; whether operators always copy-paste the exact printed command, or substitute `reload` themselves, cannot be confirmed from here)
- **Recommended improvement:** Change the printed/executed command to `pm2 reload <name>` (and confirm app handles SIGINT/graceful shutdown — `pressto.datasource.ts` does implement a LoopBack `lifeCycleObserver` for graceful datasource disconnect, which is a good sign for reload-safety).
- **Dependencies/risks:** Needs confirmation that the LoopBack app overall shuts down gracefully (not just the datasource) before relying on `reload`.
- **How to validate later:** Requires SSH access to the production server to see actual deploy history / PM2 logs, and to test a `reload` in a maintenance window.

### INF-002 — No automated DB migrations in the deploy pipeline; manual, unordered migration scripts
- **Artifact:** `deploy/deploy-backend.ps1`; `pressto_backend/package.json` (scripts); `pressto_backend/scripts/*.cjs`
- **Evidence:** `deploy-backend.ps1`'s own doc-comment states: "This only gets the build onto the server as dist.zip. Unzipping, restarting PM2, and any DB migration step are still a manual follow-up on the server." `package.json` has ~25 separate `migrate:*` npm scripts, each pointing at an individual one-off `.cjs` script in `pressto_backend/scripts/` (e.g. `add-coupon-order-fields.cjs`, `add-dashboard-indexes.cjs`) — there is no single ordered/versioned migration runner (no Flyway/Knex-migrate/Sequelize-migrations style ledger); each must be remembered and run by hand, in the right order, on the right environment.
- **Why it matters:** High risk of migrations being skipped, run out of order, or run on the wrong environment (migration/staging/production share one server per `deploy-common.ps1`'s `Resolve-RemoteBase`). No automatic tracking of which migrations have already been applied to a given environment.
- **Severity:** High
- **Confidence:** Confirmed (directly evidenced in committed files, no live access needed for this conclusion)
- **Recommended improvement:** Desk-based note only, not an instruction to implement: a migration ledger table and a single ordered runner would reduce operator error risk. This is a process gap independent of server specs.
- **Dependencies/risks:** Any migration tool adoption needs care given the existing ad hoc scripts already run directly against production data.
- **How to validate later:** Requires server access to see actual migration run history/order for each environment.

### INF-003 — No rollback path in any deploy script
- **Artifact:** `deploy/deploy-backend.ps1`, `deploy-admin-panel.ps1`, `deploy-customer-web.ps1`
- **Evidence:** Each script's server-side instructions are `rm -rf dist && mkdir dist && unzip -o dist.zip -d dist && rm dist.zip` (or `build` equivalent) followed by `pm2 restart`. The previous `dist/`/`build/` is deleted before the new one is unpacked — no previous-version archive is kept server-side by the script, and no documented rollback command exists anywhere in the `deploy/` folder.
- **Why it matters:** If a bad build ships, the only stated recovery path is re-running the whole build-and-deploy pipeline from a known-good git commit — there is no "restore previous dist.zip" one-liner.
- **Severity:** High
- **Confidence:** Confirmed from script text
- **Recommended improvement:** Desk-based note: keeping the prior `dist.zip`/`build.zip` server-side (e.g. renamed to `.bak`) before overwrite would give a fast rollback option.
- **Dependencies/risks:** None beyond disk space.
- **How to validate later:** Requires server access to confirm no undocumented rollback convention already exists operationally (e.g. an operator's own manual habit not captured in these scripts).

### INF-004 — No health check step wired into the deploy flow, despite a health endpoint existing in code
- **Artifact:** `pressto_backend/src/controllers/ping.controller.ts` (and acceptance test `ping.controller.acceptance.ts`); `pressto_backend/src/index.ts` (logs `Try http://.../ping` on boot); `deploy/deploy-backend.ps1`
- **Evidence:** A `/ping` endpoint is implemented and tested in the codebase. The deploy script's printed post-deploy steps are: unzip, grep `.env` for `PORT`/`PG_DATABASE` as a "sanity check", then `pm2 restart`. There is no curl/health-check call against `/ping` (or any endpoint) after restart to confirm the new build actually came up healthy.
- **Why it matters:** A deploy that silently fails to start (crash loop, bad env var, migration not yet applied) would not be caught by the deploy process itself — it would only surface when a user/staff member hits an error.
- **Severity:** Medium
- **Confidence:** Confirmed from script and source text
- **Recommended improvement:** Desk-based note: add a post-restart `curl`/health-check against `/ping` with a retry/timeout before declaring the deploy done.
- **Dependencies/risks:** None significant.
- **How to validate later:** Requires server access to confirm whether operators do this manually outside the scripted steps.

### INF-005 — Hardcoded SSH alias / IP reference in deploy tooling
- **Artifact:** `deploy/deploy-common.ps1` line 5: `$Script:SshHost = 'pressto-svr1'   # alias in ~/.ssh/config -> root@192.168.1.210, key auth`
- **Evidence:** Comment states the deploy target resolves to `root@192.168.1.210` via SSH key auth, deploying as root. This IP is a private/LAN-range address (192.168.x.x), consistent with the single-server setup claim but is a comment/reference only — not contacted by this audit.
- **Why it matters:** Deploying over SSH as `root` is a broader blast radius than a scoped deploy user would have; also, all three apps (backend, admin-panel, customer-web) and all three environments (staging/migration/production) appear to share **one** SSH target host per `Resolve-RemoteBase`, which is consistent with the "single server" claim but means there is no environment-level network isolation — a bad `migration` deploy and a `production` deploy share the same OS/user and compete for the same CPU/RAM/disk.
- **Severity:** Medium
- **Confidence:** Strong indication (comment text is reliable as a statement of intent, but this audit cannot verify the actual `~/.ssh/config` contents or confirm root is still used)
- **Recommended improvement:** Desk-based note only: a non-root deploy user with sudo scoped to the app directories/PM2 would reduce blast radius; not urgent without evidence of an actual incident.
- **Dependencies/risks:** None assessed.
- **How to validate later:** Requires access to the actual `~/.ssh/config` on the dev machine (not production) and to the production server's `/etc/passwd`/sudoers to see the real deploy account.

### INF-006 — Three environments (staging/migration/production) co-located on one server, per deploy config
- **Artifact:** `deploy/deploy-common.ps1` (`Resolve-RemoteBase`, `Resolve-Pm2Name`, per-environment ports 3030-4050)
- **Evidence:** All three environments map to different paths/ports/PM2-process-names on the **same** `$SshHost`. `ecosystem.config.js`'s own comment acknowledges this directly: "this server also runs migration (and, when active, staging) side by side" and warns against raising `instances` "without checking actual core count... risks starving them instead."
- **Why it matters:** Resource contention between environments (staging/migration load testing could degrade production) is an architectural risk the codebase's own authors have already flagged in comments — this is not speculation on this audit's part, it's documented intent/concern already in the repo.
- **Severity:** High
- **Confidence:** Confirmed (same-server co-location is stated directly in two independent files' comments)
- **Recommended improvement:** Desk-based note: separating at minimum staging/migration workloads from the production host, or firm CPU/memory limits (cgroups via PM2 or systemd) per environment, would reduce cross-environment contention risk. Not asserting this is urgent without production load data.
- **Dependencies/risks:** Cost of additional server(s) if pursued.
- **How to validate later:** Requires production server access (`nproc`, `free -m`, `pm2 list`, `top`/`htop`) to see actual concurrent load across environments — cannot be estimated from here.

### INF-007 — No containerized production deploy path despite a Dockerfile existing
- **Artifact:** `pressto_backend/Dockerfile`; `pressto_backend/package.json` (`docker:build`, `docker:run` scripts); `deploy/deploy-backend.ps1`
- **Evidence:** A working `Dockerfile` exists (`node:24-slim`, non-root `node` user, `npm install` → `npm run build`, `EXPOSE 3000`, `HOST=0.0.0.0`). But the actual deploy path (`deploy-backend.ps1`) does not use Docker at all — it builds locally, zips `dist/`, `scp`s it, and relies on PM2 directly on bare metal. The Dockerfile appears to be either a dev convenience, an abandoned direction, or used for something not evidenced locally (e.g. a different environment not covered by `deploy/`).
- **Why it matters:** Two parallel "how to run this" definitions (Dockerfile vs PM2-on-bare-metal) can drift out of sync (e.g. Dockerfile still does a plain `npm install`/`npm run build` with no `npm run migrate`/env-var handling baked in, consistent with it not being the production path). Not itself a defect, but worth flagging so nobody assumes the Dockerfile reflects how production actually runs.
- **Severity:** Low
- **Confidence:** Confirmed from the mismatch between the two artifacts
- **Recommended improvement:** None urged; desk-based note only. If containerization is wanted later, the existing Dockerfile is a reasonable starting point but would need the migration/env-var handling the PM2 path currently does by hand.
- **Dependencies/risks:** None.
- **How to validate later:** Requires asking whoever maintains the server, or server access, to confirm Docker is/isn't used anywhere in production.

### INF-008 — TLS: wildcard certificate present, paid CA, ~4.5 months remaining as of audit date, no visible auto-renewal
- **Artifact:** `ssl/fullchain.crt`, `ssl/press2india.crt`, `ssl/ca-bundle.crt`, `ssl/press2india.key` (existence/dates only — key file contents not read), `ssl/press2india_Wildcard.pfx` (existence/date only — not read)
- **Evidence:** `ls -la` shows all five files with identical modification timestamps (`Oct 13 15:30 2026`), consistent with a single cert-issuance/delivery event. Reading the **public** cert files only (not the `.key`/`.pfx`) with `openssl x509 -noout -dates`: `subject=CN = *.press2india.com`, `issuer=... DigiCert Inc ... RapidSSL TLS RSA CA G1`, `notBefore=Oct 12 00:00:00 2026 GMT`, `notAfter=Mar 24 23:59:59 2027 GMT`. Today's date (per this audit) is 2026-11-01, so the cert is currently valid with roughly 4.5 months of runway. This is a commercially-issued wildcard cert (RapidSSL/DigiCert), not a Let's Encrypt/ACME cert — there is no local evidence of `certbot`, ACME config, or any automated renewal tooling; the presence of static `.crt`/`.key`/`.pfx` files checked into a plain folder (rather than generated by a renewal script) implies manual issuance and manual renewal.
- **Why it matters:** Wildcard cert covering `*.press2india.com` implies all environments (staging/migration/production subdomains referenced in `deploy-common.ps1`, e.g. `staging-pulse-api.press2india.com`, `live-pulse-api.press2india.com`) share one cert. No auto-renewal mechanism found means this is a manual calendar-reminder risk; however, it is **not currently expired or imminently expiring** as of this audit.
- **Severity:** Low (today) / would become Critical if allowed to lapse near Mar 2027 without action
- **Confidence:** Confirmed for the expiry dates (directly read from the public cert); "no auto-renewal" is a Strong indication (absence of local evidence, not proof none exists on the server)
- **Recommended improvement:** Desk-based note: track the Mar 24 2027 expiry date and confirm who/what renews it (manual CA purchase vs. switching to ACME/Let's Encrypt with auto-renewal).
- **Dependencies/risks:** None.
- **How to validate later:** Requires server access to check Nginx's actual configured cert paths/dates and whether a renewal cron/certbot timer exists.
- **Positive note:** The `ssl/` folder sits in the top-level `D:\karans_code_lab\pressto` directory, which (confirmed via `git rev-parse --is-inside-work-tree` → "not a git repository") is **not** itself a git repo, and is a sibling of, not nested inside, the `pressto_backend`/`pressto-admin-panel`/`pressto-customer-web` git repos. So the private key is not in any app's git history — a reasonable practice, assuming the production server's actual cert storage follows the same pattern (unverifiable from here).

### INF-009 — No dedicated logging library; console.log/console.error only, no log rotation configured
- **Artifact:** `pressto_backend/src/index.ts` (lines ~14-15, ~46: `console.log`, `console.error`); `pressto_backend/src/migrate.ts` (`console.error('Cannot migrate database schema', err)`); `pressto_backend/ecosystem.config.js` (no `error_file`/`out_file`/`log_date_format` keys present); repo-wide search for `winston`, `pino`, `morgan`, `bunyan` in `pressto_backend/src` → no matches; no request-logging middleware found.
- **Evidence:** Grep across `pressto_backend/src` for `winston|pino|morgan|bunyan` returns no files. The only `logger` hit in `src/utils/config.ts` is nodemailer's SMTP debug flag (`logger: false`), unrelated to application/request logging. `ecosystem.config.js` does not declare `error_file`/`out_file` paths or `log_date_format`, meaning PM2 writes to its own default log location (`~/.pm2/logs/<app>-out.log` / `-error.log`) with no rotation policy configured in this file; no `pm2-logrotate` module reference found anywhere in the repo.
- **Why it matters:** Without structured logging (request IDs, log levels, JSON output) or rotation, production troubleshooting depends entirely on unbounded, unstructured PM2 log files, and there is no mechanism evidenced to prevent those files from growing without bound on disk.
- **Severity:** Medium
- **Confidence:** Confirmed (absence of these libraries/config is directly verifiable in the committed source)
- **Recommended improvement:** Desk-based note: adopting a structured logger (e.g. pino) and either the `pm2-logrotate` module or OS-level `logrotate` would address both concerns. Not asserting this is causing an active incident — no evidence either way without production log volume data.
- **Dependencies/risks:** None significant.
- **How to validate later:** Requires server access to check actual `~/.pm2/logs/` file sizes/age and whether `pm2-logrotate` is installed as a PM2 module (`pm2 list` would show it) independently of this repo's config.

### INF-010 — Local dev log files are empty/trivial; cannot be used as production evidence
- **Artifact:** `pressto_backend/api-dev.err` (0 bytes), `pressto_backend/api-dev.out` (261 bytes, 4 lines)
- **Evidence:** `api-dev.err` is completely empty. `api-dev.out` contains only a dotenv startup banner and `Server is running at http://127.0.0.1:3035` / `Try http://127.0.0.1:3035/ping` — i.e., a clean local dev boot, no errors, no crash history visible.
- **Why it matters:** These are local developer-machine logs from a single dev session, not production logs — they show no past errors, but that tells us nothing about production stability. Explicitly **not** usable as evidence of production reliability either way.
- **Severity:** Informational / Low
- **Confidence:** Confirmed (file contents directly read)
- **Recommended improvement:** None — just a caveat for the report.
- **Dependencies/risks:** None.
- **How to validate later:** Requires production PM2/Nginx logs from the actual server, not these dev artifacts.

### INF-011 — No monitoring, APM, error-tracking, or metrics tooling found anywhere in the three app repos
- **Artifact:** Repo-wide `grep -i "sentry|datadog|newrelic|prometheus|grafana"` against `package.json` in `pressto_backend`, `pressto-admin-panel`, `pressto-customer-web` (top-level `package.json` files specifically, to avoid false positives from transitive `node_modules` dependencies)
- **Evidence:** Zero matches in any of the three apps' own `package.json` dependency/devDependency lists.
- **Why it matters:** There is no evidenced way to be alerted to elevated error rates, latency regressions, or resource exhaustion in production short of someone noticing symptoms or manually tailing PM2 logs. This is a real gap for an app that handles payments (Razorpay) and customer data.
- **Severity:** High
- **Confidence:** Confirmed for "not present in these repos' declared dependencies"; cannot rule out an agent installed directly on the server outside the app's own dependency tree (e.g. a Datadog host agent, Nginx-level monitoring) — that would not show up in `package.json` at all.
- **Recommended improvement:** Desk-based note: adding an error-tracking SDK (e.g. Sentry) and/or basic uptime/metrics monitoring would close an observability gap that currently exists based on the evidence available. Not claiming zero monitoring exists in production — only that none is wired into the application code itself.
- **Dependencies/risks:** None significant to assess.
- **How to validate later:** Requires server access to check for any host-level monitoring agents (`systemctl list-units`, crontabs, installed packages) independent of the app's own dependencies.

### INF-012 — No Redis, no background job queue, no scheduled task runner found in backend source
- **Artifact:** `pressto_backend/package.json` dependencies list; repo-wide grep of `pressto_backend/src` for `redis|Redis`, `bull|bullmq|agenda|node-cron|node-schedule`
- **Evidence:** `package.json` dependencies are LoopBack framework packages, `axios`, `bcryptjs`, `dotenv`, `firebase-admin`, `isemail`, `jsonwebtoken`, `loopback-connector-postgresql`, `multer`, `nodemailer`, `pdfkit`, `razorpay`, `tslib`, `uuid` — no Redis client (`ioredis`/`redis`), no job-queue library. Grep for cron/scheduler libraries in `src` returned no matches (the handful of `cache`/`Cache`/`redis` string hits found were in filenames like `rider-cs.controller.ts` and variable names unrelated to an actual caching layer — manually spot-checked, not a Redis integration).
- **Why it matters:** Any caching, rate-limiting, session-sharing-across-instances, or deferred/scheduled work (e.g. sending WhatsApp/email notifications, generating PDFs, nightly reports) appears to happen synchronously inside the request/response cycle of whichever PM2 worker handled it, using in-process memory only (which is *not* shared across the 2 cluster instances). This has real implications for both correctness (any in-memory cache or dedupe logic would be inconsistent across the two instances) and scalability (slow synchronous work like PDF generation or WhatsApp API calls — both present as dependencies — would occupy a request-handling worker for its full duration).
- **Severity:** Medium (this is a legitimate architectural gap to flag, but whether it's actually causing problems depends entirely on production request volume/latency data this audit does not have)
- **Confidence:** Confirmed that these libraries are absent from the codebase; **Needs validation** for whether this is actually causing user-visible slowness or inconsistency in production
- **Recommended improvement:** Desk-based evaluation only (see "Evaluate" section below) — not a recommendation to implement without production evidence of need.
- **Dependencies/risks:** None assessed.
- **How to validate later:** Requires production request-latency/throughput metrics (which also don't exist per INF-011) to know if this is an actual bottleneck.

### INF-013 — Postgres connection pool: documented, bounded, but total capacity across environments unverified
- **Artifact:** `pressto_backend/src/datasources/pressto.datasource.ts` (lines 14-31)
- **Evidence:** In-line comments show this was a deliberate fix: previously unset pool defaulted to `max:10` with no `connectionTimeoutMillis`, causing requests to hang indefinitely once the pool was exhausted ("looking like the whole app had hung"). Now: `max: Number(process.env.PG_POOL_MAX) || 15`, `idleTimeoutMillis: 30000`, `connectionTimeoutMillis: 10000`. The same comment explicitly calls out that total connections = `PM2_INSTANCES × PG_POOL_MAX` per app instance, and that staging/migration environments on the same server add their own pools on top, all needing to fit under Postgres's `max_connections` — and flags that this has **not yet been verified** against the server's actual `max_connections` setting.
- **Why it matters:** This is a self-identified open risk in the codebase's own comments, not speculation added by this audit: with defaults, production alone would open up to 30 connections (2×15), and if staging/migration are also running (per INF-006), total connections across all environments could be considerably higher than 30 — whether that fits under Postgres's configured `max_connections` is explicitly unverified.
- **Severity:** High (self-flagged by the code's own authors as unverified)
- **Confidence:** Confirmed that this is the configured behavior and that it is explicitly documented as unverified; the actual risk of hitting a ceiling is Needs validation
- **Recommended improvement:** Desk-based note: check `SHOW max_connections;` on the actual Postgres instance against the sum of all environments' `PM2_INSTANCES × PG_POOL_MAX`, per the code comment's own instruction.
- **Dependencies/risks:** None beyond the check itself.
- **How to validate later:** Requires production Postgres access (`SHOW max_connections;`, `SELECT count(*) FROM pg_stat_activity;`) — cannot be done from this machine.

### INF-014 — `.env` category inventory (names only, no values reported)
- **Artifact:** `pressto_backend/.env` (names only extracted via `grep -oE '^[A-Z_0-9]+='`), cross-checked against `.env.example`
- **Evidence — categories present:**
  - JWT config: `JWT_SECRET`, `JWT_EXPIRES_IN`
  - Database: `PG_HOST`, `PG_PORT`, `PG_USER`, `PG_PASSWORD`, `PG_DATABASE`
  - Payment gateway: `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`
  - Email/SMTP: `EMAIL_HOST`, `EMAIL_PORT`, `EMAIL_USER`, `EMAIL_PASSWORD`, `EMAIL_FROM`
  - WhatsApp/messaging: `WHATSAPP_ENABLED`, `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_API_URL`, `WHATSAPP_ATTACHMENTS_ENABLED`, `WHATSAPP_TEMPLATE_LANGUAGE`, plus document-template URL vars, and a separate `TATA_WABA_*` set (`TATA_WABA_API_KEY`, `_API_URL`, `_SENDER_ID`, `_SOURCE_NUMBER`, `_WEBHOOK_DN_ID`) — i.e. **two** distinct WhatsApp integration paths configured
  - Mapping/geocoding: `GOOGLE_GEOCODING_API_KEY`
  - App behavior flags: `PROCESSING_ENABLED`, `QR_SCAN_REQUIRED`, `REPROCESS_WINDOW_DAYS`, `ORDER_SUMMARY_LINK_TTL_SECONDS`, `ORDER_SUMMARY_URL_SIGNING_SECRET`, `PUBLIC_DOCUMENT_BASE_URL`, `API_ENDPOINT`, `HOST`, `PORT`
  - **Absent:** no `REDIS_URL`/`REDIS_HOST`, no `PM2_INSTANCES` override (confirms the `|| 2` default in `ecosystem.config.js` is what's active unless set another way outside this file), no `PG_POOL_MAX` override (confirms `|| 15` default is active), no `SENTRY_DSN` or any monitoring DSN.
  - `.env` is correctly excluded via `.gitignore` (line "`.env`" plus a comment referencing `FIREBASE_SERVICE_ACCOUNT_PATH` in `.env.example`) — secrets are not committed to this repo's git history.
- **Why it matters:** Confirms which third-party dependencies are live integration points (payment, two messaging channels, geocoding, email) each representing an external-outage/rate-limit dependency the app relies on with no evidenced circuit-breaker/retry/queueing layer (consistent with INF-012's "no job queue" finding — e.g. a WhatsApp/email send failure during a request would need to be handled synchronously or risk being silently dropped, though this audit did not trace the actual retry logic in `notification.service.ts`/`system-notification.service.ts` in depth).
- **Severity:** Informational (categories only) / the "no queue for these calls" implication is Medium, overlapping INF-012
- **Confidence:** Confirmed for category presence/absence; the retry-logic implication is Needs validation (would require reading service code in depth, which overlaps with another agent's functional-correctness scope)
- **Recommended improvement:** None from this audit beyond what's in INF-012.
- **Dependencies/risks:** None.
- **How to validate later:** N/A for category inventory itself; retry behavior would need code-level review (likely another agent's scope) plus production error-rate data.

### INF-015 — Backups are manual, ad hoc one-off scripts/dumps, not an automated/tested recurring process
- **Artifact:** `pressto/backups/README.md`, `pressto/backups/*.dump`, `pressto/data-backup/*.sql`/`*.dump`, `pressto/pressto_pre_seed_20260916_121026.dump(.gz)`, `pressto/restore-log.txt`; absence of `../src/29-backups.js` referenced by the README (not found anywhere in this checkout)
- **Evidence:** `backups/README.md` documents a **manual, one-time** export process ("Backups of `pressto_migration` — 14 October 2026... Re-run it (with `--force`) for a fresh pair") produced by a script (`../src/29-backups.js`) that does not exist anywhere in this repo checkout — it was evidently run from a different, uncommitted location/branch and only its *output* was placed here. `data-backup/` contains four more dumps from different, irregular dates (Jul 16, Sep 5, Sep 30, undated `dump.sql`) with no visible naming/retention convention or automation (no cron entry, no scheduled task, no `pg_dump` wrapper script found in `pressto_backend/scripts/` — that folder's `.cjs` files are all one-off data migrations, not backup jobs). There is one documented restore test (`restore-log.txt`, and the README's "Verified: restored... counted before delivery" section) — a real positive — but it covers one specific delivery, not a repeating/tested backup regimen.
- **Why it matters:** No evidence of a scheduled, automatic, retained, and *regularly* restore-tested backup process for the production database. The one documented restore-verification is good practice but was a one-off for a migration handover, not a standing operational backup/DR procedure.
- **Severity:** High
- **Confidence:** Confirmed that no automated backup script/cron exists in any of the repos checked; **Needs validation** on whether the production server has its own cron-based `pg_dump` (e.g. via a system crontab) that simply isn't reflected in any of these repos.
- **Recommended improvement:** Desk-based note: a scheduled, automated, off-server-retained backup job with periodic restore testing would close this gap if one doesn't already exist server-side.
- **Dependencies/risks:** Storage/retention policy would need deciding; customer PII (383k+ customer rows per the README) must be handled per whatever data-retention/compliance rules apply — noted, not assessed here.
- **How to validate later:** Requires production server access (`crontab -l`, `/etc/cron.d/`, systemd timers) to confirm or rule out a backup job this audit cannot see.

### INF-016 — Node engine version: flexible in `package.json`, pinned in Dockerfile, mismatched from local dev
- **Artifact:** `pressto_backend/package.json` (`"engines": {"node": "20 || 22 || 24"}`); `pressto_backend/Dockerfile` (`FROM node:24-slim`); local dev machine (`node -v` → v22.16.0)
- **Evidence:** The `engines` field accepts any of Node 20/22/24 — it does not pin an exact version, so whatever Node happens to be installed on the production server (unknown/unverifiable from here) determines actual runtime behavior, while the (seemingly unused-in-prod, per INF-007) Dockerfile targets Node 24 specifically, and this dev machine runs Node 22.
- **Why it matters:** A loose engines range plus no `.nvmrc`/version-lock file visible in `pressto_backend` means there's no committed guarantee that production, dev, and the Dockerfile all run the same Node version — a source of "works on my machine" risk, though no concrete failure was observed.
- **Severity:** Low
- **Confidence:** Confirmed for what's committed; the actual production Node version is Needs validation.
- **Recommended improvement:** Desk-based note: pinning an exact Node version (e.g. via `.nvmrc` or a tighter `engines` field) would remove this ambiguity.
- **Dependencies/risks:** None significant.
- **How to validate later:** Requires production server access (`node -v`).

---

## Evaluation of potential improvements (desk-based, not implementation recommendations)

| Improvement | Local evidence of need? | Assessment |
|---|---|---|
| **Redis caching** | No caching layer found at all (INF-012); no evidence of slow repeated reads specifically needing a cache. | **Speculative without production metrics.** Could help if hot read paths (dashboards, pincode lookups) are shown to be slow/repeated under real load, but no latency data exists here to confirm that. |
| **Dedicated background workers / job queue** | No queue library found; synchronous WhatsApp/email/PDF generation calls exist in request path (INF-012, INF-014). | **Strong indication of an architectural gap**, closer to "needs it" than purely speculative — the combination of known-slow operations (PDF generation, third-party API calls) with zero queueing infrastructure is a real pattern risk, though actual user-visible impact (request timeouts, etc.) is Needs validation against production latency logs this audit lacks. |
| **Separating Postgres from app services (own DB server)** | Single-server co-location explicitly acknowledged in code comments (INF-006); no CPU/memory contention measurement possible from here. | **Partially evidenced, mostly speculative.** The repo's own authors already flag contention risk in comments, which is stronger than pure speculation, but whether it's an *active* problem requires production CPU/RAM measurements this audit cannot take. |
| **Read replicas** | No replication config found anywhere; single `PresstoDataSource` with one connection string (INF-013). No evidence of read-heavy reporting load vs. write load split. | **Speculative without production metrics.** No local evidence either confirms or rules out a need; would require query-pattern/load analysis on the live DB. |
| **Centralized logging** | No logging library, no rotation config, PM2 default logs only (INF-009). | **Needs it, based on what's missing** — this is one of the more concrete gaps: there is currently no way to search/aggregate logs across the 2 cluster instances short of manually reading PM2's flat files. |
| **Metrics/dashboards/alerting** | Zero APM/monitoring packages found in any of the three repos (INF-011). | **Needs it, based on what's missing** — same caveat as above: a host-level agent could exist outside these repos and this audit would not see it; but nothing in the application layer provides self-instrumentation. |
| **Automated, tested backups** | Only manual, irregular dumps found; no cron/automation evidenced; one past one-off restore test documented (INF-015). | **Needs it, based on what's missing**, with the caveat that an un-evidenced server-side cron job could already exist. |
| **Horizontal scaling / load balancing** | PM2 cluster mode already provides multi-core scaling *within* one server (INF-001); no evidence of multi-server load balancing, and the stated server spec is a single box. | **Speculative beyond the single-server ceiling.** Within-server scaling (more PM2 instances, tuned against actual core count) is a nearer-term lever than multi-server load balancing, which would require infrastructure this audit has no evidence is planned or needed yet. |

---

## Explicitly out of scope / cannot be assessed from this machine

The following **cannot** be measured, estimated, or fabricated from local files and **require
direct production server access** (SSH, monitoring tools, or DB access) to actually assess:

1. Actual CPU, RAM, disk, and network utilization on the production server (no measurement taken; the "8 vCPU/16GB" spec is an unverified claim).
2. Nginx configuration itself (worker processes, `worker_connections`, proxy timeouts, buffer sizes, gzip, actual TLS termination setup) — no `nginx.conf` or site config was found anywhere in these local repos; its existence/content is entirely unverified.
3. Actual PostgreSQL configuration (`max_connections`, `shared_buffers`, `work_mem`, autovacuum settings) and real-time resource contention between Postgres and the Node backend on the same box.
4. Actual Node.js version, actual number of running PM2 instances, actual PM2 process uptime/restart history, and actual contents of `~/.pm2/logs/*` on the server.
5. Whether `pm2 reload` vs `pm2 restart` is what operators actually run (vs. what the script prints).
6. Whether any backup cron/systemd timer exists on the server independent of the ad hoc dumps found locally.
7. Whether any host-level monitoring/APM agent (outside the application's own `package.json` dependencies) is installed and active.
8. Real request latency/throughput/error-rate data for any endpoint — needed to validate or refute the Redis/queue/read-replica speculative items above.
9. Actual TLS certificate deployment on the server (this audit only confirmed the *local copies'* dates/subject/issuer — not that these are the files actually loaded by the production Nginx, nor their file permissions on that server).
10. Whether the Dockerfile is used anywhere in any real environment, or is unused/vestigial.

---

*End of findings. All conclusions above are based solely on static files present in
`D:\karans_code_lab\pressto` as of 2026-11-01; no remote connections were made, no `.key`/`.pfx`
file contents were read, and `db-tunnel-instructions.txt` was not used, per audit instructions.*
