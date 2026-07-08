#!/usr/bin/env bash
# Bootstrap an Oracle Cloud (or Ubuntu-style) VM for Market Pulse AI.
# Run as a user that will own the app (not necessarily root). Installs Node 22,
# pnpm, PM2, prepares log dirs, prints suggested crontab lines.
#
#   chmod +x deploy/setup.sh
#   ./deploy/setup.sh
#
# Optional env:
#   MP_INSTALL_DIR=/opt/market-pulse-ai   # clone target (default: ~/market-pulse-ai)

set -euo pipefail

MP_INSTALL_DIR="${MP_INSTALL_DIR:-$HOME/market-pulse-ai}"
NODE_MAJOR=22

info() { printf '\n\033[1;36m==>\033[0m %s\n' "$*"; }

need_cmd() {
  command -v "$1" >/dev/null 2>&1
}

install_apt() {
  info "Installing prerequisites (apt)"
  sudo apt-get update -y
  sudo apt-get install -y curl ca-certificates git build-essential python3 python3-pip \
    libatk1.0-0t64 libatk-bridge2.0-0t64 libcups2t64 libdrm2 libxkbcommon0 \
  libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 libasound2t64 libpango-1.0-0 \
  libcairo2 libnss3 libnspr4
}

install_dnf() {
  info "Installing prerequisites (dnf/yum)"
  if need_cmd dnf; then
    sudo dnf install -y curl ca-certificates git gcc gcc-c++ make python3
  else
    sudo yum install -y curl ca-certificates git gcc gcc-c++ make python3
  fi
}

if need_cmd apt-get; then
  install_apt
elif need_cmd dnf || need_cmd yum; then
  install_dnf
else
  echo "Unsupported package manager — install curl, git, build tools manually." >&2
  exit 1
fi

if ! need_cmd nvm; then
  info "Installing nvm"
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
  # shellcheck source=/dev/null
  [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
fi

# shellcheck source=/dev/null
[ -s "$HOME/.nvm/nvm.sh" ] && . "$HOME/.nvm/nvm.sh"

info "Installing Node ${NODE_MAJOR} via nvm"
nvm install "${NODE_MAJOR}"
nvm alias default "${NODE_MAJOR}"

info "Enabling pnpm via corepack"
corepack enable
corepack prepare pnpm@10.33.2 --activate

info "Installing PM2 globally"
npm install -g pm2

if [ ! -d "$MP_INSTALL_DIR/.git" ]; then
  info "Directory $MP_INSTALL_DIR is not a git clone — create it and clone your repo, e.g."
  echo "  git clone <your-remote> $MP_INSTALL_DIR"
  echo "Then re-run this script, or continue manually from 'cd $MP_INSTALL_DIR'."
else
  info "Repo present at $MP_INSTALL_DIR"
  (
    cd "$MP_INSTALL_DIR"
    mkdir -p deploy/logs data briefings secrets
    pnpm install
    PLAYWRIGHT_BROWSERS_PATH=0 pnpm exec playwright install chromium
    if need_cmd sudo; then
      sudo env PLAYWRIGHT_BROWSERS_PATH=0 pnpm exec playwright install-deps chromium || true
    fi
    # Install Python dependencies in a project-local venv (concall-fetcher.ts
    # resolves .venv/bin/python3 first, falls back to system python3).
    if need_cmd python3; then
      python3 -m venv .venv
      .venv/bin/pip install --quiet -r scripts/requirements-concall.txt
      .venv/bin/python3 -c "from bse import BSE; print('bse import OK')" || \
        echo "WARNING: bse smoke test failed" >&2
    else
      echo "python3 not found — concall fetching will be unavailable" >&2
    fi
    pnpm run build
  )
fi

info "PM2 (run from repo root after .env + build)"
echo "  cd $MP_INSTALL_DIR"
echo "  pm2 start deploy/ecosystem.config.cjs"
echo "  pm2 save"
echo "  pm2 startup   # follow the printed command with sudo"

info "Suggested crontab (IST) — install with: crontab -e"
echo "  # Health probe ~1h after weekday morning briefing"
echo "  30 8 * * 1-5 cd $MP_INSTALL_DIR && /usr/bin/env NODE_ENV=production \\"
echo "    MP_DOTENV_PATH=$MP_INSTALL_DIR/.env \\"
echo "    pnpm exec tsx deploy/healthcheck.ts >> $MP_INSTALL_DIR/deploy/logs/health-cron.log 2>&1"
echo ""
echo "  # Optional: remind to refresh Kite token (interactive — run from laptop or SSH with X)"
echo "  # 0 6 * * 1-5 echo 'Kite token may need refresh' | logger -t market-pulse"

info "Done. Next: copy .env (see deploy/sync-env-to-vm.example.sh), sync DB if needed (deploy/sync-db-to-vm.example.sh), pm2 start."
