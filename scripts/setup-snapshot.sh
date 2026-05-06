#!/usr/bin/env bash
#
# One-time bootstrap for the hourly /news snapshot pipeline.
#
# What this does:
#   1. Creates /var/www/read-api/snapshots/ owned by the deploy user.
#   2. Writes nginx snippet at /etc/nginx/snippets/reddzit-snapshots.conf.
#   3. Tells you the one line to add to your reddzit.com server block.
#   4. Validates nginx config and reloads if the include is already present.
#   5. Seeds the cron-jobs table and generates the first snapshot.
#
# Run on the droplet (the one that hosts read-api + nginx) ONCE:
#   bash scripts/setup-snapshot.sh
#
# After the include line is added to your server block, the pipeline is fully
# automated: every backend deploy refreshes the snapshot, and PM2 + the existing
# CronSync take care of the hourly run.

set -euo pipefail

SNAPSHOT_DIR="${SNAPSHOT_DIR:-/var/www/read-api/snapshots}"
NGINX_SNIPPET_PATH="${NGINX_SNIPPET_PATH:-/etc/nginx/snippets/reddzit-snapshots.conf}"
NGINX_SITE_GLOB="${NGINX_SITE_GLOB:-/etc/nginx/sites-enabled/*}"
INCLUDE_LINE="    include snippets/reddzit-snapshots.conf;"

log()  { printf "\033[1;34m[setup-snapshot]\033[0m %s\n" "$*"; }
warn() { printf "\033[1;33m[setup-snapshot]\033[0m %s\n" "$*" >&2; }
err()  { printf "\033[1;31m[setup-snapshot]\033[0m %s\n" "$*" >&2; }

if ! command -v sudo >/dev/null 2>&1; then
  err "sudo is required."
  exit 1
fi

# 1. Snapshot directory
log "Ensuring snapshot directory exists: $SNAPSHOT_DIR"
sudo mkdir -p "$SNAPSHOT_DIR"
sudo chown "$USER:$USER" "$SNAPSHOT_DIR"

# 2. nginx snippet
log "Writing nginx snippet: $NGINX_SNIPPET_PATH"
sudo mkdir -p "$(dirname "$NGINX_SNIPPET_PATH")"
sudo tee "$NGINX_SNIPPET_PATH" >/dev/null <<EOF
# Hourly homepage news snapshot — see read-api/jobs/generateNewsSnapshot.js
location /snapshots/ {
    alias $SNAPSHOT_DIR/;
    add_header Cache-Control "public, max-age=3600, stale-while-revalidate=600" always;
    add_header Access-Control-Allow-Origin "*" always;
    try_files \$uri =404;
}
EOF

# 3. Check if any enabled site already includes the snippet
INCLUDE_PRESENT="no"
if sudo grep -RqsF "snippets/reddzit-snapshots.conf" $NGINX_SITE_GLOB 2>/dev/null; then
  INCLUDE_PRESENT="yes"
fi

if [ "$INCLUDE_PRESENT" = "no" ]; then
  warn "Snippet written, but no enabled nginx site references it yet."
  warn "Add this line inside your reddzit.com server block (e.g. /etc/nginx/sites-available/reddzit), then run 'sudo nginx -t && sudo systemctl reload nginx':"
  warn ""
  warn "$INCLUDE_LINE"
  warn ""
else
  log "Include directive detected in an enabled site. Validating nginx config..."
  if sudo nginx -t; then
    sudo systemctl reload nginx
    log "nginx reloaded."
  else
    err "nginx config test failed — leaving running config untouched."
    exit 1
  fi
fi

# 4. Seed cron jobs (idempotent — skips existing entries)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
READ_API_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$READ_API_DIR"

if [ -f .env ]; then
  set -a
  . ./.env
  set +a
fi

log "Seeding cron jobs (idempotent)..."
node prisma/seed-cron-jobs.js

# 5. Generate first snapshot
log "Generating initial news snapshot..."
SNAPSHOT_DIR="$SNAPSHOT_DIR" node jobs/generateNewsSnapshot.js

log "Done. The hourly cron will keep $SNAPSHOT_DIR/news.json fresh from here on."
