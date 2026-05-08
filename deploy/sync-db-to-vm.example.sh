#!/usr/bin/env bash
# Push your local SQLite DB to the VM (briefings, regime, paper trades, etc.).
# Safe workflow: stop the app so the DB is not mid-write, copy, restart.
#
# 1) Copy to sync-db-to-vm.sh, set SSH_USER, VM_HOST, paths.
# 2) From laptop (repo root), after `pnpm cli doctor` confirms DATABASE_PATH:
#      ./sync-db-to-vm.sh
#
# SQLite tip: copying a WAL-mode DB should include -wal/-shm if present, or
# checkpoint first: `sqlite3 data/market-pulse.db "PRAGMA wal_checkpoint(TRUNCATE);"`

set -euo pipefail

SSH_USER="ubuntu"
VM_HOST="your.vm.public.ip"
REMOTE_DIR="${REMOTE_DIR:-/opt/market-pulse-ai}"
LOCAL_DB="${LOCAL_DB:-./data/market-pulse.db}"
REMOTE_DB="${REMOTE_DB:-${REMOTE_DIR}/data/market-pulse.db}"

if [ ! -f "$LOCAL_DB" ]; then
  echo "Local DB not found: $LOCAL_DB" >&2
  exit 1
fi

read -r -p "Stop PM2 on the VM before copy? [y/N] " ans
if [[ "$ans" =~ ^[yY]$ ]]; then
  ssh "${SSH_USER}@${VM_HOST}" "cd '${REMOTE_DIR}' && pm2 stop market-pulse || true"
fi

rsync -avz --progress \
  "$LOCAL_DB" \
  "${SSH_USER}@${VM_HOST}:${REMOTE_DB}"

for ext in wal shm; do
  side="${LOCAL_DB}-${ext}"
  if [ -f "$side" ]; then
    rsync -avz --progress "$side" "${SSH_USER}@${VM_HOST}:${REMOTE_DB}-${ext}"
  fi
done

if [[ "$ans" =~ ^[yY]$ ]]; then
  ssh "${SSH_USER}@${VM_HOST}" "cd '${REMOTE_DIR}' && pm2 start market-pulse || pm2 start deploy/ecosystem.config.cjs"
fi

echo "DB sync complete → ${REMOTE_DB}"
