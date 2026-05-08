#!/usr/bin/env bash
# Copy your local `.env` to the VM in one shot (never commit `.env`).
# 1) Copy this file to `sync-env-to-vm.sh`, fill in SSH_USER and VM_HOST, chmod +x.
# 2) Run from your laptop repo root:
#      ./sync-env-to-vm.sh
#
# Alternatives:
#   scp .env ${SSH_USER}@${VM_HOST}:/opt/market-pulse-ai/.env
#   rsync -avz .env ${SSH_USER}@${VM_HOST}:/opt/market-pulse-ai/.env
#
# After copy on the server:
#   chmod 600 /opt/market-pulse-ai/.env

set -euo pipefail

SSH_USER="ubuntu"
VM_HOST="your.vm.public.ip"
REMOTE_DIR="${REMOTE_DIR:-/opt/market-pulse-ai}"

if [ ! -f .env ]; then
  echo "No .env in current directory — run from repo root." >&2
  exit 1
fi

scp .env "${SSH_USER}@${VM_HOST}:${REMOTE_DIR}/.env"
ssh "${SSH_USER}@${VM_HOST}" "chmod 600 '${REMOTE_DIR}/.env'"

echo "Uploaded .env to ${SSH_USER}@${VM_HOST}:${REMOTE_DIR}/.env"
