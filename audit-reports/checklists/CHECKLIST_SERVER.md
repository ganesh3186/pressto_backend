# Server Checklist

**Server:** `pressto-svr1`. **Source:** `SERVER_INCIDENT_AUDIT.md`, `infra-audit.md`.
**Priorities:** P0 = do first, before the next go-live. P1 = high impact. P2 = medium. P3 = low.
**Downtime:** `none`, `reload` (no outage), `restart` (brief outage, schedule off-hours).

## P0

- [ ] **Back up the live database.** Point the nightly job at `pressto_production`; it currently dumps `pressto_prod`. **Status: on hold until the server move, by decision. Set up on the new server, and take one manual dump before moving.** `INF-S-12` | none
- [ ] **Copy backups off this server.** They are all on the same disk today. **Status: on hold until the server move. Needs an off-server destination.** `INF-S-12` | none
- [ ] **Run a real restore test** and record how long it takes. **Status: on hold until the server move.** `INF-S-12` | none
- [ ] **Alert when a backup fails or is unusually small.** A 0-byte dump exists from Nov 1. **Status: on hold until the server move.** `INF-S-12` | none
- [ ] **Install host and Postgres monitoring** with history (CPU, RAM, disk, connections). `INF-S-09` | none
- [ ] **Add timestamps to PM2 logs** (`log_date_format`). Their absence blocked the incident timeline. `INF-S-09` | reload
- [ ] **Run a load rehearsal with about 100 staff's usage pattern,** off-hours, because all environments share this VM. `INF-S-08`, report section 18 | none

## P1

- [ ] **Check the router/NAT rules** to see which ports are reachable from the internet. `INF-S-14` | none
- [ ] **Turn on the firewall** and restrict ports 3032, 3033, 3035, 4030, 4041, 4050 and 5432. `INF-S-14` | none
- [ ] **Route all staff traffic through nginx** so it gets TLS and access logs. `INF-S-14` | none
- [ ] **Stop the migration environment during staff hours** and go-live. `INF-S-03`, `INF-006` | none for production
- [ ] **Move migration to its own server or Postgres instance** when possible. `INF-S-03` | none for production
- [ ] **Script the deploy:** `npm ci --omit=dev`, copy migration scripts, migrate, then start. `INF-S-06`, `INF-002` | none
- [ ] **Keep the previous build** so a rollback is one command. `INF-003` | none
- [ ] **Add a post-deploy health check** against `/ping`. `INF-004` | none
- [ ] **Decide worker count and pool size** from the rehearsal; budget against 100 connections. `INF-S-08`, `INF-013` | reload
- [ ] **Update `workaround.md`.** It says fork mode, but production has run cluster mode since Nov 1 05:43. | none

## P2

- [ ] **Use `pm2 reload` instead of `restart`** in deploy steps; test on migration first. `INF-S-07`, `INF-001` | none
- [ ] **Run `chmod 600` on DB dumps.** They are currently readable by every local user. `INF-S-15` | none
- [ ] **Remove old dumps and `pressto_migration_old`,** after the owner confirms. `INF-S-15` | none
- [ ] **Set up log rotation and structured logging.** `INF-009` | reload
- [ ] **Set up TLS renewal reminders.** About 4.5 months left on the wildcard certificate, no auto-renewal seen. `INF-008` | reload
- [ ] **Check VM clock sync.** The journal shows time jumping backwards. `INF-S-16` | none

## P3

- [ ] **Fix the backup script's `find` working-directory error** and check its exit code. **Status: on hold until the server move. On the new server, run the script from a folder postgres can read.** `INF-S-10` | none
- [ ] **Identify the client hitting the `migration_readonly` limit of 5.** `INF-S-04` | none
- [ ] **Fix the nginx conflicting server name warning.** `INF-S-17` | reload
- [ ] **Review the Postgres open-files limit** if connections grow. `INF-S-11` | restart
- [ ] **Remove the hardcoded SSH alias/IP from deploy tooling.** `INF-005` | none
- [ ] **Decide on the unused Docker deploy path.** `INF-007` | none
- [ ] **Pin the Node version across dev, Docker and server.** `INF-016` | restart

Postgres tuning is in `CHECKLIST_DATABASE.md`.
