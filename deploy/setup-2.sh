#!/usr/bin/env bash
# Bootstrap an Oracle Cloud (or Ubuntu-style) VM for Market Pulse AI.
# This script handles native NodeSource setup, Corepack injection,
# and prepares dependencies for PM2 and Cron runtimes.
#
# Execution:
#   chmod +x deploy/setup.sh
#   ./deploy/setup.sh
#

set -euo pipefail

MP_INSTALL_DIR="${MP_INSTALL_DIR:-$HOME/market-pulse-ai}"
NODE_MAJOR=22
PNPM_VERSION="10.33.2"

info() { printf '\n\033[1;36m==>\033[0m %s\n' "$*"; }
error_exit() { printf '\n\033[1;31mERROR:\033[0m %s\n' "$*" >&2; exit 1; }

need_cmd() {
  command -v "$1" >/dev/null 2>&1
}

# 1. Enforce System Architecture Prerequisites
info "Updating system package repositories..."
if need_cmd apt-get; then
  sudo apt-get update -y
  sudo apt-get install -y curl ca-certificates git build-essential python3
else
  error_exit "This optimized automated script strictly requires an APT (Ubuntu/Debian) base ecosystem."
fi

# 2. Completely Purge Legacy Framework Overlaps
info "Clearing out older Node.js remnants to avoid version conflicts..."
sudo apt-get purge -y nodejs npm node || true
sudo apt-get autoremove -y

# 3. Provision Official NodeSource Node.js 22 LTS Pipeline
info "Configuring NodeSource signature keys for Node.js v${NODE_MAJOR}.x..."
curl -fsSL "nodesource.com{NODE_MAJOR}.x" | sudo -E bash -

info "Installing compiled Node.js engine distribution binary..."
sudo apt-get clean
sudo apt-get update -y
sudo apt-get install -y nodejs

# Verify the base installation status metrics
info "Verifying core runtime binary metrics:"
node -v || error_exit "Node.js execution footprint could not be established."
npm -v || error_exit "NPM utility attachment missing from host distribution."

# 4. Initialize Corepack Architecture and Inject Runtime Path Bindings
info "Activating Corepack system configuration mappings..."
sudo corepack enable
sudo corepack prepare "pnpm@${PNPM_VERSION}" --activate

# Append execution path bindings directly to ensure shell inheritance persistence
info "Registering structural command paths inside shell environments..."
GLOBAL_PREFIX=$(npm config get prefix)
if ! grep -q "$GLOBAL_PREFIX/bin" "$HOME/.bashrc"; then
  echo "export PATH=\"\$PATH:$GLOBAL_PREFIX/bin\"" >> "$HOME/.bashrc"
fi
export PATH="$PATH:$GLOBAL_PREFIX/bin"

# 5. Global Deployment Setup for PM2 Service Monitoring Engine
info "Deploying PM2 Process Manager globally..."
sudo npm install -g pm2

# 6. Repository Build Execution Pipeline Sequence
if [ ! -d "$MP_INSTALL_DIR/.git" ]; then
  info "Target destination framework path ($MP_INSTALL_DIR) is not a git workspace."
  info "Please complete steps manually from here: clone your repo, configure .env, and run 'pnpm install'."
else
  info "Valid repository layout profile detected at path target: $MP_INSTALL_DIR"
  (
    cd "$MP_INSTALL_DIR"
    info "Preparing localized data structures and log directory frames..."
    mkdir -p deploy/logs data briefings secrets

    info "Running local module dependency installation tracking..."
    pnpm install

    info "Executing codebase compilation routines..."
    pnpm run build
  )
fi

# 7. Print Post-Installation Deployment Instructions
info "=========================================================================="
info " 🎉 MARKET PULSE AI SETUP PROCESS COMPLETED SUCCESSFULLY!"
info "=========================================================================="
echo "Next implementation workflows to run from workspace directory ($MP_INSTALL_DIR):"
echo "  1. Verify configuration secrets pipeline : pnpm cli doctor"
echo "  2. Boot environment background instance  : pm2 start deploy/ecosystem.config.cjs"
echo "  3. Freeze current thread orchestration   : pm2 save"
echo "  4. Set auto-reboot boot script rules     : pm2 startup (Then execute the printed command with sudo)"
echo ""
echo "Suggested Crontab (IST) — install using 'crontab -e':"
echo "  30 8 * * 1-5 cd $MP_INSTALL_DIR && /usr/bin/env NODE_ENV=production MP_DOTENV_PATH=$MP_INSTALL_DIR/.env pnpm exec tsx deploy/healthcheck.ts >> $MP_INSTALL_DIR/deploy/logs/health-cron.log 2>&1"
info "=========================================================================="