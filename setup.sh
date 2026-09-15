#!/usr/bin/env bash
# First-time backend setup on this server. Run from inside this folder:
#   ./setup.sh
#
# What this does:
#   1. Checks Node/npm and PM2 (installs PM2 if missing)
#   2. Sanity-checks .env is present
#   3. Installs production dependencies
#   4. Optionally runs the database migration + base seed (first-time only)
#   5. Starts the backend under PM2 and saves the process list for reboots

set -euo pipefail
cd "$(dirname "$0")"

echo "== 1/5 Checking Node & npm =="
if ! command -v node >/dev/null 2>&1; then
  echo "ERROR: Node.js is not installed on this server."
  echo "Install Node 20/22/24 first, then re-run this script."
  exit 1
fi
node -v
npm -v

echo ""
echo "== 2/5 Checking PM2 =="
if ! command -v pm2 >/dev/null 2>&1; then
  echo "PM2 not found — installing globally..."
  npm install -g pm2
fi
pm2 -v

echo ""
echo "== 3/5 .env sanity check =="
if [ ! -f ".env" ]; then
  echo "ERROR: .env is missing. Copy .env.example to .env and fill in this"
  echo "server's real DB/JWT/email values first — do not reuse dev secrets."
  exit 1
fi
if grep -qE '^HOST=127\.0\.0\.1' .env; then
  echo "NOTE: .env pins HOST=127.0.0.1, overriding this branch's 0.0.0.0"
  echo "default — the backend will only be reachable from this machine."
  echo "Remove that line (or set it to 0.0.0.0) if other devices need it."
fi

echo ""
echo "== 4/5 Installing production dependencies =="
npm ci --omit=dev

echo ""
echo "== 5/5 Database setup (first time only) =="
# NOT `npm run migrate`/`npm run seed` — both have a `pre*` hook that reruns
# `npm run build` (lb-tsc, which needs src/), same reason `npm start` is
# avoided above. dist/ is already built and current; call the compiled
# files directly to skip that hook entirely.
read -r -p "Run migrate + seed against this server's DB now? [y/N] " REPLY
if [[ "$REPLY" =~ ^[Yy]$ ]]; then
  node dist/migrate.js
  node dist/seed.js
else
  echo "Skipped. Run later with: node dist/migrate.js && node dist/seed.js"
fi

echo ""
echo "== Starting under PM2 =="
pm2 start ecosystem.config.js
pm2 save

echo ""
echo "Done. 'pm2 status' to check, 'pm2 logs pressto-backend' to tail logs."
echo "To auto-start on reboot (needs sudo, prints a command you copy/run"
echo "yourself — normal PM2 behavior): pm2 startup"
