#!/usr/bin/env bash
# ClipKosh — all-in-one VPS setup script (Ubuntu/Debian sandbox).
# Idempotent: safe to run twice. Run as root from the server/ directory:
#   sudo bash vps-setup.sh
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVER_DIR="$APP_DIR/server"
echo "==> Project at: $APP_DIR"

echo "==> Updating package lists"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq

# Show what distro we are on (helps diagnose missing-package errors).
echo "==> Distro: $(. /etc/os-release && echo "$ID $VERSION_ID")"

echo "==> Installing core system packages (ffmpeg, git, curl, python, build tools)"
apt-get install -y -qq \
  ffmpeg git curl ca-certificates \
  python3 python3-pip python3-venv \
  build-essential pkg-config \
  >/dev/null

# Chrome shared-library deps are best-effort: package names differ across
# distros (e.g. libasound2 vs libasound2t64) and some are missing in minimal
# sandboxes. If a few are absent, we still want the rest of the setup to run.
echo "==> Installing browser libraries (best-effort)"
apt-get install -y -qq \
  libnss3 libatk-bridge2.0-0 libx11-xcb1 libxcomposite1 libxcursor1 \
  libxdamage1 libxrandr2 libgbm1 libasound2 libasound2t64 \
  libpangocairo-1.0-0 libgtk-3-0 \
  >/dev/null || echo "NOTE: some browser libs unavailable; will attempt Chrome anyway"

# --- Node.js 22 (LTS) if not present or too old ---------------------------
echo "==> Ensuring Node.js >= 22"
if ! command -v node >/dev/null || [ "$(node -v | cut -d. -f1 | tr -d v)" -lt 22 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null 2>&1
  apt-get install -y -qq nodejs >/dev/null
fi
node -v && npm -v

# --- Python virtualenv for yt-dlp + anti-bot plugins -----------------------
# Ubuntu/Debian 24.04+ block system-wide pip (PEP 668), so we use an isolated
# venv. The server must point YTDLP_PATH at this venv's binary.
echo "==> Creating Python virtualenv for yt-dlp"
VENV="$HOME/.clipkosh-venv"
if [ ! -x "$VENV/bin/python" ]; then
  python3 -m venv "$VENV"
fi
"$VENV/bin/pip" install -q --upgrade pip

echo "==> Installing yt-dlp + PO-token provider + EJS + curl_cffi"
"$VENV/bin/pip" install -q \
  yt-dlp \
  "bgutil-ytdlp-pot-provider==2.0.2" \
  yt-dlp-ejs \
  curl_cffi

echo "yt-dlp at: $VENV/bin/yt-dlp"
"$VENV/bin/yt-dlp" --version

# Build the bgutil PO-token provider (generation script) if not already built.
POT_DIR="$HOME/bgutil-ytdlp-pot-provider"
if [ ! -d "$POT_DIR/server/build" ]; then
  echo "==> Cloning + building bgutil PO-token provider"
  git clone --depth 1 --single-branch --branch 2.0.2 \
    https://github.com/Brainicism/bgutil-ytdlp-pot-provider.git "$POT_DIR" \
    >/dev/null 2>&1
  ( cd "$POT_DIR/server" && npm ci >/dev/null 2>&1 && npx tsc >/dev/null 2>&1 )
fi
echo "POT provider home: $POT_DIR/server"

# --- App dependencies -------------------------------------------------------
echo "==> npm install (app)"
cd "$SERVER_DIR"
npm install

# --- Puppeteer Chrome (for Instagram/Facebook) ------------------------------
echo "==> Installing Puppeteer Chrome"
CACHE_DIR="$APP_DIR/.cache/puppeteer"
mkdir -p "$CACHE_DIR"
export PUPPETEER_CACHE_DIR="$CACHE_DIR"
npx puppeteer browsers install chrome

echo ""
echo "==========================================================="
echo " SETUP COMPLETE ✅"
echo " Now start the server with:"
echo "   cd $SERVER_DIR && bash vps-run.sh"
echo "==========================================================="
